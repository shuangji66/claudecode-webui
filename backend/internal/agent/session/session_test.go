package session

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// duplex 把一对 os.Pipe 拼成双向通道。
// 刻意不用 net.Pipe：后者是无缓冲的同步管道，写会一直阻塞到对端读，
// 测试里「先 Prompt 再读对端」的写法会自锁。os.Pipe 有内核缓冲，没这个问题。
type duplex struct {
	r *os.File
	w *os.File
}

func (d *duplex) Read(b []byte) (int, error)  { return d.r.Read(b) }
func (d *duplex) Write(b []byte) (int, error) { return d.w.Write(b) }
func (d *duplex) Close() error {
	err1 := d.r.Close()
	err2 := d.w.Close()
	if err1 != nil {
		return err1
	}
	return err2
}

// newDuplex 返回 (会话侧, 对端侧) 的双向通道。
func newDuplex(t *testing.T) (*duplex, *duplex) {
	t.Helper()
	sessR, cliW, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	cliR, sessW, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	t.Cleanup(func() {
		sessR.Close()
		sessW.Close()
		cliR.Close()
		cliW.Close()
	})
	return &duplex{r: sessR, w: sessW}, &duplex{r: cliR, w: cliW}
}

// recorder 收集会话抛出的事件，供断言使用。
type recorder struct {
	mu  sync.Mutex
	evs []Event
}

func (r *recorder) emit(ev Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.evs = append(r.evs, ev)
}

// find 返回第一个满足条件的事件。
func (r *recorder) find(kind string) (Event, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, ev := range r.evs {
		if ev.Kind == kind {
			return ev, true
		}
	}
	return Event{}, false
}

// wait 轮询等待某类事件出现（读循环是异步的，发完立刻断言会漏）。
func (r *recorder) wait(kind string, timeout time.Duration) (Event, bool) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if ev, ok := r.find(kind); ok {
			return ev, true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return Event{}, false
}

func (r *recorder) count(kind string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, ev := range r.evs {
		if ev.Kind == kind {
			n++
		}
	}
	return n
}

// fakeCLI 是测试用的对端，负责读取客户端写入的行并回包。
type fakeCLI struct {
	t    *testing.T
	conn io.ReadWriter
	sc   *bufio.Scanner
}

func newFakeCLI(t *testing.T, conn io.ReadWriter) *fakeCLI {
	sc := bufio.NewScanner(conn)
	sc.Buffer(make([]byte, 0, 4096), 1<<20)
	return &fakeCLI{t: t, conn: conn, sc: sc}
}

// next 读一行并解析成 map。
func (f *fakeCLI) next() map[string]any {
	f.t.Helper()
	if !f.sc.Scan() {
		f.t.Fatalf("对端未收到预期消息: %v", f.sc.Err())
	}
	var m map[string]any
	if err := json.Unmarshal(f.sc.Bytes(), &m); err != nil {
		f.t.Fatalf("解析失败: %v (%s)", err, f.sc.Text())
	}
	return m
}

func (f *fakeCLI) send(v any) {
	f.t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		f.t.Fatalf("marshal: %v", err)
	}
	if _, err := f.conn.Write(append(b, '\n')); err != nil {
		f.t.Fatalf("write: %v", err)
	}
}

// respond 按真实协议回包：request_id 嵌在 response.request_id。
func (f *fakeCLI) respond(requestID string, payload any) {
	f.send(map[string]any{
		"type": "control_response",
		"response": map[string]any{
			"subtype":    "success",
			"request_id": requestID,
			"response":   payload,
		},
	})
}

// handshake 走完 initialize 握手。
func (f *fakeCLI) handshake() {
	f.t.Helper()
	msg := f.next()
	if msg["type"] != "control_request" {
		f.t.Fatalf("首条消息类型 = %v, want control_request", msg["type"])
	}
	req := msg["request"].(map[string]any)
	if req["subtype"] != "initialize" {
		f.t.Fatalf("首条控制请求 subtype = %v, want initialize", req["subtype"])
	}
	f.respond(msg["request_id"].(string), map[string]any{
		"claude_code_version": "2.1.325",
		"commands":            []any{},
		"models":              []any{map[string]any{"value": "opus"}},
	})
}

// startSession 建立 net.Pipe 会话并完成握手。
func startSession(t *testing.T) (*Session, *fakeCLI, *recorder) {
	t.Helper()
	old := InitTimeout
	InitTimeout = 2 * time.Second
	t.Cleanup(func() { InitTimeout = old })

	sessSide, cliSide := newDuplex(t)
	server := sessSide
	rec := &recorder{}
	sess := New("s1", "/tmp/work", server, rec.emit)
	fc := newFakeCLI(t, cliSide)

	done := make(chan error, 1)
	go func() { done <- sess.Start() }()
	fc.handshake()
	if err := <-done; err != nil {
		t.Fatalf("Start: %v", err)
	}
	return sess, fc, rec
}

func TestStartHandshakeThenReady(t *testing.T) {
	sess, _, rec := startSession(t)
	defer sess.Close()

	if sess.State() != StateReady {
		t.Fatalf("state = %q, want ready", sess.State())
	}
	ev, ok := rec.find(KindSessionReady)
	if !ok {
		t.Fatal("未收到 session.ready 事件")
	}
	if !json.Valid(ev.Data) {
		t.Fatalf("session.ready 数据不是合法 JSON: %s", ev.Data)
	}
	// initialize 回包必须能取出 claude 版本，供前端做协议兼容性提示。
	if got := sess.InitPayload(); len(got) == 0 || !json.Valid(got) {
		t.Fatalf("init payload 异常: %s", got)
	}
}

func TestPromptSendsUserMessageAndMarksBusy(t *testing.T) {
	sess, fc, _ := startSession(t)
	defer sess.Close()

	if err := sess.Prompt("你好"); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	msg := fc.next()
	if msg["type"] != "user" {
		t.Fatalf("type = %v, want user", msg["type"])
	}
	if _, ok := msg["session_id"]; !ok {
		t.Fatal("session_id 字段必须存在（新会话为 null）")
	}
	if sess.State() != StateBusy {
		t.Fatalf("state = %q, want busy", sess.State())
	}

	// result 到达后应回到 ready，允许继续下一轮。
	fc.send(map[string]any{"type": "result", "subtype": "success"})
	waitState(t, sess, StateReady)
}

func TestPermissionRequestIsForwardedAndReplied(t *testing.T) {
	sess, fc, rec := startSession(t)
	defer sess.Close()

	fc.send(map[string]any{
		"type":       "control_request",
		"request_id": "p1",
		"request": map[string]any{
			"subtype":                "can_use_tool",
			"tool_name":              "Bash",
			"input":                  map[string]any{"command": "rm -rf /tmp/x"},
			"blocked_path":           "/tmp/x",
			"permission_suggestions": []any{map[string]any{"type": "setMode", "mode": "acceptEdits"}},
		},
	})

	ev, ok := rec.wait(KindPermission, 2*time.Second)
	if !ok {
		t.Fatal("未收到 permission 事件")
	}
	var payload map[string]any
	if err := json.Unmarshal(ev.Data, &payload); err != nil {
		t.Fatalf("permission 事件解析失败: %v", err)
	}
	if payload["tool_name"] != "Bash" || payload["request_id"] != "p1" {
		t.Fatalf("permission 载荷 = %v", payload)
	}

	// 允许后应写出一条 allow 控制响应，且 updatedInput 被带上。
	if err := sess.ReplyPermission("p1", PermissionReply{Allow: true, UpdatedInput: json.RawMessage(`{"command":"rm -rf ./x"}`)}); err != nil {
		t.Fatalf("ReplyPermission: %v", err)
	}
	resp := fc.next()
	if resp["type"] != "control_response" {
		t.Fatalf("type = %v", resp["type"])
	}
	inner := resp["response"].(map[string]any)
	if inner["request_id"] != "p1" {
		t.Fatalf("request_id = %v", inner["request_id"])
	}
	body := inner["response"].(map[string]any)
	if body["behavior"] != "allow" {
		t.Fatalf("behavior = %v", body["behavior"])
	}
	if body["updatedInput"] == nil {
		t.Fatal("updatedInput 应被透传（支持『编辑后运行』）")
	}
}

func TestDenyReply(t *testing.T) {
	sess, fc, _ := startSession(t)
	defer sess.Close()

	if err := sess.ReplyPermission("p2", PermissionReply{Allow: false, Message: "太危险"}); err != nil {
		t.Fatalf("ReplyPermission: %v", err)
	}
	resp := fc.next()
	body := resp["response"].(map[string]any)["response"].(map[string]any)
	if body["behavior"] != "deny" || body["message"] != "太危险" {
		t.Fatalf("deny 载荷 = %v", body)
	}
}

// TestUnknownControlRequestGetsUnsupported 保证未实现的子类型不会让 CLI 干等。
func TestUnknownControlRequestGetsUnsupported(t *testing.T) {
	sess, fc, _ := startSession(t)
	defer sess.Close()

	fc.send(map[string]any{
		"type":       "control_request",
		"request_id": "weird",
		"request":    map[string]any{"subtype": "some_future_thing"},
	})
	resp := fc.next()
	inner := resp["response"].(map[string]any)
	if inner["request_id"] != "weird" {
		t.Fatalf("request_id = %v", inner["request_id"])
	}
	if inner["subtype"] != "error" || inner["error_code"] != "unsupported_request" {
		t.Fatalf("应回 unsupported_request，实际 %v", inner)
	}
}

func TestInterruptAndSetModel(t *testing.T) {
	sess, fc, _ := startSession(t)
	defer sess.Close()

	if err := sess.Interrupt(); err != nil {
		t.Fatalf("Interrupt: %v", err)
	}
	msg := fc.next()
	req := msg["request"].(map[string]any)
	if req["subtype"] != "interrupt" {
		t.Fatalf("subtype = %v", req["subtype"])
	}

	if err := sess.SetModel("sonnet"); err != nil {
		t.Fatalf("SetModel: %v", err)
	}
	msg = fc.next()
	req = msg["request"].(map[string]any)
	if req["subtype"] != "set_model" || req["model"] != "sonnet" {
		t.Fatalf("set_model 载荷 = %v", req)
	}
}

func TestHandshakeTimeout(t *testing.T) {
	old := InitTimeout
	InitTimeout = 150 * time.Millisecond
	defer func() { InitTimeout = old }()

	sessSide, cliSide := newDuplex(t)
	sess := New("s2", "/tmp/work", sessSide, func(Event) {})
	// 不回复初始化，等超时
	err := sess.Start()
	if err == nil {
		t.Fatal("期望握手超时错误")
	}
	sess.Close()
	_ = cliSide.Close()
	if sess.State() != StateClosed {
		t.Fatalf("超时后 state = %q, want closed", sess.State())
	}
}

func TestCloseIsIdempotent(t *testing.T) {
	sess, _, _ := startSession(t)
	if err := sess.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := sess.Close(); err != nil {
		t.Fatalf("重复 Close 不应报错: %v", err)
	}
}

func TestPermPayloadKeepsSuggestions(t *testing.T) {
	// permission_suggestions 是前端「始终允许 / 切模式」按钮的数据源，不能丢。
	sess, fc, rec := startSession(t)
	defer sess.Close()
	fc.send(map[string]any{
		"type":       "control_request",
		"request_id": "p3",
		"request": map[string]any{
			"subtype":   "can_use_tool",
			"tool_name": "Edit",
			"permission_suggestions": []any{
				map[string]any{"type": "addRules", "destination": "localSettings"},
			},
		},
	})
	ev, ok := rec.wait(KindPermission, 2*time.Second)
	if !ok {
		t.Fatal("未收到 permission 事件")
	}
	var payload struct {
		Suggestions []map[string]any `json:"permission_suggestions"`
	}
	if err := json.Unmarshal(ev.Data, &payload); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if len(payload.Suggestions) != 1 || payload.Suggestions[0]["type"] != "addRules" {
		t.Fatalf("suggestions = %v", payload.Suggestions)
	}
}

func waitState(t *testing.T, s *Session, want string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if s.State() == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("等待状态 %q 超时，当前 %q", want, s.State())
}

// CLI 偶尔在 stdout 上混进非 JSON 行（警告、调试输出）。原样塞进 cli 事件会让
// json.Marshal 校验失败，变成一条「json: error calling MarshalJSON」的 error；
// 现在转成 system 文本，前端按普通输出显示。
func TestNonJSONStdoutBecomesSystemText(t *testing.T) {
	sess, fc, rec := startSession(t)
	defer sess.Close()

	if _, err := fc.conn.Write([]byte("warning: something odd\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	ev, ok := rec.wait(KindCLI, 2*time.Second)
	if !ok {
		t.Fatal("未收到 cli 事件")
	}
	var payload struct {
		Type    string `json:"type"`
		Subtype string `json:"subtype"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(ev.Data, &payload); err != nil {
		t.Fatalf("解析事件失败: %v (%s)", err, ev.Data)
	}
	if payload.Type != "system" || payload.Subtype != "stdout" {
		t.Fatalf("payload = %+v, want system/stdout", payload)
	}
	if payload.Content != "warning: something odd" {
		t.Fatalf("content = %q", payload.Content)
	}
}

// 单行超过上限时 bufio.Scanner 会返回 ErrTooLong；以前 readLoop 不看 Err，
// 会话会静默 close，前端只看到「已关闭」，完全不知道发生了什么。
func TestOversizedLineReportsError(t *testing.T) {
	// Scanner 的初始缓冲就是 64KB，上限必须不小于它才会真正触发 ErrTooLong。
	old := maxLineBytes
	maxLineBytes = 64 << 10
	t.Cleanup(func() { maxLineBytes = old })

	sess, fc, rec := startSession(t)
	defer sess.Close()

	// 写端会在读端关闭后拿到 EPIPE，放到 goroutine 里避免测试阻塞。
	go func() { _, _ = fc.conn.Write([]byte(strings.Repeat("a", 256<<10) + "\n")) }()
	ev, ok := rec.wait(KindError, 2*time.Second)
	if !ok {
		t.Fatal("超长行没有产生 error 事件")
	}
	var payload struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(ev.Data, &payload); err != nil {
		t.Fatalf("解析事件失败: %v", err)
	}
	if !strings.Contains(payload.Message, "读取 claude 输出中断") {
		t.Fatalf("message = %q", payload.Message)
	}
	if _, ok := rec.wait(KindClosed, 2*time.Second); !ok {
		t.Fatal("超长行之后会话应当关闭")
	}
}

// 停止子代理走控制请求；task_id 必须原样带过去，CLI 靠它定位任务。
func TestStopTaskSendsControlRequest(t *testing.T) {
	sess, fc, _ := startSession(t)
	defer sess.Close()

	if err := sess.StopTask("task-1"); err != nil {
		t.Fatalf("StopTask: %v", err)
	}
	msg := fc.next()
	if msg["type"] != "control_request" {
		t.Fatalf("type = %v", msg["type"])
	}
	req, _ := msg["request"].(map[string]any)
	if req["subtype"] != "stop_task" || req["task_id"] != "task-1" {
		t.Fatalf("request = %+v", req)
	}
	if err := sess.StopTask(""); err == nil {
		t.Fatal("空 task_id 应报错")
	}
}

func TestBackgroundTasksSendsControlRequest(t *testing.T) {
	sess, fc, _ := startSession(t)
	defer sess.Close()

	if err := sess.BackgroundTasks("toolu_01"); err != nil {
		t.Fatalf("BackgroundTasks: %v", err)
	}
	req, _ := fc.next()["request"].(map[string]any)
	if req["subtype"] != "background_tasks" || req["tool_use_id"] != "toolu_01" {
		t.Fatalf("request = %+v", req)
	}

	// 不带 tool_use_id = 全部前台任务（Ctrl+B 语义），字段必须缺省而不是空串。
	if err := sess.BackgroundTasks(""); err != nil {
		t.Fatalf("BackgroundTasks(all): %v", err)
	}
	req, _ = fc.next()["request"].(map[string]any)
	if _, ok := req["tool_use_id"]; ok {
		t.Fatalf("空 tool_use_id 不应出现: %+v", req)
	}
}

// 回归：Close 与 initialize 回包并发到达时读循环不能 panic。
//
// 旧实现里 Close 会 close(pending[request_id])，而 handleLine 是「从 map 取出
// channel、释放锁、再发送」。两者交错时向已关闭的 channel 发送会 panic，
// 且 panic 发生在没有 recover 的读循环 goroutine 里 —— 整个进程会退出。
func TestCloseRacingInitializeResponseNoPanic(t *testing.T) {
	old := InitTimeout
	InitTimeout = 2 * time.Second
	t.Cleanup(func() { InitTimeout = old })

	for i := 0; i < 30; i++ {
		sessSide, cliSide := newDuplex(t)
		sess := New("s-race", "/tmp/work", sessSide, func(Event) {})
		go func() { _ = sess.Start() }()

		// 先收 initialize 请求，拿到 request_id。
		sc := bufio.NewScanner(cliSide)
		sc.Buffer(make([]byte, 0, 4096), 1<<20)
		if !sc.Scan() {
			t.Fatalf("第 %d 轮：没收到 initialize: %v", i, sc.Err())
		}
		var req map[string]any
		if err := json.Unmarshal(sc.Bytes(), &req); err != nil {
			t.Fatalf("第 %d 轮：解析 initialize: %v", i, err)
		}
		requestID, _ := req["request_id"].(string)
		if requestID == "" {
			t.Fatalf("第 %d 轮：initialize 缺 request_id: %s", i, sc.Text())
		}
		line, err := json.Marshal(map[string]any{
			"type": "control_response",
			"response": map[string]any{
				"subtype":    "success",
				"request_id": requestID,
				"response":   map[string]any{"claude_code_version": "2.1.325"},
			},
		})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}

		// 回包与 Close 同时发生，命中「已取出 ch、尚未发送」的窗口。
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); <-start; _, _ = cliSide.Write(append(line, '\n')) }()
		go func() { defer wg.Done(); <-start; _ = sess.Close() }()
		close(start)
		wg.Wait()
		_ = sess.Close()
	}
}

// 回归：CLI 用 subtype=error 拒绝 initialize 时不能当成功。
//
// 旧实现只看「有没有回包」，而 error 子类型的 response.response 是空的 —— 于是
// 会话进入假 ready，用户发消息后 CLI 一个字节都不回，也没有 result，只能等空闲回收。
func TestStartFailsOnInitializeErrorSubtype(t *testing.T) {
	old := InitTimeout
	InitTimeout = 2 * time.Second
	t.Cleanup(func() { InitTimeout = old })

	sessSide, cliSide := newDuplex(t)
	rec := &recorder{}
	sess := New("s1", "/tmp/work", sessSide, rec.emit)
	fc := newFakeCLI(t, cliSide)

	done := make(chan error, 1)
	go func() { done <- sess.Start() }()

	msg := fc.next()
	requestID := msg["request_id"].(string)
	fc.send(map[string]any{
		"type": "control_response",
		"response": map[string]any{
			"subtype":    "error",
			"request_id": requestID,
			"error":      "invalid api key",
		},
	})

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("initialize 回 subtype=error 时 Start 必须失败")
		}
		if !strings.Contains(err.Error(), "invalid api key") {
			t.Fatalf("错误信息未带上 CLI 的原因: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Start 没有返回")
	}
	if sess.State() != StateClosed {
		t.Fatalf("state = %q, want closed", sess.State())
	}
	if _, ok := rec.find(KindSessionReady); ok {
		t.Fatal("握手失败却抛出了 session.ready")
	}
}

// 挂起的审批必须能被重放：WS 重连要把它带回前端。
// 不重放的话刷新页面就再也点不到那个审批，而 CLI 一直挂在 can_use_tool 上。
func TestPendingPermissionsSurviveUntilReplied(t *testing.T) {
	sess, fc, rec := startSession(t)
	defer sess.Close()

	if got := sess.PendingPermissions(); len(got) != 0 {
		t.Fatalf("初始不应有挂起审批: %v", got)
	}
	fc.send(map[string]any{
		"type":       "control_request",
		"request_id": "p1",
		"request": map[string]any{
			"subtype":   "can_use_tool",
			"tool_name": "Bash",
			"input":     map[string]any{"command": "rm -rf /tmp/x"},
		},
	})
	if _, ok := rec.wait(KindPermission, 2*time.Second); !ok {
		t.Fatal("未收到 permission 事件")
	}

	got := sess.PendingPermissions()
	if len(got) != 1 {
		t.Fatalf("挂起审批数 = %d, want 1", len(got))
	}
	var payload map[string]any
	if err := json.Unmarshal(got[0], &payload); err != nil {
		t.Fatalf("重放载荷不是合法 JSON: %v", err)
	}
	if payload["request_id"] != "p1" || payload["tool_name"] != "Bash" {
		t.Fatalf("重放载荷 = %+v", payload)
	}

	if err := sess.ReplyPermission("p1", PermissionReply{Allow: true}); err != nil {
		t.Fatalf("ReplyPermission: %v", err)
	}
	if left := sess.PendingPermissions(); len(left) != 0 {
		t.Fatalf("回复后仍残留审批: %v", left)
	}
}

// slowSink 的 Write 会一直阻塞，模拟「CLI 暂时不读 stdin」（大 prompt 正在处理、
// 或者对端卡住）。读循环不能因此停摆，否则 stdout 没人排空，双向死锁。
type slowSink struct {
	release chan struct{}
	once    sync.Once
	wrote   chan struct{}
}

func newSlowSink() *slowSink {
	return &slowSink{release: make(chan struct{}), wrote: make(chan struct{}, 8)}
}

func (s *slowSink) Read([]byte) (int, error) { select {} }
func (s *slowSink) Close() error            { s.once.Do(func() { close(s.release) }); return nil }
func (s *slowSink) Write(b []byte) (int, error) {
	s.wrote <- struct{}{}
	<-s.release
	return len(b), nil
}

// 回归：读循环里回 unsupported 不能同步写 stdin。
//
// 旧实现直接在 handleLine 里 writeLine：stdin 管道被对端堵住时，读循环卡在写锁上，
// 同时不再读 stdout，CLI 写满管道也阻塞 —— 会话双向死锁，且状态一直显示 ready/busy。
func TestHandleLineDoesNotBlockOnStdin(t *testing.T) {
	sink := newSlowSink()
	sess := New("s1", "/tmp/work", sink, func(Event) {})
	t.Cleanup(func() { _ = sess.Close() })

	// 未实现的子类型：必须回 unsupported（走写队列），但调用不能等写完。
	line := []byte(`{"type":"control_request","request_id":"r1","request":{"subtype":"no_such_subtype"}}`)
	done := make(chan struct{})
	go func() {
		sess.handleLine(line)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("handleLine 被 stdin 写操作阻塞了")
	}

	// 回包确实进了写队列（writer goroutine 已经卡在 Write 上）。
	select {
	case <-sink.wrote:
	case <-time.After(2 * time.Second):
		t.Fatal("unsupported 回包没有进入写队列")
	}
}

// 写队列满（对端长期不读）时会话必须被关掉，而不是把调用方永远挂住。
func TestWriteQueueFullClosesSession(t *testing.T) {
	sink := newSlowSink()
	sess := New("s1", "/tmp/work", sink, func(Event) {})
	defer sink.Close()

	line := []byte(`{"type":"control_request","request_id":"r%d","request":{"subtype":"x"}}`)
	for i := 0; i < 200; i++ {
		select {
		case <-sess.Done():
			return // 已按预期关闭
		default:
		}
		sess.writeAsync([]byte(`{"type":"control_request"}`))
		_ = line
	}
	t.Fatal("写队列灌满后会话没有关闭")
}
