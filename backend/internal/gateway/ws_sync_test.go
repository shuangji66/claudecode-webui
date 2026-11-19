package gateway

import (
	"bufio"
	"encoding/json"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"ccweb/backend/internal/agent/session"
)

// fakeCLI 是一条「会握手、之后照常吐事件」的假 claude：测试写进去的每一行都会被
// 会话的读循环当成 CLI 输出处理，从而真的产生带序号的事件。
//
// 不用 hangTransport：那里的断言依赖会话把这些行读进 handleLine 并 emitData，
// 手工往重放缓冲里塞事件就测不到「序号是怎么产生的」。
type fakeCLI struct {
	sess *session.Session
	out  *os.File // 测试写进去的「CLI 输出」
}

// startFakeCLI 拉起一条已完成 initialize 握手的会话。
func startFakeCLI(t *testing.T, id string) *fakeCLI {
	t.Helper()
	// 会话侧读 sessR / 写 sessW；CLI 侧读 cliR / 写 cliW。
	sessR, cliW, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	cliR, sessW, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	t.Cleanup(func() {
		_ = sessR.Close()
		_ = sessW.Close()
		_ = cliR.Close()
		_ = cliW.Close()
	})
	sess := session.New(id, "/tmp", &pipeTransport{r: sessR, w: sessW}, nil)
	t.Cleanup(func() { _ = sess.Close() })

	done := make(chan error, 1)
	go func() { done <- sess.Start() }()

	// 读 initialize 请求并回包，否则 Start 会一直等到 InitTimeout。
	sc := bufio.NewScanner(cliR)
	if !sc.Scan() {
		t.Fatalf("没收到 initialize: %v", sc.Err())
	}
	var req struct {
		Type      string `json:"type"`
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(sc.Bytes(), &req); err != nil {
		t.Fatalf("解析 initialize: %v", err)
	}
	resp, _ := json.Marshal(map[string]any{
		"type": "control_response",
		"response": map[string]any{
			"subtype":    "success",
			"request_id": req.RequestID,
			"response":   map[string]any{"claude_code_version": "2.1.328"},
		},
	})
	if _, err := cliW.Write(append(resp, '\n')); err != nil {
		t.Fatalf("写 initialize 回包: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("Start: %v", err)
	}
	return &fakeCLI{sess: sess, out: cliW}
}

// emit 写一条 CLI 输出行。
func (f *fakeCLI) emit(t *testing.T, line string) {
	t.Helper()
	if _, err := f.out.Write([]byte(line + "\n")); err != nil {
		t.Fatalf("写 CLI 行: %v", err)
	}
}

// waitSeq 等会话的事件序号推进到 want（读循环是异步的）。
func (f *fakeCLI) waitSeq(t *testing.T, want uint64) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if f.sess.Seq() >= want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("会话序号停在 %d，want >= %d", f.sess.Seq(), want)
}

// 断线重连后补齐断线期间漏掉的会话事件。
//
// 这是「断网时跑完了一轮，重连后只看到前半截、用量与速度也丢了」的修复点：
// hub 只发给当前订阅者，断开期间的 assistant / tool_result / result 必须靠
// sync 从会话的重放缓冲里补回来，而不是等用户刷新整页。
func TestSyncReplaysEventsMissedWhileDisconnected(t *testing.T) {
	cli := startFakeCLI(t, "sync-1")
	// 断开期间产生的事件：正文 + 回合结束的 result。
	cli.emit(t, `{"type":"assistant","message":{"content":[{"type":"text","text":"断线期间的回答"}]}}`)
	cli.emit(t, `{"type":"result","subtype":"success","duration_ms":1234}`)
	cli.waitSeq(t, 2)

	srv, fake := newTestServer(t, "secret")
	srv.d.Manager = &sessionMgr{fakeMgr: fake, sess: cli.sess}

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	conn, r := dialWS(t, ts.Listener.Addr().String(), "/ws?id=sync-1&token=secret")
	defer conn.Close()

	// 快照里带着会话当前的事件序号与身份：前端据此判断要不要补、拿什么当基准。
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	snap := readEvent(t, r)
	if snap.Kind != "session.snapshot" {
		t.Fatalf("第一帧 = %q, want session.snapshot", snap.Kind)
	}
	var snapshot struct {
		Seq   uint64 `json:"seq"`
		Epoch string `json:"epoch"`
	}
	if err := json.Unmarshal(snap.Data, &snapshot); err != nil {
		t.Fatalf("解析快照: %v", err)
	}
	if snapshot.Seq < 2 || snapshot.Epoch == "" {
		t.Fatalf("快照 seq=%d epoch=%q，want >=2 与非空", snapshot.Seq, snapshot.Epoch)
	}

	// 前端说「我只处理到第 0 条」：后端要把 1、2 两条补回来。
	writeCmd(t, conn, map[string]any{"kind": "sync", "since": 0, "epoch": snapshot.Epoch})

	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	ev := readEvent(t, r)
	if ev.Kind != "session.replay" {
		t.Fatalf("补发帧 = %q, want session.replay", ev.Kind)
	}
	var payload struct {
		Events []struct {
			Kind string          `json:"kind"`
			Seq  uint64          `json:"seq"`
			Data json.RawMessage `json:"data"`
		} `json:"events"`
	}
	if err := json.Unmarshal(ev.Data, &payload); err != nil {
		t.Fatalf("解析补发帧: %v", err)
	}
	// 至少要把断线那两条补回来（会话自己还有 ready / state 之类的事件也在里面）。
	if len(payload.Events) < 2 {
		t.Fatalf("补发 %d 条，want >=2", len(payload.Events))
	}
	for i := 1; i < len(payload.Events); i++ {
		if payload.Events[i].Seq <= payload.Events[i-1].Seq {
			t.Fatalf("补发顺序不对: %+v", payload.Events)
		}
	}
	if last := payload.Events[len(payload.Events)-1]; last.Seq != snapshot.Seq {
		t.Fatalf("补到第 %d 条，快照说当前是 %d", last.Seq, snapshot.Seq)
	}
	// 断线期间那两条 cli 事件必须都在补发里（其余是会话自身的 ready/state 事件）。
	var cliKinds int
	for _, e := range payload.Events {
		if e.Kind == "cli" {
			cliKinds++
		}
	}
	if cliKinds < 2 {
		t.Fatalf("补发里只有 %d 条 cli 事件，want >=2: %+v", cliKinds, payload.Events)
	}
}

// 缺口补不齐（缓冲区淘汰 / 后端进程重开过）：回 session.resync，带上当前序号与身份，
// 让前端整份重放转录后把水位对齐，避免下一次重连又拿同一个过时的 since 来问。
func TestSyncFallsBackToResyncWhenGapEvicted(t *testing.T) {
	cli := startFakeCLI(t, "sync-2")
	cli.emit(t, `{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}`)
	cli.waitSeq(t, 1)

	srv, fake := newTestServer(t, "secret")
	srv.d.Manager = &sessionMgr{fakeMgr: fake, sess: cli.sess}

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	conn, r := dialWS(t, ts.Listener.Addr().String(), "/ws?id=sync-2&token=secret")
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_ = readEvent(t, r) // snapshot

	// epoch 对不上 = 会话对象换过（同一个 UUID 重新 --resume 了）：补不齐。
	writeCmd(t, conn, map[string]any{"kind": "sync", "since": 0, "epoch": "stale-epoch"})

	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	ev := readEvent(t, r)
	if ev.Kind != "session.resync" {
		t.Fatalf("帧 = %q, want session.resync", ev.Kind)
	}
	var payload struct {
		Seq   uint64 `json:"seq"`
		Epoch string `json:"epoch"`
	}
	if err := json.Unmarshal(ev.Data, &payload); err != nil {
		t.Fatalf("解析 resync 载荷: %v", err)
	}
	if payload.Seq != cli.sess.Seq() || payload.Epoch != cli.sess.Epoch() {
		t.Fatalf("resync 载荷 = %+v，want seq=%d 与当前 epoch", payload, cli.sess.Seq())
	}
}

// 水位已经追平（since == 当前 seq）时，后端也必须回一帧 session.replay，
// 否则前端的对齐窗口只能等 1 秒兜底计时器。
func TestSyncUpToDateStillReplies(t *testing.T) {
	cli := startFakeCLI(t, "uptodate-1")
	srv, fake := newTestServer(t, "secret")
	srv.d.Manager = &sessionMgr{fakeMgr: fake, sess: cli.sess}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	conn, r := dialWS(t, ts.Listener.Addr().String(), "/ws?id=uptodate-1&token=secret")
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_ = readEvent(t, r) // snapshot

	writeCmd(t, conn, map[string]any{"kind": "sync", "since": cli.sess.Seq(), "epoch": cli.sess.Epoch()})
	_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	ev := readEvent(t, r)
	if ev.Kind != "session.replay" {
		t.Fatalf("帧 = %q, want session.replay", ev.Kind)
	}
}

// pipeTransport 是会话与假 CLI 之间的双向管道。
type pipeTransport struct {
	r *os.File
	w *os.File
}

func (p *pipeTransport) Read(b []byte) (int, error)  { return p.r.Read(b) }
func (p *pipeTransport) Write(b []byte) (int, error) { return p.w.Write(b) }
func (p *pipeTransport) Close() error {
	_ = p.r.Close()
	return p.w.Close()
}
