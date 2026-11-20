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

// last 返回某类事件里最后一条（会话里同一类事件会来很多次）。
func (r *recorder) last(kind string) (Event, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := len(r.evs) - 1; i >= 0; i-- {
		if r.evs[i].Kind == kind {
			return r.evs[i], true
		}
	}
	return Event{}, false
}

// topicOf 返回某类事件最后一条上指定的路由 topic（空 = 由上层按 CurrentID 决定）。
func (r *recorder) topicOf(kind string) string {
	ev, ok := r.last(kind)
	if !ok {
		return ""
	}
	return ev.Topic
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

// TestPromptDuringTurnIsAccepted 覆盖「插话」依赖的协议事实：回合进行中 stdin 照样可写。
//
// 实测（claude 2.1.x）：第二条 user 帧不会报错、也不会丢；本轮还有工具边界时它被并进
// 本轮，本轮已经收尾时 CLI 会先发 result、再发一条 system/init 把它当新的一轮跑。
// 前端据此在「本轮结束后自动发下一条」，这里只保证会话层不拦、不报错。
func TestPromptDuringTurnIsAccepted(t *testing.T) {
	sess, fc, _ := startSession(t)
	defer sess.Close()

	if err := sess.Prompt("先跑这条"); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	fc.next() // 第一条 user 帧
	if sess.State() != StateBusy {
		t.Fatalf("state = %q, want busy", sess.State())
	}

	// 回合进行中再写一条：必须照常写出，且状态仍是 busy（不许退回 ready）。
	if err := sess.Prompt("等一下，换个方向"); err != nil {
		t.Fatalf("进行中 Prompt: %v", err)
	}
	msg := fc.next()
	if msg["type"] != "user" {
		t.Fatalf("第二条消息 type = %v, want user", msg["type"])
	}
	content := msg["message"].(map[string]any)["content"].([]any)
	if text := content[0].(map[string]any)["text"]; text != "等一下，换个方向" {
		t.Fatalf("第二条消息正文 = %v", text)
	}
	if sess.State() != StateBusy {
		t.Fatalf("state = %q, want busy", sess.State())
	}
}

// 插话帧必须带 priority=now + origin=human：只写 user 帧的话 CLI 按默认的 next
// 处理（等本轮收尾），表现就跟排队一样，用户会说「插话没生效」。
func TestPromptInterjectCarriesPriority(t *testing.T) {
	sess, fc, _ := startSession(t)
	defer sess.Close()

	if err := sess.Prompt("先跑这条"); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	first := fc.next()
	if first["priority"] != nil {
		t.Fatalf("普通消息不该带 priority: %v", first["priority"])
	}
	if origin, _ := first["origin"].(map[string]any); origin["kind"] != "human" {
		t.Fatalf("普通消息也要标 origin:human，实际 %v", first["origin"])
	}

	if err := sess.PromptInterject("等一下，换个方向", nil); err != nil {
		t.Fatalf("PromptInterject: %v", err)
	}
	msg := fc.next()
	if msg["priority"] != "now" {
		t.Fatalf("插话 priority = %v, want now", msg["priority"])
	}
	if origin, _ := msg["origin"].(map[string]any); origin["kind"] != "human" {
		t.Fatalf("插话 origin = %v, want {kind:human}", msg["origin"])
	}
}

// TestTurnInitAfterResultMarksBusy 覆盖「插话延后成新的一轮」：CLI 会在 result 之后
// 立刻再发一条 init。不认这条信号，界面会在整轮里显示空闲（发送按钮而不是中断按钮）。
func TestTurnInitAfterResultMarksBusy(t *testing.T) {
	sess, fc, _ := startSession(t)
	defer sess.Close()

	if err := sess.Prompt("你好"); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	fc.next()
	fc.send(map[string]any{"type": "result", "subtype": "success"})
	waitState(t, sess, StateReady)

	fc.send(map[string]any{"type": "system", "subtype": "init", "permissionMode": "default"})
	waitState(t, sess, StateBusy)
}

// 插话没赶上当前回合时，CLI 先发 result 收尾、再开新一轮跑插话（实测 2.1.328）。
// 那条 result 到达时不能把状态标回 ready：前端据此画发送键、计时行与收起行，
// 标了就会先闪一下「已完成 / 可以发送」，然后被紧随其后的 init 推翻。
func TestInterjectHandoffResultKeepsBusy(t *testing.T) {
	sess, fc, _ := startSession(t)
	defer sess.Close()

	if err := sess.Prompt("开始干活"); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	fc.next()
	fc.send(map[string]any{"type": "assistant", "message": map[string]any{"content": []any{}}})
	// 等读循环把这一帧算进 contentSeq：插话记的是「写下那一刻已经处理过几条内容」。
	waitContent(t, sess, 1)
	if err := sess.PromptInterject("顺便看一眼日志", nil); err != nil {
		t.Fatalf("PromptInterject: %v", err)
	}
	fc.next()
	// 交棒：result 紧跟插话，这一轮其实还没完。
	fc.send(map[string]any{"type": "result", "subtype": "success"})
	time.Sleep(50 * time.Millisecond)
	if got := sess.State(); got != StateBusy {
		t.Fatalf("交棒的 result 之后 state = %q, want busy（界面会闪一下「已完成」）", got)
	}

	// init 到了本来就是 busy；跑起来之后第一次真正的 result 才把状态放开。
	fc.send(map[string]any{"type": "system", "subtype": "init", "permissionMode": "default"})
	fc.send(map[string]any{"type": "assistant", "message": map[string]any{"content": []any{}}})
	fc.send(map[string]any{"type": "result", "subtype": "success"})
	waitState(t, sess, StateReady)
}

// 插话被 CLI 并进当前回合时，那条 result 是真正的收尾（不是交棒）：状态必须回到
// ready，否则界面会一直显示「正在工作」，收起行也永远不出来。
func TestInterjectAbsorbedStillSettlesOnResult(t *testing.T) {
	sess, fc, _ := startSession(t)
	defer sess.Close()

	if err := sess.Prompt("开始干活"); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	fc.next()
	if err := sess.PromptInterject("顺便看一眼日志", nil); err != nil {
		t.Fatalf("PromptInterject: %v", err)
	}
	fc.next()
	// 并进了当前回合：插话之后还有内容，说明这一轮继续在跑。
	fc.send(map[string]any{"type": "assistant", "message": map[string]any{"content": []any{}}})
	fc.send(map[string]any{"type": "result", "subtype": "success"})
	waitState(t, sess, StateReady)
}

// 出错 / 被中断的 result 是真停了：哪怕它紧挨着一条插话，状态也要回到 ready。
func TestInterjectFollowedByErrorResultSettles(t *testing.T) {
	for _, result := range []map[string]any{
		{"type": "result", "subtype": "success", "is_error": true},
		{"type": "result", "subtype": "error_during_execution", "errors": []string{"[ede_diagnostic] result_type=user stop_reason=null"}},
	} {
		sess, fc, _ := startSession(t)
		if err := sess.Prompt("开始干活"); err != nil {
			t.Fatalf("Prompt: %v", err)
		}
		fc.next()
		if err := sess.PromptInterject("顺便看一眼日志", nil); err != nil {
			t.Fatalf("PromptInterject: %v", err)
		}
		fc.next()
		fc.send(result)
		waitState(t, sess, StateReady)
		sess.Close()
	}
}

// 用户「插一句、紧接着又发一条」：后一条普通 prompt 不能把插话标记清掉。
// 清了的话 CLI 为插话发的那条交棒 result 会被当成真结束——界面先闪一下「已完成」
// 再被新一轮推翻，正是这个标记要解决的现象。
func TestInterjectFlagSurvivesLaterPrompt(t *testing.T) {
	sess, fc, _ := startSession(t)
	defer sess.Close()

	if err := sess.Prompt("开始干活"); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	fc.next()
	fc.send(map[string]any{"type": "assistant", "message": map[string]any{"content": []any{}}})
	waitContent(t, sess, 1)
	if err := sess.PromptInterject("顺便看一眼日志", nil); err != nil {
		t.Fatalf("PromptInterject: %v", err)
	}
	// 队列里的下一条普通消息紧接着也写进了 stdin。
	if err := sess.PromptWithAttachments("再跑一遍测试", nil); err != nil {
		t.Fatalf("PromptWithAttachments: %v", err)
	}
	fc.next()
	fc.next()
	fc.send(map[string]any{"type": "result", "subtype": "success"})
	time.Sleep(50 * time.Millisecond)
	if got := sess.State(); got != StateBusy {
		t.Fatalf("交棒的 result 之后 state = %q, want busy", got)
	}
}

// 空闲很久之后冒出来的 init 不能把会话标成忙碌，否则界面会一直显示「正在工作」。
func TestStaleInitAfterLongIdleKeepsReady(t *testing.T) {
	old := TurnHandoffWindow
	TurnHandoffWindow = 20 * time.Millisecond
	t.Cleanup(func() { TurnHandoffWindow = old })

	sess, fc, _ := startSession(t)
	defer sess.Close()

	if err := sess.Prompt("你好"); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	fc.next()
	fc.send(map[string]any{"type": "result", "subtype": "success"})
	waitState(t, sess, StateReady)
	time.Sleep(60 * time.Millisecond)

	fc.send(map[string]any{"type": "system", "subtype": "init"})
	time.Sleep(100 * time.Millisecond)
	if sess.State() != StateReady {
		t.Fatalf("state = %q, want ready", sess.State())
	}
}

// waitContent 等读循环把指定条数的内容帧处理完。
//
// 插话标记记的是「写下那一刻已处理过几条内容」（见 Session.contentSeq）：测试里刚
// send 完的帧可能还没被读循环看到，不等一下会让标记记成旧值。
func waitContent(t *testing.T, s *Session, want uint64) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		s.interjectMu.Lock()
		got := s.contentSeq
		s.interjectMu.Unlock()
		if got >= want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("等待内容帧 %d 超时", want)
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

// 审批结论是会话级事实：一台设备批准后，其他设备/标签必须收到 permission.resolved。
// CLI 拿到回包后只会继续跑，不会再用任何事件暗示「这条已经处理完」——不广播的话
// 别的设备上的卡片永远消不掉，一轮里几条审批就会一直累积下去。
func TestPermissionReplyBroadcastsResolution(t *testing.T) {
	sess, fc, rec := startSession(t)
	defer sess.Close()

	fc.send(map[string]any{
		"type":       "control_request",
		"request_id": "p7",
		"request": map[string]any{
			"subtype":   "can_use_tool",
			"tool_name": "Bash",
			"input":     map[string]any{"command": "rm -rf /tmp/y"},
		},
	})
	if _, ok := rec.wait(KindPermission, 2*time.Second); !ok {
		t.Fatal("未收到 permission 事件")
	}
	if rec.count(KindPermissionResolved) != 0 {
		t.Fatal("还没做决定就广播了 permission.resolved")
	}

	if err := sess.ReplyPermission("p7", PermissionReply{Allow: false, Message: "no"}); err != nil {
		t.Fatalf("ReplyPermission: %v", err)
	}
	ev, ok := rec.wait(KindPermissionResolved, 2*time.Second)
	if !ok {
		t.Fatal("审批结论没有广播")
	}
	var payload map[string]any
	if err := json.Unmarshal(ev.Data, &payload); err != nil {
		t.Fatalf("结论载荷不是合法 JSON: %v", err)
	}
	if payload["request_id"] != "p7" {
		t.Fatalf("结论载荷 = %+v", payload)
	}
	// 同一个 request_id 只广播一次：重复回包不该让其他设备反复抖动。
	if n := rec.count(KindPermissionResolved); n != 1 {
		t.Fatalf("结论广播次数 = %d, want 1", n)
	}
}

// 中断让整轮作废，挂起审批必须一起清掉并广播：只在本机清的话，
// 另一台设备会继续显示一批点了也没用的卡片。
func TestInterruptClearsPendingPermissions(t *testing.T) {
	sess, fc, rec := startSession(t)
	defer sess.Close()

	for _, id := range []string{"p8", "p9"} {
		fc.send(map[string]any{
			"type":       "control_request",
			"request_id": id,
			"request": map[string]any{
				"subtype":   "can_use_tool",
				"tool_name": "Bash",
				"input":     map[string]any{"command": "rm -rf /tmp/z"},
			},
		})
	}
	if _, ok := rec.wait(KindPermission, 2*time.Second); !ok {
		t.Fatal("未收到 permission 事件")
	}
	if got := sess.PendingPermissions(); len(got) != 2 {
		t.Fatalf("挂起审批数 = %d, want 2", len(got))
	}

	if err := sess.Interrupt(); err != nil {
		t.Fatalf("Interrupt: %v", err)
	}
	if left := sess.PendingPermissions(); len(left) != 0 {
		t.Fatalf("中断后仍残留审批: %v", left)
	}
	deadline := time.Now().Add(2 * time.Second)
	for rec.count(KindPermissionResolved) < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if n := rec.count(KindPermissionResolved); n != 2 {
		t.Fatalf("结论广播次数 = %d, want 2", n)
	}
}

// CLI 用 control_cancel_request 撤回自己发出的审批：卡片必须撤掉（否则永远挂着），
// 而且**不能回包**——撤回是一条单向通知，回一条 control_response 等于在回答一条
// 已经作废的请求。
func TestControlCancelRequestWithdrawsPermission(t *testing.T) {
	sess, fc, rec := startSession(t)
	defer sess.Close()

	fc.send(map[string]any{
		"type":       "control_request",
		"request_id": "p-cancel",
		"request": map[string]any{
			"subtype":   "can_use_tool",
			"tool_name": "Bash",
			"input":     map[string]any{"command": "rm -rf /tmp/z"},
		},
	})
	if _, ok := rec.wait(KindPermission, 2*time.Second); !ok {
		t.Fatal("未收到 permission 事件")
	}

	fc.send(map[string]any{"type": "control_cancel_request", "request_id": "p-cancel"})
	ev, ok := rec.wait(KindPermissionResolved, 2*time.Second)
	if !ok {
		t.Fatal("撤回了审批却没有广播 permission.resolved，其他设备上的卡片会一直挂着")
	}
	var payload map[string]any
	if err := json.Unmarshal(ev.Data, &payload); err != nil {
		t.Fatalf("结论载荷不是合法 JSON: %v", err)
	}
	if payload["request_id"] != "p-cancel" {
		t.Fatalf("结论载荷 = %+v", payload)
	}
	// 撤掉之后挂起表里不该再有它：再来一条同 id 的 control_response 时，
	// 会因为「无人认领」转给前端做审计，而不是被当成一次有效回包。
	sess.permMu.Lock()
	_, still := sess.perms["p-cancel"]
	sess.permMu.Unlock()
	if still {
		t.Fatal("撤回后挂起表里还留着这条审批")
	}
	// 撤回之后读循环必须照常工作：发一条真的控制请求，它的回包要能到达。
	// （撤回本身不回包，所以这里不能用「等回包」来验证，只能验会话没被卡住。）
	fc.send(map[string]any{
		"type":       "control_request",
		"request_id": "p-after",
		"request": map[string]any{
			"subtype":   "can_use_tool",
			"tool_name": "Bash",
			"input":     map[string]any{"command": "echo hi"},
		},
	})
	deadline := time.Now().Add(2 * time.Second)
	for rec.count(KindPermission) < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if n := rec.count(KindPermission); n != 2 {
		t.Fatalf("撤回之后的审批事件数 = %d, want 2（读循环被卡住了）", n)
	}
}

// keep_alive 是纯心跳，不能进重放缓冲：长跑的控制请求期间 CLI 会周期性发它，
// 当成普通 cli 事件转出去会把真正要补发的历史挤出 replayMaxEvents。
func TestKeepAliveIsDropped(t *testing.T) {
	sess, fc, rec := startSession(t)
	defer sess.Close()

	for i := 0; i < 50; i++ {
		fc.send(map[string]any{"type": "keep_alive"})
	}
	// 再发一条正常消息当哨兵：它到达时，前面的心跳已经全部处理完（同一条管道、顺序读）。
	fc.send(map[string]any{
		"type":    "system",
		"subtype": "informational",
		"content": "哨兵",
	})
	if _, ok := rec.wait(KindCLI, 2*time.Second); !ok {
		t.Fatal("没收到哨兵消息")
	}
	if n := rec.count(KindCLI); n != 1 {
		t.Fatalf("cli 事件数 = %d, want 1（心跳不该被转发）", n)
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
func (s *slowSink) Close() error             { s.once.Do(func() { close(s.release) }); return nil }
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

func TestSetPermissionModeWaitsForResponse(t *testing.T) {
	sess, fc, _ := startSession(t)
	done := make(chan error, 1)
	go func() { done <- sess.SetPermissionMode("plan") }()

	msg := fc.next()
	req := msg["request"].(map[string]any)
	if req["subtype"] != "set_permission_mode" || req["mode"] != "plan" {
		t.Fatalf("请求体不对: %v", req)
	}
	// 回包前不能返回：CLI 只在回包里说明拒绝原因，提前返回等于假装切成功。
	select {
	case err := <-done:
		t.Fatalf("回包前就返回了: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	fc.respond(msg["request_id"].(string), map[string]any{"mode": "plan"})
	if err := <-done; err != nil {
		t.Fatalf("SetPermissionMode: %v", err)
	}
}

func TestSetPermissionModeReportsCLIRejection(t *testing.T) {
	sess, fc, _ := startSession(t)
	done := make(chan error, 1)
	go func() { done <- sess.SetPermissionMode("bogus") }()

	msg := fc.next()
	fc.send(map[string]any{
		"type": "control_response",
		"response": map[string]any{
			"subtype":    "error",
			"request_id": msg["request_id"],
			"error":      "Cannot set permission mode: must be one of acceptEdits, auto, bypassPermissions, default, dontAsk, plan",
		},
	})
	err := <-done
	if err == nil || !strings.Contains(err.Error(), "must be one of") {
		t.Fatalf("应把 CLI 的拒绝原因带回来，实际 %v", err)
	}
}

// CLI 报上来的会话名要转成事件，同一名字重复上报只发一次。
//
// 这条链路服务的是「别处改了名字」：终端 /rename、IDE 插件、--name。
// 不去重的话 CLI 每次重连/重启都会再发一遍同样的名字，上层就会把
// conversations.changed 推给每个连接、让它们重扫一遍全部转录。
func TestSessionTitleEventDeduped(t *testing.T) {
	_, fc, rec := startSession(t)

	frame := map[string]any{
		"type": "system", "subtype": "session_title_changed", "title": "终端改的名字",
		"uuid": "u1", "session_id": "s1",
	}
	fc.send(frame)
	ev, ok := rec.wait(KindSessionTitle, time.Second)
	if !ok {
		t.Fatal("未收到 session.title 事件")
	}
	var data map[string]string
	if err := json.Unmarshal(ev.Data, &data); err != nil {
		t.Fatalf("事件数据不是合法 JSON: %s", ev.Data)
	}
	if data["title"] != "终端改的名字" || data["session_id"] != "s1" {
		t.Fatalf("事件内容 = %v", data)
	}

	// 同一个名字再来两遍：CLI 明确要求宿主把重复当作「没变化」。
	fc.send(frame)
	fc.send(frame)
	time.Sleep(100 * time.Millisecond)
	if n := rec.count(KindSessionTitle); n != 1 {
		t.Fatalf("重复的标题上报发了 %d 次，应只发 1 次", n)
	}

	// 换了名字要照常发。
	fc.send(map[string]any{
		"type": "system", "subtype": "session_title_changed", "title": "又改了一次",
		"uuid": "u2", "session_id": "s1",
	})
	deadline := time.Now().Add(time.Second)
	for rec.count(KindSessionTitle) < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if n := rec.count(KindSessionTitle); n != 2 {
		t.Fatalf("改名后事件数 = %d, want 2", n)
	}
	// 原文仍要作为 cli 事件转给前端（审计/日志），不能被这条分支吞掉。
	if rec.count(KindCLI) != 4 {
		t.Fatalf("system 原文应继续转发，cli 事件数 = %d", rec.count(KindCLI))
	}
}

func TestPermissionModeEventFromCLIStatus(t *testing.T) {
	_, fc, rec := startSession(t)

	// 切模式后 CLI 会发一条 system/status；每个回合的 system/init 也带 permissionMode。
	fc.send(map[string]any{
		"type": "system", "subtype": "status", "status": nil, "permissionMode": "plan",
		"uuid": "u1", "session_id": "s1",
	})
	// 握手本身也会发 session.state（带 state 字段），所以按内容等那条带 mode 的。
	var mode string
	deadline := time.Now().Add(time.Second)
	for mode == "" && time.Now().Before(deadline) {
		rec.mu.Lock()
		for _, ev := range rec.evs {
			if ev.Kind != KindSessionState {
				continue
			}
			var data map[string]string
			if json.Unmarshal(ev.Data, &data) == nil {
				mode = data["mode"]
			}
		}
		rec.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	if mode != "plan" {
		t.Fatalf("mode = %q，没有收到权限模式事件", mode)
	}
	// 原始行仍要转给前端（审计/日志用），不能被这条分支吞掉。
	if rec.count(KindCLI) != 1 {
		t.Fatalf("system 原文应继续作为 cli 事件转发，count=%d", rec.count(KindCLI))
	}
}

// 后台任务的 task_id 只出现在实时的 task_* 事件里，转录回放里没有。
// 会话要把「还没结束的」记下来随快照下发，否则中途连上的设备拿不到 task_id，
// 界面上那些「进行中」的后台操作就中止不了。
func TestLiveTasksTracksStartAndFinish(t *testing.T) {
	sess, fc, rec := startSession(t)
	defer sess.Close()

	if got := sess.LiveTasks(); len(got) != 0 {
		t.Fatalf("初始不应有后台任务: %v", got)
	}

	// 后台命令：local_bash，带 tool_use_id。
	fc.send(map[string]any{
		"type":            "system",
		"subtype":         "task_started",
		"task_id":         "task-1",
		"tool_use_id":     "toolu_01",
		"task_type":       "local_bash",
		"description":     "npm test",
		"is_backgrounded": true,
	})
	if _, ok := rec.wait(KindCLI, 2*time.Second); !ok {
		t.Fatal("task_started 应继续作为 cli 事件转发")
	}

	got := sess.LiveTasks()
	if len(got) != 1 || got[0].TaskID != "task-1" || got[0].ToolUseID != "toolu_01" {
		t.Fatalf("后台任务表 = %+v", got)
	}

	// task_updated 不带 tool_use_id：不能把先前记下的那个清掉。
	fc.send(map[string]any{
		"type":    "system",
		"subtype": "task_updated",
		"task_id": "task-1",
		"patch":   map[string]any{"status": "running"},
	})
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if tasks := sess.LiveTasks(); len(tasks) == 1 && tasks[0].ToolUseID == "toolu_01" {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if tasks := sess.LiveTasks(); tasks[0].ToolUseID != "toolu_01" {
		t.Fatalf("task_updated 后 tool_use_id 丢了: %+v", tasks)
	}

	// 结束的任务要摘掉：这张表只回答「现在还能中止哪些」。
	fc.send(map[string]any{
		"type":    "system",
		"subtype": "task_notification",
		"task_id": "task-1",
		"status":  "completed",
		"summary": "ok",
	})
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if len(sess.LiveTasks()) == 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("任务结束后仍在表里: %+v", sess.LiveTasks())
}

// 非 task_* 的 system 消息不能进这张表（否则每个 init/status 都会造出假任务）。
func TestLiveTasksIgnoresOtherSystemMessages(t *testing.T) {
	sess, fc, _ := startSession(t)
	defer sess.Close()

	fc.send(map[string]any{"type": "system", "subtype": "status", "status": "ready"})
	fc.send(map[string]any{"type": "system", "subtype": "init", "session_id": "s1"})
	time.Sleep(50 * time.Millisecond)
	if got := sess.LiveTasks(); len(got) != 0 {
		t.Fatalf("非 task_* 消息不该进表: %+v", got)
	}
}

// 压缩期间 CLI 只发一条 `status: compacting` 就安静二十几秒（实测一次手动压缩
// 25.3 秒）。前端只按「最后一条帧」判沉默，压缩途中刷新页面就完全拿不到这个状态，
// 于是照样报「上游没有响应」——所以要随 session.snapshot 下发。
func TestLocalBusyTracksCompacting(t *testing.T) {
	sess, fc, rec := startSession(t)
	defer sess.Close()

	if got := sess.LocalBusy(); got.Compacting || len(got.Hooks) != 0 {
		t.Fatalf("初始不该有本地忙状态: %+v", got)
	}

	fc.send(map[string]any{"type": "system", "subtype": "status", "status": "compacting", "compact_output_chars": 1200})
	if _, ok := rec.wait(KindCLI, 2*time.Second); !ok {
		t.Fatal("compacting 帧应继续作为 cli 事件转发")
	}
	if !sess.LocalBusy().Compacting {
		t.Fatal("收到 status=compacting 后应记为正在压缩")
	}

	// 压缩结束的几种信号都要认（CLI 有时只发请求态，有时只发边界）。
	fc.send(map[string]any{"type": "system", "subtype": "status", "status": "requesting"})
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && sess.LocalBusy().Compacting {
		time.Sleep(5 * time.Millisecond)
	}
	if sess.LocalBusy().Compacting {
		t.Fatal("status=requesting 之后不该还在压缩")
	}
}

// **自动压缩**（上下文撞到阈值时 CLI 自己触发）收尾用的是 `status: null` +
// `metadata.compactResult`，不是 `requesting`（二进制里那条 `sdk_status` 分支）。
// 只认 requesting 的话，自动压缩之后界面上会一直停在「正在压缩上下文」，
// 而沉默提示也跟着永久失效。
func TestLocalBusyAutoCompactEndsWithNullStatus(t *testing.T) {
	sess, fc, _ := startSession(t)
	defer sess.Close()

	fc.send(map[string]any{"type": "system", "subtype": "status", "status": "compacting", "compact_output_chars": 4200})
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && !sess.LocalBusy().Compacting {
		time.Sleep(5 * time.Millisecond)
	}
	if !sess.LocalBusy().Compacting {
		t.Fatal("没进入压缩状态，后面的断言没有意义")
	}

	// 自动压缩成功时 CLI 发的是 status:null（不是 requesting），metadata 里带结果。
	fc.send(map[string]any{
		"type":     "system",
		"subtype":  "status",
		"status":   nil,
		"metadata": map[string]any{"compactResult": "success"},
	})
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) && sess.LocalBusy().Compacting {
		time.Sleep(5 * time.Millisecond)
	}
	if sess.LocalBusy().Compacting {
		t.Fatal("自动压缩的 status:null 之后不该还在压缩")
	}
}

func TestLocalBusyCompactBoundaryEndsCompacting(t *testing.T) {
	sess, fc, _ := startSession(t)
	defer sess.Close()

	fc.send(map[string]any{"type": "system", "subtype": "status", "status": "compacting"})
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && !sess.LocalBusy().Compacting {
		time.Sleep(5 * time.Millisecond)
	}
	fc.send(map[string]any{
		"type":    "system",
		"subtype": "compact_boundary",
		"compactMetadata": map[string]any{
			"trigger":     "manual",
			"preTokens":   368934,
			"postTokens":  9254,
			"duration_ms": 25306,
		},
	})
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) && sess.LocalBusy().Compacting {
		time.Sleep(5 * time.Millisecond)
	}
	if sess.LocalBusy().Compacting {
		t.Fatal("compact_boundary 之后不该还在压缩")
	}
}

// hook 是用户自己配的本地进程，跑多久与上游无关：挂着的时候同样不该被说成
// 「上游没有响应」，所以也要进快照。
func TestLocalBusyTracksHooks(t *testing.T) {
	sess, fc, _ := startSession(t)
	defer sess.Close()

	fc.send(map[string]any{
		"type":       "system",
		"subtype":    "hook_started",
		"hook_id":    "h1",
		"hook_name":  "fmt",
		"hook_event": "PostToolUse",
	})
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && len(sess.LocalBusy().Hooks) == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	if got := sess.LocalBusy().Hooks; len(got) != 1 || got[0] != "h1" {
		t.Fatalf("hook 表 = %v", got)
	}

	fc.send(map[string]any{"type": "system", "subtype": "hook_response", "hook_id": "h1", "outcome": "success"})
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) && len(sess.LocalBusy().Hooks) > 0 {
		time.Sleep(5 * time.Millisecond)
	}
	if got := sess.LocalBusy().Hooks; len(got) != 0 {
		t.Fatalf("hook 结束后仍在表里: %v", got)
	}
}

// 没有 hook_id 的帧配不上结束，记下来就再也清不掉。
func TestLocalBusyIgnoresHookWithoutID(t *testing.T) {
	sess, fc, _ := startSession(t)
	defer sess.Close()

	fc.send(map[string]any{"type": "system", "subtype": "hook_started", "hook_name": "fmt"})
	time.Sleep(50 * time.Millisecond)
	if got := sess.LocalBusy().Hooks; len(got) != 0 {
		t.Fatalf("没有 hook_id 时不该记账: %v", got)
	}
}

// 结束之后可能还有排队的进度帧在路上：task_progress / task_updated 不能把早就跑完的
// 任务重新列进「进行中」，否则中止按钮指向一个已经不存在的 task。
func TestLiveTasksDoesNotResurrectFinishedTask(t *testing.T) {
	sess, fc, _ := startSession(t)
	defer sess.Close()

	fc.send(map[string]any{
		"type": "system", "subtype": "task_started", "task_id": "task-1", "tool_use_id": "toolu_01",
	})
	waitTasks(t, sess, 1)
	fc.send(map[string]any{
		"type": "system", "subtype": "task_notification", "task_id": "task-1", "status": "completed",
	})
	waitTasks(t, sess, 0)

	fc.send(map[string]any{"type": "system", "subtype": "task_progress", "task_id": "task-1"})
	fc.send(map[string]any{"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": map[string]any{"status": "running"}})
	time.Sleep(50 * time.Millisecond)
	if got := sess.LiveTasks(); len(got) != 0 {
		t.Fatalf("已结束的任务被后续进度帧复活了: %+v", got)
	}
}

// 同一个 task 结束又重开时，顺序表里不能留重复 id（否则随快照下发两份）。
func TestLiveTasksNoDuplicateAfterRestart(t *testing.T) {
	sess, fc, _ := startSession(t)
	defer sess.Close()

	start := map[string]any{"type": "system", "subtype": "task_started", "task_id": "task-1", "tool_use_id": "toolu_01"}
	fc.send(start)
	waitTasks(t, sess, 1)
	fc.send(map[string]any{"type": "system", "subtype": "task_notification", "task_id": "task-1", "status": "completed"})
	waitTasks(t, sess, 0)
	fc.send(start)
	waitTasks(t, sess, 1)
	if got := sess.LiveTasks(); len(got) != 1 {
		t.Fatalf("重开后下发了 %d 条: %+v", len(got), got)
	}
}

// waitTasks 等任务表的条数变成 want。
func waitTasks(t *testing.T, sess *Session, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if len(sess.LiveTasks()) == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("任务表 = %+v，want %d 条", sess.LiveTasks(), want)
}

// `/clear` 之后 CLI 会发一条带新 session_id 的 system/init：会话要认出来并广播
// session.replaced，上层据此把对话元数据迁到新 id。
//
// **以 system/init 为准，不用 conversation_reset 的 new_conversation_id**：
// 实测两者是不同的 UUID，且后者磁盘上没有转录。
func TestInitWithNewSessionIDReportsReplaced(t *testing.T) {
	sess, fc, rec := startSession(t)
	defer sess.Close()

	// 正常一轮的 init（与启动时同一个 id）：不该报「换了」。
	fc.send(map[string]any{
		"type":       "system",
		"subtype":    "init",
		"session_id": "s1",
		"tools":      []any{},
	})
	if _, ok := rec.wait(KindCLI, 2*time.Second); !ok {
		t.Fatal("没收到 init")
	}
	if n := rec.count(KindSessionReplaced); n != 0 {
		t.Fatalf("同一个 session id 不该报 replaced（%d 次）", n)
	}
	if got := sess.CLISessionID(); got != "s1" {
		t.Fatalf("CLISessionID = %q, want s1", got)
	}

	// /clear 之后的 init：新 id。
	fc.send(map[string]any{
		"type":       "system",
		"subtype":    "init",
		"session_id": "cleared-id",
		"tools":      []any{},
	})
	ev, ok := rec.wait(KindSessionReplaced, 2*time.Second)
	if !ok {
		t.Fatal("换了会话 id 却没有广播 session.replaced")
	}
	var payload map[string]any
	if err := json.Unmarshal(ev.Data, &payload); err != nil {
		t.Fatalf("载荷不是合法 JSON: %v", err)
	}
	if payload["from"] != "s1" || payload["to"] != "cleared-id" {
		t.Fatalf("载荷 = %+v", payload)
	}
	if got := sess.CLISessionID(); got != "cleared-id" {
		t.Fatalf("CLISessionID = %q, want cleared-id", got)
	}
}

// conversation_reset 本身不触发 session.replaced：它的 new_conversation_id
// 与之后真正用的 session_id 不同，拿它去迁移会指向一个不存在的转录。
func TestConversationResetAloneDoesNotReplaceSession(t *testing.T) {
	sess, fc, rec := startSession(t)
	defer sess.Close()

	fc.send(map[string]any{
		"type":                "conversation_reset",
		"trigger":             "clear",
		"new_conversation_id": "bogus-id",
		"session_id":          "s1",
	})
	// 哨兵：重置帧处理完之后再发一条，确保断言时前面的都处理完了。
	fc.send(map[string]any{"type": "system", "subtype": "informational", "content": "哨兵"})
	if _, ok := rec.wait(KindCLI, 2*time.Second); !ok {
		t.Fatal("没收到哨兵")
	}
	if n := rec.count(KindSessionReplaced); n != 0 {
		t.Fatalf("只凭 conversation_reset 就迁移了（%d 次）", n)
	}
	if got := sess.CLISessionID(); got != "s1" {
		t.Fatalf("CLISessionID = %q, want s1", got)
	}
}

// 启动时第一个 init 记下的 session_id 不能算「换了」——否则每次开会话都会误报
// 一次 session.replaced，上层会把对话元数据迁到一个并不存在的新 id 上。
//
// startSession 的握手走的是 Start() 里的 request()（不经过 handleLine），所以
// 这里覆盖的是「Start 之后第一个 init」这条真实路径。
func TestFirstInitAfterStartIsNotAReplacement(t *testing.T) {
	sess, fc, rec := startSession(t)
	defer sess.Close()

	fc.send(map[string]any{
		"type":       "system",
		"subtype":    "init",
		"session_id": "s1",
		"tools":      []any{},
	})
	fc.send(map[string]any{"type": "system", "subtype": "informational", "content": "哨兵"})
	if _, ok := rec.wait(KindCLI, 2*time.Second); !ok {
		t.Fatal("没收到哨兵")
	}
	if n := rec.count(KindSessionReplaced); n != 0 {
		t.Fatalf("第一个 init 被误判成换会话（%d 次）", n)
	}
}

// `session.replaced` 必须**投到旧 topic**，其余事件投到新 topic。
//
// 这条链路错一步症状都一样：界面在 /clear 之后看起来冻结。
//   - 换 id 的通知按新 id 发 → 订阅者还都在旧 topic 上，没人收到，前端不知道要换；
//   - 之后的正文按旧 id 发 → 前端已经把订阅（和界面）搬到新 id 了，一样收不到。
//
// 载荷里的 `from` 也必须是**更新前**那个 id：连续两次 /clear 时拿 s.ID 是启动时的值，
// 装配层会去迁一个已经不存在的对话。
func TestSessionReplacedRoutedToOldTopicThenNew(t *testing.T) {
	sess, fc, rec := startSession(t)
	defer sess.Close()

	// 第一次换 id：s1 → cleared-1。
	fc.send(map[string]any{
		"type":       "system",
		"subtype":    "init",
		"session_id": "cleared-1",
		"tools":      []any{},
	})
	if _, ok := rec.wait(KindSessionReplaced, 2*time.Second); !ok {
		t.Fatal("换了会话 id 却没有广播 session.replaced")
	}
	replaced := rec.topicOf(KindSessionReplaced)
	if replaced != "s1" {
		t.Fatalf("session.replaced 投到了 %q，want s1（订阅者还在旧 topic 上）", replaced)
	}
	// 换完之后，普通事件按新 id 走。
	fc.send(map[string]any{"type": "system", "subtype": "informational", "content": "换完之后的哨兵"})
	if _, ok := rec.wait(KindCLI, 2*time.Second); !ok {
		t.Fatal("没收到哨兵")
	}
	if got := rec.topicOf(KindCLI); got != "" {
		t.Fatalf("普通事件不该自己指定 topic（得到 %q）：路由由上层按 CurrentID 决定", got)
	}
	if got := sess.CurrentID(); got != "cleared-1" {
		t.Fatalf("CurrentID = %q，want cleared-1", got)
	}

	// 第二次换 id：cleared-1 → cleared-2。`from` 必须是中间那个，不是 s1。
	fc.send(map[string]any{
		"type":       "system",
		"subtype":    "init",
		"session_id": "cleared-2",
		"tools":      []any{},
	})
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && rec.count(KindSessionReplaced) < 2 {
		time.Sleep(5 * time.Millisecond)
	}
	if n := rec.count(KindSessionReplaced); n != 2 {
		t.Fatalf("第二次换 id 没广播（%d 次）", n)
	}
	ev, _ := rec.last(KindSessionReplaced)
	var payload struct{ From, To string }
	if err := json.Unmarshal(ev.Data, &payload); err != nil {
		t.Fatalf("载荷不是合法 JSON: %v", err)
	}
	if payload.From != "cleared-1" || payload.To != "cleared-2" {
		t.Fatalf("载荷 = %+v，want from=cleared-1 to=cleared-2", payload)
	}
	if got := rec.topicOf(KindSessionReplaced); got != "cleared-1" {
		t.Fatalf("第二次的 session.replaced 投到了 %q，want cleared-1", got)
	}
}

// s.ID 是创建时的 id，换过之后也不改：它是外部按 id 找这条会话的键，改了会让
// manager 的登记表与对象对不上。
func TestSessionIDStaysAtCreationValue(t *testing.T) {
	sess, fc, rec := startSession(t)
	defer sess.Close()

	fc.send(map[string]any{
		"type":       "system",
		"subtype":    "init",
		"session_id": "cleared-id",
		"tools":      []any{},
	})
	if _, ok := rec.wait(KindSessionReplaced, 2*time.Second); !ok {
		t.Fatal("没收到 session.replaced")
	}
	if sess.ID != "s1" {
		t.Fatalf("s.ID = %q，换 id 不该改它（用 CurrentID 读当前值）", sess.ID)
	}
	if got := sess.CurrentID(); got != "cleared-id" {
		t.Fatalf("CurrentID = %q，want cleared-id", got)
	}
}
