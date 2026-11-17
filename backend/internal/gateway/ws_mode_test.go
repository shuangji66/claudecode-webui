package gateway

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"ccweb/backend/internal/agent/session"
	"ccweb/backend/internal/wsframe"
)

// hangTransport 是「永远不回话」的假 CLI：写进管道（在本测试的量级下不会阻塞），
// 读永远挂起。用它模拟 CLI 迟迟不回应控制请求——最典型的场合是它正挂在
// can_use_tool 上等审批。
type hangTransport struct{ w *os.File }

func (h hangTransport) Read([]byte) (int, error)    { select {} }
func (h hangTransport) Write(b []byte) (int, error) { return h.w.Write(b) }
func (h hangTransport) Close() error                { return h.w.Close() }

// sessionMgr 让 fakeMgr 返回一条真实的会话（假的 CLI 后端）。
type sessionMgr struct {
	*fakeMgr
	sess *session.Session
}

func (m *sessionMgr) Get(id string) (*session.Session, bool) {
	if m.sess != nil && id == m.sess.ID {
		return m.sess, true
	}
	return m.fakeMgr.Get(id)
}

// 切权限模式不能挡住同一连接上的后续命令。
//
// `set_permission_mode` 要等 CLI 的回包（最长 ModeTimeout）。如果网关在读循环上等，
// 这一步之后的帧全都读不到——其中就包括**审批回包**，而 CLI 可能正挂在
// can_use_tool 上等它：切模式等审批、审批等切模式，白等一个超时。
// 这里的判据：模式请求还没回包时，紧跟着发的 ping 必须立刻拿到 pong。
func TestPermissionModeDoesNotBlockReadLoop(t *testing.T) {
	pr, pw, err := os.Pipe()
	if err != nil {
		t.Fatalf("建管道: %v", err)
	}
	t.Cleanup(func() { _ = pr.Close(); _ = pw.Close() })

	sess := session.New("hang-1", "/tmp", hangTransport{w: pw}, nil)
	t.Cleanup(func() { _ = sess.Close() })

	srv, fake := newTestServer(t, "secret")
	srv.d.Manager = &sessionMgr{fakeMgr: fake, sess: sess}

	// 把超时压短：测试不必真等 10 秒，也不给进程留一条长期挂着的 goroutine。
	prev := session.ModeTimeout
	session.ModeTimeout = 800 * time.Millisecond
	t.Cleanup(func() { session.ModeTimeout = prev })

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	conn, r := dialWS(t, ts.Listener.Addr().String(), "/ws?id=hang-1&token=secret")
	defer conn.Close()

	// 会话通道先发一条快照，先把它读掉。
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := wsframe.ReadMessage(r, wsframe.DefaultMaxMessageBytes); err != nil {
		t.Fatalf("读快照: %v", err)
	}

	if _, err := conn.Write(wsframe.Encode(wsframe.OpText, []byte(`{"kind":"permission_mode","mode":"acceptEdits"}`))); err != nil {
		t.Fatalf("写模式命令: %v", err)
	}
	if _, err := conn.Write(wsframe.Encode(wsframe.OpText, []byte(`{"kind":"ping"}`))); err != nil {
		t.Fatalf("写 ping: %v", err)
	}

	// 300ms 内必须收到 pong：同步实现会被模式请求按住 800ms（更别说默认的 10s）。
	start := time.Now()
	_ = conn.SetReadDeadline(start.Add(300 * time.Millisecond))
	_, payload, err := wsframe.ReadMessage(r, wsframe.DefaultMaxMessageBytes)
	if err != nil {
		t.Fatalf("ping 被模式请求挡住了（%v）：读循环不能在等 CLI 回包时阻塞", err)
	}
	var ev WireEvent
	if err := json.Unmarshal(payload, &ev); err != nil {
		t.Fatalf("解析帧: %v", err)
	}
	if ev.Kind != "pong" {
		t.Fatalf("先收到的不是 pong 而是 %q", ev.Kind)
	}

	// 回包超时后仍然要告诉前端一次：失败不能静默。
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		_, payload, err = wsframe.ReadMessage(r, wsframe.DefaultMaxMessageBytes)
		if err != nil {
			t.Fatalf("没等到超时的 error 事件: %v", err)
		}
		if err := json.Unmarshal(payload, &ev); err != nil {
			t.Fatalf("解析帧: %v", err)
		}
		if ev.Kind == "error" {
			return
		}
	}
}
