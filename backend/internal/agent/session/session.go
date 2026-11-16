// Package session 管理一条 claude 子进程会话的生命周期与消息流。
//
// 状态机：starting → ready ⇄ busy → closed
//   - starting：已 spawn，正在等 initialize 回包（CLI 在此之前不产出任何消息）。
//   - ready：握手完成，可以接收用户消息。
//   - busy：已发出一轮用户消息，尚未收到 result。
//   - closed：进程已退出或已被关闭。
package session

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"ccweb/backend/internal/agent/protocol"
)

// 会话状态。
const (
	StateStarting = "starting"
	StateReady    = "ready"
	StateBusy     = "busy"
	StateClosed   = "closed"
)

// InitTimeout 是等待 initialize 回包的上限。测试可以调小。
var InitTimeout = 30 * time.Second

// maxLineBytes 是单行 NDJSON 的上限（工具结果可能很长）。
// 变量而非常量：测试要把它调小来验证超长行的行为。
var maxLineBytes = 8 << 20

// Transport 是与会话后端通信的双工通道。
// 真实实现是子进程管道，测试用 net.Pipe 即可，无需真的拉起 claude。
type Transport interface {
	io.Reader
	io.Writer
	io.Closer
}

// Event 是会话向上层抛出的事件。
type Event struct {
	Kind string          `json:"kind"`
	Data json.RawMessage `json:"data"`
}

// 事件类型。
const (
	KindSessionReady = "session.ready"
	KindSessionState = "session.state"
	KindCLI          = "cli"
	KindPermission   = "permission"
	KindError        = "error"
	KindClosed       = "closed"
)

// pendingCall 是一次等待回包的控制请求。
//
// ch 只由读循环写、由 request 读，**永远不被 close**；done 只由 Close 关闭。
// 曾经在 Close 里 close(ch)，而读循环是「从 map 取出 ch 后就放手发送」，
// 两者交错会 panic（send on closed channel），panic 发生在读循环 goroutine 里
// 没有 recover，整个 ccweb 进程会跟着退出。现在关闭方只关 done，发送方 select 它。
type pendingCall struct {
	ch   chan json.RawMessage
	done chan struct{}
}

// Session 是一条会话。
type Session struct {
	ID        string
	Cwd       string
	CreatedAt time.Time

	tr   Transport
	emit func(Event)

	wmu     sync.Mutex // 串行化对 stdin 的写
	pmu     sync.Mutex
	pending map[string]*pendingCall

	closeOnce sync.Once
	done      chan struct{}

	state atomic.Value // string
	idle  atomic.Int64 // unix nano，最近一次活动时间

	initMu      sync.RWMutex
	initPayload json.RawMessage
}

// New 构造一个尚未握手的会话。调用方随后必须调用 Handshake。
func New(id, cwd string, tr Transport, emit func(Event)) *Session {
	s := &Session{
		ID:        id,
		Cwd:       cwd,
		CreatedAt: time.Now(),
		tr:        tr,
		emit:      emit,
		pending:   make(map[string]*pendingCall),
		done:      make(chan struct{}),
	}
	s.state.Store(StateStarting)
	s.idle.Store(time.Now().UnixNano())
	return s
}

// Start 启动读循环并完成 initialize 握手。
func (s *Session) Start() error {
	go s.readLoop()

	resp, err := s.request(protocol.Initialize(""), protocol.InitializeRequestID, InitTimeout)
	if err != nil {
		s.Close()
		return fmt.Errorf("session: initialize 失败: %w", err)
	}
	s.initMu.Lock()
	s.initPayload = resp
	s.initMu.Unlock()

	s.setState(StateReady)
	s.emitData(KindSessionReady, map[string]any{
		"id":      s.ID,
		"cwd":     s.Cwd,
		"init":    json.RawMessage(resp),
		"version": protocolVersion(resp),
	})
	return nil
}

// protocolVersion 从 initialize 回包里取 claude_code_version，取不到返回空。
func protocolVersion(resp json.RawMessage) string {
	var v struct {
		Version string `json:"claude_code_version"`
	}
	_ = json.Unmarshal(resp, &v)
	return v.Version
}

// InitPayload 返回 initialize 回包原文。
func (s *Session) InitPayload() json.RawMessage {
	s.initMu.RLock()
	defer s.initMu.RUnlock()
	return s.initPayload
}

// State 返回当前状态。
func (s *Session) State() string {
	if v, ok := s.state.Load().(string); ok {
		return v
	}
	return StateClosed
}

// LastActive 返回最近一次活动时间。
func (s *Session) LastActive() time.Time {
	return time.Unix(0, s.idle.Load())
}

func (s *Session) setState(st string) {
	if s.State() == st {
		return
	}
	s.state.Store(st)
	s.emitData(KindSessionState, map[string]any{"id": s.ID, "state": st})
}

// Prompt 发送一条用户文本消息。
func (s *Session) Prompt(text string) error {
	return s.PromptWithAttachments(text, nil)
}

// PromptWithAttachments 发送文本 + 文件/图片（图片走原生 image block）。
func (s *Session) PromptWithAttachments(text string, attachments []protocol.Attachment) error {
	if s.State() == StateClosed {
		return errors.New("session: 会话已关闭")
	}
	if text == "" && len(attachments) == 0 {
		return errors.New("session: 消息不能为空")
	}
	if err := s.writeLine(protocol.UserMessage(text, attachments)); err != nil {
		return err
	}
	s.setState(StateBusy)
	return nil
}

// Interrupt 中断当前回合。
func (s *Session) Interrupt() error {
	return s.writeLine(protocol.ControlRequest("ccweb-interrupt", protocol.SubtypeInterrupt))
}

// SetModel 切换模型。
func (s *Session) SetModel(model string) error {
	if model == "" {
		return errors.New("session: model 为空")
	}
	return s.writeLine(protocol.SetModel("ccweb-model", model))
}

// StopTask 停止一个后台任务（子代理、后台命令）。
//
// 不等回包：停止是单向意图，CLI 会再发 task_notification 告诉我们结果；
// 等回包会让 HTTP 请求挂在这里。
func (s *Session) StopTask(taskID string) error {
	if taskID == "" {
		return errors.New("session: task_id 为空")
	}
	return s.writeLine(protocol.StopTask("ccweb-stop-"+taskID, taskID))
}

// BackgroundTasks 把前台任务转到后台；toolUseID 为空表示全部前台任务。
func (s *Session) BackgroundTasks(toolUseID string) error {
	return s.writeLine(protocol.BackgroundTasks("ccweb-bg-"+toolUseID, toolUseID))
}

// SetPermissionMode 切换权限模式。
func (s *Session) SetPermissionMode(mode string) error {
	if mode == "" {
		return errors.New("session: mode 为空")
	}
	return s.writeLine(protocol.SetPermissionMode("ccweb-permmode", mode))
}

// PermissionReply 是一次审批的完整决定。
type PermissionReply struct {
	Allow              bool
	UpdatedInput       json.RawMessage
	UpdatedPermissions json.RawMessage
	Message            string
}

// ReplyPermission 回写一次工具审批结果。
func (s *Session) ReplyPermission(requestID string, r PermissionReply) error {
	if requestID == "" {
		return errors.New("session: request_id 为空")
	}
	var line []byte
	if r.Allow {
		line = protocol.AllowWith(requestID, r.UpdatedInput, r.UpdatedPermissions)
	} else {
		line = protocol.Deny(requestID, r.Message)
	}
	return s.writeLine(line)
}

// Close 关闭会话（幂等）。
func (s *Session) Close() error {
	s.closeOnce.Do(func() {
		close(s.done)
		s.setState(StateClosed)
		_ = s.tr.Close()
		s.pmu.Lock()
		for k, call := range s.pending {
			close(call.done)
			delete(s.pending, k)
		}
		s.pmu.Unlock()
		s.emitData(KindClosed, map[string]any{"id": s.ID})
	})
	return nil
}

// Done 在会话关闭时关闭。
func (s *Session) Done() <-chan struct{} { return s.done }

// writeLine 写一行 NDJSON。写操作必须串行，否则两条消息会交错。
func (s *Session) writeLine(b []byte) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	if _, err := s.tr.Write(append(b, '\n')); err != nil {
		return fmt.Errorf("session: 写入失败: %w", err)
	}
	s.idle.Store(time.Now().UnixNano())
	return nil
}

// request 发送一条控制请求并等待其回包。
func (s *Session) request(line []byte, requestID string, timeout time.Duration) (json.RawMessage, error) {
	call := &pendingCall{ch: make(chan json.RawMessage, 1), done: make(chan struct{})}
	s.pmu.Lock()
	if _, dup := s.pending[requestID]; dup {
		s.pmu.Unlock()
		return nil, fmt.Errorf("session: request_id %q 重复", requestID)
	}
	s.pending[requestID] = call
	s.pmu.Unlock()

	if err := s.writeLine(line); err != nil {
		s.removePending(requestID)
		return nil, err
	}

	select {
	case resp := <-call.ch:
		return resp, nil
	case <-time.After(timeout):
		s.removePending(requestID)
		return nil, fmt.Errorf("session: 等待 %q 回包超时（%s）", requestID, timeout)
	case <-s.done:
		return nil, errors.New("session: 会话已关闭")
	}
}

func (s *Session) removePending(id string) {
	s.pmu.Lock()
	delete(s.pending, id)
	s.pmu.Unlock()
}

// readLoop 持续读取 CLI 输出并分发事件。
func (s *Session) readLoop() {
	defer func() {
		// 读循环结束意味着进程退出/管道断开。
		s.Close()
	}()

	sc := bufio.NewScanner(s.tr)
	sc.Buffer(make([]byte, 0, 64*1024), maxLineBytes)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		s.idle.Store(time.Now().UnixNano())
		s.handleLine(line)
	}
	// Scan 返回 false 也可能是「行太长」而不是 EOF。不检查 Err 的话会话会
	// 无声无息地 close，前端只看到一条 closed，根本不知道发生了什么。
	if err := sc.Err(); err != nil {
		s.emitData(KindError, map[string]any{
			"message": fmt.Sprintf("读取 claude 输出中断：%v（单行上限 %d 字节）", err, maxLineBytes),
		})
	}
}

func (s *Session) handleLine(line []byte) {
	env, err := protocol.Decode(line)
	if err != nil {
		// CLI 偶尔会在 stdout 上混进非 JSON 行（警告、调试输出）。原样塞进 cli 事件
		// 会因为 json.Marshal 校验失败变成一条「json: error calling MarshalJSON」的
		// 错误提示，用户既看不懂也丢掉了原文。转成 system 文本，前端会当普通输出显示。
		s.emitData(KindCLI, map[string]any{
			"type":    "system",
			"subtype": "stdout",
			"content": string(line),
		})
		return
	}

	switch env.Type {
	case protocol.TypeControlResponse:
		// request_id 在 response.request_id，不在顶层。
		s.pmu.Lock()
		call, ok := s.pending[env.RespRequestID]
		if ok {
			delete(s.pending, env.RespRequestID)
		}
		s.pmu.Unlock()
		if ok {
			select {
			case call.ch <- env.ResponsePayload():
			case <-call.done:
				// 会话在回包到达前已关闭：丢弃这条回包即可。
				// ch 从不被 close，这个 select 是「不会向已关闭 channel 发送」的唯一保证。
			}
		} else {
			// 无人认领的回包（例如审批回包）转给前端做审计。
			s.emitData(KindCLI, env.Raw)
		}

	case protocol.TypeControlRequest:
		if perm, ok := protocol.ParsePermission(env); ok {
			s.emitData(KindPermission, permPayload(perm))
			return
		}
		// 未实现的子类型必须显式回错，否则 CLI 会一直等。
		_ = s.writeLine(protocol.Unsupported(env.RequestID))

	case protocol.TypeResult:
		s.setState(StateReady)
		s.emitData(KindCLI, env.Raw)

	default:
		s.emitData(KindCLI, env.Raw)
	}
}

func permPayload(p protocol.PermissionRequest) any {
	return map[string]any{
		"request_id":             p.RequestID,
		"tool_name":              p.ToolName,
		"display_name":           p.DisplayName,
		"description":            p.Description,
		"input":                  json.RawMessage(p.Input),
		"blocked_path":           p.BlockedPath,
		"tool_use_id":            p.ToolUseID,
		"agent_id":               p.AgentID,
		"permission_suggestions": json.RawMessage(p.PermissionSuggestions),
	}
}

// emitData 把一个结构体编成 Event 交给上层；编码失败时降级为纯文本错误事件。
func (s *Session) emitData(kind string, v any) {
	if s.emit == nil {
		return
	}
	b, err := json.Marshal(v)
	if err != nil {
		b, _ = json.Marshal(map[string]string{"message": err.Error()})
		kind = KindError
	}
	s.emit(Event{Kind: kind, Data: b})
}
