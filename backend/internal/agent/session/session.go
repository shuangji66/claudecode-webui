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
	"strings"
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

// ModeTimeout 是等待 set_permission_mode 回包的上限。CLI 是本机进程、回包立刻到，
// 给小一点的值没坏处；超时不能让界面一直停在「已切换」的错觉里。
var ModeTimeout = 10 * time.Second

// TurnHandoffWindow 是「result 之后多久之内再来 init 算同一批投递」的窗口。
//
// 回合进行中写进 stdin 的用户消息（插话）如果这轮已经收尾，CLI 会先发 result、
// 紧接着再发一条 system/init 把那条消息当成新的一轮跑。窗口取得足够大（正常是几十
// 毫秒），又不至于把「空闲很久之后模型自己起的一轮」也算进来。
var TurnHandoffWindow = 15 * time.Second

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
//
// Seq 是这条事件在**本会话**里的单调序号，供断线重连补发使用（见 Replay）：
// 前端记住处理过的最大 Seq，重连时带上它，后端把这段空缺按原顺序补回去。
// 只有会话自己产生的事件有 Seq；网关直发的错误回包之类不需要。
type Event struct {
	Kind string          `json:"kind"`
	Data json.RawMessage `json:"data"`
	Seq  uint64          `json:"seq,omitempty"`
}

// 事件重放缓冲的下限。
//
// 断线期间 CLI 照样在跑，一轮长任务能产出上百条事件（流式增量、工具调用与结果）。
// 缓冲只回答一个问题：「刚才断的那一小会儿漏了什么」。超出上限就说明缺得太多，
// 由调用方退回整份转录回放（Replay 返回 ok=false）——宁可重画一遍，也不要给出
// 一段中间有空缺的消息流。
//
// 变量而非常量：测试要把它调小来验证淘汰行为。
var (
	replayMaxEvents = 4096
	replayMaxBytes  = 4 << 20
)

// 事件类型。
const (
	KindSessionReady = "session.ready"
	KindSessionState = "session.state"
	KindCLI          = "cli"
	KindPermission   = "permission"
	// KindPermissionResolved 通知所有观察该会话的连接：这条审批已经有结论了。
	// 审批是**会话级**事实而不是浏览器本地状态——同一时刻可能有好几台设备/
	// 好几个标签页都收到了同一个 can_use_tool，其中一台批准之后，CLI 只会
	// 继续往下跑，不会再发任何东西暗示「这条已经处理完」，所以必须由后端广播。
	KindPermissionResolved = "permission.resolved"
	KindError              = "error"
	KindClosed             = "closed"
)

// writeReq 是一条待写入 stdin 的行；ack 非空时调用方等待写入结果。
type writeReq struct {
	line []byte
	ack  chan error
}

// pendingCall 是一次等待回包的控制请求。
//
// ch 只由读循环写、由 request 读，**永远不被 close**；done 只由 Close 关闭。
// 曾经在 Close 里 close(ch)，而读循环是「从 map 取出 ch 后就放手发送」，
// 两者交错会 panic（send on closed channel），panic 发生在读循环 goroutine 里
// 没有 recover，整个 ccweb 进程会跟着退出。现在关闭方只关 done，发送方 select 它。
type pendingCall struct {
	ch   chan controlResponse
	done chan struct{}
}

// controlResponse 是一条控制回包。subtype 必须一起带上：
// CLI 拒绝请求时回 subtype=error 且载荷为空，只看载荷会把失败当成功。
type controlResponse struct {
	payload json.RawMessage
	subtype string
	errText string
}

// Session 是一条会话。
type Session struct {
	ID        string
	Cwd       string
	CreatedAt time.Time

	tr   Transport
	emit func(Event)

	wmu sync.Mutex // 串行化对 stdin 的写
	// send 是写队列：读循环里要回控制响应（例如未实现的子类型回 unsupported），
	// 但写 stdin 可能被对端不读而阻塞 —— 在读循环里同步写会把「读 stdout」也一起卡死。
	// 所有写都投给 writer goroutine，读循环只做非阻塞入队。
	send    chan writeReq
	pmu     sync.Mutex
	pending map[string]*pendingCall

	closeOnce sync.Once
	done      chan struct{}

	state atomic.Value // string
	idle  atomic.Int64 // unix nano，最近一次活动时间

	initMu      sync.RWMutex
	initPayload json.RawMessage

	// mode 是 CLI 最近一次报上来的权限模式。界面「当前模式」以它为准：
	// 模型自己 ExitPlanMode、用户在别处切换、重连后进程换了默认模式，都只在这里体现。
	modeMu sync.RWMutex
	mode   string

	// seq 给「一次性的控制请求」发号：request_id 重复会让 pending 表互相覆盖
	// （set_permission_mode 尤其明显——用户可能在几秒内连点两下档位）。
	seq atomic.Uint64

	// permMu/perms 记录「已下发给前端、还没收到决定」的审批请求。
	// WS 重连时要把它们重放出去：不重放的话刷新页面就再也点不到那个审批，
	// 而 CLI 仍在 can_use_tool 上挂着（进程与内存一直占着）。
	permMu    sync.Mutex
	perms     map[string]json.RawMessage
	permOrder []string

	// resultAt 是最近一条 result 的到达时间（unix nano，0 表示还没有）。
	// 只用来判断「result 之后紧跟着的 init 是不是同一批投递」，见 TurnHandoffWindow。
	resultAt atomic.Int64

	// interjected 记录「上一次写 stdin 的是一条插话」，用来识别紧随其后的交棒 result。
	//
	// 插话没赶上当前回合时，CLI 会先把被打断的这一段收尾（发 result）、再开新一轮跑
	// 插话。那条 result 到达时，界面上的会话状态不该立刻回到 ready：前端据此画发送键、
	// 计时行、收起行，还会让待发送队列以为「这一轮完了」而把队首发出去。正常几十毫秒
	// 内就会来 system/init 把状态推回 busy，但那一帧已经够跳一下了。
	//
	// **用计数器而不是布尔**：设标记发生在写 stdin 的 goroutine，清标记在读循环，
	// 两者没有先后保证——普通 prompt 那条路径事后到达的 assistant 帧会把一条刚写下
	// 的插话标记清掉。现在记下写插话那一刻已经处理过的内容序号，result 到达时只要
	// 序号没变，就说明插话之后确实什么都没产出。
	interjectMu sync.Mutex
	interjected bool
	// contentSeq 是读循环已处理的内容帧计数（assistant / stream_event）。
	contentSeq uint64
	// interjectSeq 是写插话那一刻的 contentSeq。
	interjectSeq uint64

	// taskMu/tasks 记录「还没结束的后台任务」的 task_id ↔ tool_use_id。
	// 前端从消息流现算任务列表，但 `task_id` 只出现在实时的 task_started 里：
	// 中途连上来的设备只有转录回放，拿不到它，界面上那些「进行中」的后台操作
	// 就没有 task_id 可以发 stop_task。所以后端按会话记一份，随 session.snapshot
	// 下发（与挂起的审批同一类「重连也要能继续操作」的状态）。
	taskMu sync.Mutex
	tasks  map[string]taskRef
	// taskOrder 保证下发顺序稳定（= 启动顺序），不依赖 map 遍历。
	taskOrder []string

	// replayMu/replay 是**有界的事件重放缓冲**，只给断线重连补空缺用。
	//
	// WS 断开期间 CLI 不会停：assistant 正文、工具结果、回合结束的 result（本轮用量
	// 与耗时全在它上面）都照常产生，而 hub 只发给当前订阅者。前端重连后只拿到一份
	// session.snapshot（状态/审批/后台任务），消息流是空的——于是"断网期间跑完的那一轮"
	// 只在刷新页面（整份转录回放）之后才出现。这里把最近的事件留着，让网关能按
	// 前端记下的 seq 把空缺补回去（见 Replay）。
	replayMu  sync.Mutex
	replay    []Event
	replaySeq uint64
	// replayBytes 是缓冲里 Data 的总字节数，用来给 replayMaxBytes 兜底。
	replayBytes int
	// epoch 标识「这条会话对象的身份」。前端把它和 seq 一起记着：进程被重启/回收后
	// 用同一个 UUID 重新 --resume，seq 会从头开始，光比 seq 会把一次"新进程的第 5 条"
	// 当成"老进程的第 5 条"补上去（内容完全对不上）。epoch 变了就整份重放转录。
	epoch string
}

// taskRef 是一个后台任务的标识与展示信息。
//
// 带 description / task_type 而不只是 id：中途连上来的设备拿不到 task_started，
// 只回 id 的话它那边只能显示一串 agent id，与一直在线的设备对不上。
type taskRef struct {
	TaskID    string `json:"task_id"`
	ToolUseID string `json:"tool_use_id,omitempty"`
	// Description 是 task_started 给的「这件事在做什么」。
	Description string `json:"description,omitempty"`
	// TaskType 区分 local_agent（子代理）/ local_bash（后台命令）/ mcp_task 等。
	TaskType string `json:"task_type,omitempty"`
	// SubagentType 只有子代理任务才有。
	SubagentType string `json:"subagent_type,omitempty"`
	// Background 对应 task_started 的 is_backgrounded。
	Background bool `json:"background,omitempty"`
	// Ambient 是「不算活动」的后台任务（观察者之类），界面不该列出来。
	Ambient bool `json:"ambient,omitempty"`
}

// New 构造一个尚未握手的会话。调用方随后必须调用 Handshake。
func New(id, cwd string, tr Transport, emit func(Event)) *Session {
	s := &Session{
		ID:        id,
		Cwd:       cwd,
		CreatedAt: time.Now(),
		tr:        tr,
		emit:      emit,
		send:      make(chan writeReq, 64),
		pending:   make(map[string]*pendingCall),
		perms:     make(map[string]json.RawMessage),
		tasks:     make(map[string]taskRef),
		done:      make(chan struct{}),
		epoch:     newEpoch(),
	}
	s.state.Store(StateStarting)
	s.idle.Store(time.Now().UnixNano())
	go s.writeLoop()
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
	// subtype=error 时载荷是空的。不认这个分支，握手失败会被当成成功：
	// 会话进入假 ready，用户发消息后 CLI 一个字节都不回，也永远没有 result。
	if resp.subtype == "error" || len(resp.payload) == 0 {
		s.Close()
		reason := resp.errText
		if reason == "" {
			reason = "CLI 没有返回 initialize 载荷"
		}
		return fmt.Errorf("session: initialize 被 claude 拒绝: %s", reason)
	}
	s.initMu.Lock()
	s.initPayload = resp.payload
	s.initMu.Unlock()
	if mode := protocol.InitPermissionMode(resp.payload); mode != "" {
		s.setMode(mode)
	}

	s.setState(StateReady)
	s.emitData(KindSessionReady, map[string]any{
		"id":      s.ID,
		"cwd":     s.Cwd,
		"init":    json.RawMessage(resp.payload),
		"version": protocolVersion(resp.payload),
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

// setMode 记录 CLI 报上来的权限模式。
func (s *Session) setMode(mode string) {
	s.modeMu.Lock()
	s.mode = mode
	s.modeMu.Unlock()
}

// Mode 返回 CLI 最近一次报上来的权限模式；还没拿到时为空。
func (s *Session) Mode() string {
	s.modeMu.RLock()
	defer s.modeMu.RUnlock()
	return s.mode
}

// justFinishedTurn 表示最近一条 result 还在 TurnHandoffWindow 之内。
func (s *Session) justFinishedTurn() bool {
	at := s.resultAt.Load()
	if at == 0 {
		return false
	}
	return time.Since(time.Unix(0, at)) <= TurnHandoffWindow
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
//
// 帧带 origin:{kind:"human"}：这条消息是用户亲手打的，CLI 需要它来正确归属
// （缺了 origin 会被当成未标明来源，依赖「人类提示词」的检查不认）。
func (s *Session) PromptWithAttachments(text string, attachments []protocol.Attachment) error {
	return s.prompt(text, attachments, protocol.PromptOptions{Human: true})
}

// PromptInterject 在回合进行中写入一条「插话」。
//
// priority=now + origin=human（CLI ≥ 2.1.286）：能后台化的工具（shell 命令、
// 子代理、MCP 调用，2.1.287 起还有 WebFetch/WebSearch）被挪到后台，消息**并入
// 当前回合**立刻被读到；挪不动（例如正在写正文或某个不能后台的工具）时 CLI 会
// 中断这一轮，把消息放到下一轮。只写 user 帧、不带这两个字段的话，CLI 只能按
// 默认的 next 处理：本轮收尾后才轮得到，看起来就跟排队一样。
func (s *Session) PromptInterject(text string, attachments []protocol.Attachment) error {
	return s.prompt(text, attachments, protocol.PromptOptions{Priority: "now", Human: true})
}

func (s *Session) prompt(text string, attachments []protocol.Attachment, opt protocol.PromptOptions) error {
	if s.State() == StateClosed {
		return errors.New("session: 会话已关闭")
	}
	if text == "" && len(attachments) == 0 {
		return errors.New("session: 消息不能为空")
	}
	if err := s.writeLine(protocol.UserMessageWith(text, attachments, opt)); err != nil {
		return err
	}
	// 插话之后紧跟的 result 是交棒（CLI 把它留到下一轮），不该把状态标回 ready。
	//
	// **只有插话才动这个标记**：普通 prompt 也在这里无条件赋值的话，用户「插一句、
	// 紧接着又发一条」就会把刚写下的标记清成 false，随后 CLI 为插话发的那条交棒
	// result 被当成真结束——界面先闪一下「已完成」再被新一轮推翻（正是这个标记要
	// 解决的现象）。普通 prompt 不写标记，也就不该清它。
	if opt.Priority == "now" {
		s.interjectMu.Lock()
		s.interjected = true
		s.interjectSeq = s.contentSeq
		s.interjectMu.Unlock()
	}
	s.setState(StateBusy)
	return nil
}

// takeInterjected 取出「刚写过一条插话、且之后还没产出任何内容」的判定结果。
//
// 调用方是 result 分支：只有紧跟在插话之后、且插话之后还没产出内容的那条 result 才算
// 交棒。判完就地清掉——同一个标记不能被后面第二条 result 再认一次。
func (s *Session) takeInterjected() bool {
	s.interjectMu.Lock()
	defer s.interjectMu.Unlock()
	was := s.interjected && s.contentSeq == s.interjectSeq
	s.interjected = false
	return was
}

// noteContent 记录「读循环又处理了一条内容帧」（assistant / stream_event）。
//
// 插话之后只要产出了内容，就说明这一轮又跑起来了（CLI 把它并进了当前回合）：那时
// 标记必须失效，否则这一轮真正的 result 会被误判成交棒，收起行永远不出现。
func (s *Session) noteContent() {
	s.interjectMu.Lock()
	s.contentSeq += 1
	s.interjectMu.Unlock()
}

// Interrupt 中断当前回合。
//
// 这一轮的审批随回合一起作废：CLI 已经不再需要它们，留着只会让人点到一条失效回包。
// 单设备上界面是本地清掉的，但别的设备看不到这个动作——所以清完还要广播
// permission.resolved，否则那台设备上的卡片永远挂着。
func (s *Session) Interrupt() error {
	err := s.writeLine(protocol.ControlRequest("ccweb-interrupt", protocol.SubtypeInterrupt))
	if err == nil {
		s.clearPermissions()
	}
	return err
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
//
// claude 支持**会话进行中**切换（控制协议 set_permission_mode）：实测 2.1.325
// 在接受请求后立刻回 success，并发一条 system/status 带上新的 permissionMode；
// 已经发出、正在跑的那一轮不受影响，之后的工具判定与下一次请求按新模式走。
//
// 回包必须等：取值非法时 CLI 只在回包里说明原因（"must be one of ..."），
// 丢掉回包就等于让界面永远显示「切成功了」。
func (s *Session) SetPermissionMode(mode string) error {
	if mode == "" {
		return errors.New("session: mode 为空")
	}
	id := s.nextControlID("permmode")
	resp, err := s.request(protocol.SetPermissionMode(id, mode), id, ModeTimeout)
	if err != nil {
		return err
	}
	if resp.subtype == "error" || resp.errText != "" {
		reason := resp.errText
		if reason == "" {
			reason = "claude 没有说明原因"
		}
		return fmt.Errorf("session: 切换权限模式失败: %s", reason)
	}
	return nil
}

// nextControlID 生成一次性的控制请求 id。
func (s *Session) nextControlID(prefix string) string {
	return fmt.Sprintf("ccweb-%s-%d", prefix, s.seq.Add(1))
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
	defer s.forgetPermission(requestID)
	return s.writeLine(line)
}

// PendingPermissions 返回仍在等待用户决定的审批请求（原始载荷，按到达顺序）。
func (s *Session) PendingPermissions() []json.RawMessage {
	s.permMu.Lock()
	defer s.permMu.Unlock()
	if len(s.perms) == 0 {
		return nil
	}
	out := make([]json.RawMessage, 0, len(s.permOrder))
	for _, id := range s.permOrder {
		if raw, ok := s.perms[id]; ok {
			out = append(out, raw)
		}
	}
	return out
}

// LiveTasks 返回还没结束的后台任务（task_id ↔ tool_use_id），按启动顺序。
//
// 只给「重连/中途加入的连接」用：前端从消息流现算列表，但 task_id 只在实时的
// task_started 里出现，转录回放里没有——不补这一份，中途进来的设备看到的
// 「进行中」条目就没有 task_id 可发 stop_task，按钮点了也没用。
func (s *Session) LiveTasks() []taskRef {
	s.taskMu.Lock()
	defer s.taskMu.Unlock()
	if len(s.tasks) == 0 {
		return nil
	}
	out := make([]taskRef, 0, len(s.tasks))
	for _, id := range s.taskOrder {
		if ref, ok := s.tasks[id]; ok {
			out = append(out, ref)
		}
	}
	return out
}

// noteTaskEvent 按 system/task_* 维护后台任务表。
//
// 结束的任务要摘掉而不是留着「最后一次状态」：这张表只回答「现在还能中止哪些」，
// 留着的条目会让界面在中止按钮旁边一直挂着早就结束的 task_id。
func (s *Session) noteTaskEvent(raw json.RawMessage) {
	var msg struct {
		Subtype      string `json:"subtype"`
		TaskID       string `json:"task_id"`
		ToolUseID    string `json:"tool_use_id"`
		Status       string `json:"status"`
		Description  string `json:"description"`
		TaskType     string `json:"task_type"`
		SubagentType string `json:"subagent_type"`
		Background   *bool  `json:"is_backgrounded"`
		Ambient      *bool  `json:"ambient"`
		Patch        struct {
			Status     string `json:"status"`
			Background *bool  `json:"is_backgrounded"`
		} `json:"patch"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		return
	}
	if msg.TaskID == "" {
		return
	}
	done := msg.Status != "" && msg.Status != "running" ||
		msg.Patch.Status != "" && msg.Patch.Status != "running"
	if done {
		s.taskMu.Lock()
		delete(s.tasks, msg.TaskID)
		// taskOrder 里那条也要摘掉：留着的话同一个 id 会在下次 task_started 时被
		// 当成「已存在」而不追加、却在 LiveTasks 里被遍历两次（map 查得到就发两份），
		// 界面上的后台操作会凭空多出一条同名条目。
		s.taskOrder = removeTaskID(s.taskOrder, msg.TaskID)
		s.taskMu.Unlock()
		return
	}
	// **已经结束过的任务不能被后续的 task_progress / task_updated 复活**：
	// 结束（task_notification）之后可能还有排队的进度帧在路上，按「见到就记」
	// 会把早就跑完的任务重新列进「进行中」，中止按钮指向一个已经不存在的 task。
	// 表里没有、且这条也不是 task_started 的，一律忽略。
	s.taskMu.Lock()
	if _, known := s.tasks[msg.TaskID]; !known && msg.Subtype != "task_started" {
		s.taskMu.Unlock()
		return
	}
	if _, dup := s.tasks[msg.TaskID]; !dup {
		s.taskOrder = append(s.taskOrder, msg.TaskID)
	}
	ref := s.tasks[msg.TaskID]
	ref.TaskID = msg.TaskID
	// task_updated 不带 tool_use_id：保留先前记下的那个，别把它清空。
	if msg.ToolUseID != "" {
		ref.ToolUseID = msg.ToolUseID
	}
	if msg.Description != "" {
		ref.Description = msg.Description
	}
	if msg.TaskType != "" {
		ref.TaskType = msg.TaskType
	}
	if msg.SubagentType != "" {
		ref.SubagentType = msg.SubagentType
	}
	if msg.Background != nil {
		ref.Background = *msg.Background
	}
	if msg.Ambient != nil {
		ref.Ambient = *msg.Ambient
	}
	// 中途被转到后台（task_updated 的 patch.is_backgrounded）同样要记。
	if msg.Patch.Background != nil {
		ref.Background = *msg.Patch.Background
	}
	s.tasks[msg.TaskID] = ref
	s.taskMu.Unlock()
}

// removeTaskID 从顺序表里摘掉一个 id（保持其余顺序）。
func removeTaskID(order []string, id string) []string {
	for i, v := range order {
		if v == id {
			return append(order[:i], order[i+1:]...)
		}
	}
	return order
}

func (s *Session) rememberPermission(requestID string, raw json.RawMessage) {
	if requestID == "" {
		return
	}
	s.permMu.Lock()
	if _, dup := s.perms[requestID]; !dup {
		s.permOrder = append(s.permOrder, requestID)
	}
	s.perms[requestID] = raw
	s.permMu.Unlock()
}

// forgetPermission 把一条审批从挂起表里摘掉，并把结论广播给所有观察该会话的连接。
//
// 广播不能省：审批发出时是群发的（多设备/多标签各收到一份同一个 request_id），
// 但决定是某一条连接做的，CLI 拿到回包后只会继续往下跑，不会再发任何东西暗示
// 「这条已经处理完」。少了这条事件，其他设备上的卡片就永远消不掉、一直累积。
func (s *Session) forgetPermission(requestID string) {
	if !s.dropPermission(requestID) {
		return
	}
	s.emitData(KindPermissionResolved, map[string]any{"request_id": requestID})
}

// dropPermission 只动挂起表，不发事件；返回是否真的摘掉了一条。
// emit 必须留在锁外：订阅者写帧有超时，持锁广播会让读循环跟着等。
func (s *Session) dropPermission(requestID string) bool {
	s.permMu.Lock()
	defer s.permMu.Unlock()
	if _, ok := s.perms[requestID]; !ok {
		return false
	}
	delete(s.perms, requestID)
	for i, id := range s.permOrder {
		if id == requestID {
			s.permOrder = append(s.permOrder[:i], s.permOrder[i+1:]...)
			break
		}
	}
	return true
}

// clearPermissions 清空全部挂起审批并逐条广播结论（中断时整轮作废）。
func (s *Session) clearPermissions() {
	s.permMu.Lock()
	ids := append([]string(nil), s.permOrder...)
	s.perms = make(map[string]json.RawMessage)
	s.permOrder = nil
	s.permMu.Unlock()
	for _, id := range ids {
		s.emitData(KindPermissionResolved, map[string]any{"request_id": id})
	}
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
		s.permMu.Lock()
		s.perms = make(map[string]json.RawMessage)
		s.permOrder = nil
		s.permMu.Unlock()
		s.emitData(KindClosed, map[string]any{"id": s.ID})
	})
	return nil
}

// Done 在会话关闭时关闭。
func (s *Session) Done() <-chan struct{} { return s.done }

// writeLine 写一行 NDJSON。写操作必须串行，否则两条消息会交错。
func (s *Session) writeLine(b []byte) error {
	req := writeReq{line: append(b, '\n'), ack: make(chan error, 1)}
	select {
	case s.send <- req:
	case <-s.done:
		return errors.New("session: 会话已关闭")
	}
	select {
	case err := <-req.ack:
		return err
	case <-s.done:
		return errors.New("session: 会话已关闭")
	}
}

// writeAsync 只入队、不等待写入结果。用于读循环里的回包（失败的会话反正会被关掉）。
// 队列满说明对端长时间不读 stdin，此时会话已经不可用：直接关闭，别把读循环挂住。
func (s *Session) writeAsync(b []byte) {
	select {
	case s.send <- writeReq{line: append(b, '\n')}:
	case <-s.done:
	default:
		_ = s.Close()
	}
}

// writeLoop 串行写 stdin。写失败即关会话：stdin 断了等于会话结束。
func (s *Session) writeLoop() {
	for {
		select {
		case <-s.done:
			return
		case req := <-s.send:
			err := s.writeNow(req.line)
			if req.ack != nil {
				req.ack <- err
			}
			if err != nil {
				_ = s.Close()
				return
			}
		}
	}
}

func (s *Session) writeNow(b []byte) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	if _, err := s.tr.Write(b); err != nil {
		return fmt.Errorf("session: 写入失败: %w", err)
	}
	s.idle.Store(time.Now().UnixNano())
	return nil
}

// request 发送一条控制请求并等待其回包。
func (s *Session) request(line []byte, requestID string, timeout time.Duration) (controlResponse, error) {
	call := &pendingCall{ch: make(chan controlResponse, 1), done: make(chan struct{})}
	s.pmu.Lock()
	if _, dup := s.pending[requestID]; dup {
		s.pmu.Unlock()
		return controlResponse{}, fmt.Errorf("session: request_id %q 重复", requestID)
	}
	s.pending[requestID] = call
	s.pmu.Unlock()

	if err := s.writeLine(line); err != nil {
		s.removePending(requestID)
		return controlResponse{}, err
	}

	select {
	case resp := <-call.ch:
		return resp, nil
	case <-time.After(timeout):
		s.removePending(requestID)
		return controlResponse{}, fmt.Errorf("session: 等待 %q 回包超时（%s）", requestID, timeout)
	case <-s.done:
		return controlResponse{}, errors.New("session: 会话已关闭")
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
			case call.ch <- controlResponse{
				payload: env.ResponsePayload(),
				subtype: env.Subtype,
				errText: env.ResponseError(),
			}:
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
			payload := permPayload(perm)
			if raw, err := json.Marshal(payload); err == nil {
				s.rememberPermission(perm.RequestID, raw)
			}
			s.emitData(KindPermission, payload)
			return
		}
		// 未实现的子类型必须显式回错，否则 CLI 会一直等。
		// 这里在读循环 goroutine 上，只能入队：同步写会让「读 stdout」跟着卡住。
		s.writeAsync(protocol.Unsupported(env.RequestID))

	case protocol.TypeResult:
		s.resultAt.Store(time.Now().UnixNano())
		// 紧跟在插话之后、且这一轮还没再产出任何内容的 result 是**交棒**：CLI 把插话
		// 留到下一轮了，几十毫秒后会来一条 system/init 把状态推回 busy（见下方 TypeSystem）。
		// 这一帧不标 ready：前端的发送键、计时行、收起行、待发送队列全都读这个状态，
		// 标了就会先闪一下「已完成 / 可以发送」，然后被 init 推翻（实测约 1 秒）。
		//
		// 出错 / 被中断的 result 是真的停了（用户按 Esc、API 报错）：照常标 ready，
		// 否则界面会一直以为还在跑。
		if !s.takeInterjected() || resultStopped(env.Raw) {
			s.setState(StateReady)
		}
		s.emitData(KindCLI, env.Raw)

	case protocol.TypeSystem:
		// 当前权限模式只有 CLI 说了算：切模式的回包之后跟一条 system/status，
		// 每个回合的 system/init 也带着 permissionMode；模型自己 ExitPlanMode
		// 同样会走到这里。界面据此对齐，而不是自己记一份可能过期的状态。
		if mode, ok := protocol.PermissionModeOf(env.Raw); ok {
			s.setMode(mode)
			s.emitData(KindSessionState, map[string]any{"mode": mode})
		}
		// 后台任务的 task_id 只在这条流里出现，记下来随快照发给后来连上的设备
		// （它们靠转录回放拿不到，见 LiveTasks）。
		if protocol.IsTaskEvent(env.Raw) {
			s.noteTaskEvent(env.Raw)
		}
		// 刚结束一轮又来了一条 init：这是我们写进去的插话没赶上本轮，CLI 把它
		// 当成新的一轮在跑。不认这个信号，界面会在整轮里显示「空闲」（发送按钮
		// 而不是中断按钮），待发送队列也会被提前放出去。
		if protocol.IsTurnInit(env.Raw) && s.State() == StateReady && s.justFinishedTurn() {
			s.setState(StateBusy)
		}
		s.emitData(KindCLI, env.Raw)

	default:
		// assistant / stream_event：插话之后又产出了内容，说明这一轮跑起来了（CLI 把
		// 插话并进了当前回合）。记下来，让后续那条 result 不被当成交棒。
		if env.Type == protocol.TypeAssistant || env.Type == protocol.TypeStreamEvent {
			s.noteContent()
		}
		s.emitData(KindCLI, env.Raw)
	}
}

// resultStopped 表示一条 result 是「真的停了」（出错 / 被中断），不是插话交棒。
//
// 判据与前端 `lib/queue.shouldFlushAfter`、`lib/normalize.applyResult` 同一套：
// is_error、中断诊断文本、或者 subtype 带 interrupt/abort/cancel。
func resultStopped(raw []byte) bool {
	var msg struct {
		IsError bool     `json:"is_error"`
		Subtype string   `json:"subtype"`
		Result  string   `json:"result"`
		Errors  []string `json:"errors"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		return false
	}
	if msg.IsError {
		return true
	}
	sub := strings.ToLower(msg.Subtype)
	if strings.Contains(sub, "interrupt") || strings.Contains(sub, "abort") || strings.Contains(sub, "cancel") {
		return true
	}
	texts := append([]string{msg.Result}, msg.Errors...)
	for _, t := range texts {
		trimmed := strings.TrimSpace(t)
		if strings.HasPrefix(trimmed, "[ede_diagnostic]") || strings.HasPrefix(trimmed, "[Request interrupted by user") {
			return true
		}
	}
	return false
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
//
// **不管有没有上层订阅者都要记进重放缓冲**：emit 为空只说明这一刻没有人在听
// （测试、或者网关还没接上），事件本身照样是会话历史的一部分，断线重连要补的
// 正是这一段。
func (s *Session) emitData(kind string, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		b, _ = json.Marshal(map[string]string{"message": err.Error()})
		kind = KindError
	}
	ev := s.record(Event{Kind: kind, Data: b})
	if s.emit == nil {
		return
	}
	s.emit(ev)
}

// record 给事件编号并放进重放缓冲，返回带 Seq 的事件。
func (s *Session) record(ev Event) Event {
	s.replayMu.Lock()
	defer s.replayMu.Unlock()
	s.replaySeq++
	ev.Seq = s.replaySeq
	s.replay = append(s.replay, ev)
	s.replayBytes += len(ev.Data)
	// 两头都要收：条数上限挡住"很多条小事件"，字节上限挡住"少数几条巨大事件"
	// （一次工具结果可以是几百 KB）。切掉的都是最旧的那些。
	for len(s.replay) > replayMaxEvents || (s.replayBytes > replayMaxBytes && len(s.replay) > 1) {
		s.replayBytes -= len(s.replay[0].Data)
		s.replay = s.replay[1:]
	}
	return ev
}

// newEpoch 生成一个会话对象身份串。
//
// 不用 UUID 库：这里只需要"同一个进程内不重复、跨进程重启也不同"。时间戳 + 计数器
// 足够，而且它是给前端做等值比较用的，不参与任何安全判定。
func newEpoch() string {
	epochSeed.Add(1)
	return fmt.Sprintf("%x-%x", time.Now().UnixNano(), epochSeed.Load())
}

var epochSeed atomic.Uint64

// Epoch 返回这条会话对象的身份串（见 Session.epoch）。
func (s *Session) Epoch() string { return s.epoch }

// Replay 从 sinceSeq 之后开始补发事件。
//
// sinceEpoch 是前端记下的会话身份：与当前不一致（进程被重启过，seq 从头开始）时
// 直接判为补不齐，调用方改为整份重放转录——否则会把新进程的前几条事件当成老进程
// 的续集拼上去，消息流彻底对不上。
func (s *Session) Replay(sinceEpoch string, sinceSeq uint64) ([]Event, bool) {
	if sinceEpoch != s.epoch {
		return nil, false
	}
	s.replayMu.Lock()
	defer s.replayMu.Unlock()
	// since 比当前序号还大：不是这条会话发出来的，同样不可信。
	if sinceSeq > s.replaySeq {
		return nil, false
	}
	if sinceSeq == s.replaySeq {
		return nil, true
	}
	// 缓冲里最旧的一条必须是 since+1；否则中间那段已经被淘汰，补不齐。
	if len(s.replay) == 0 || s.replay[0].Seq > sinceSeq+1 {
		return nil, false
	}
	out := make([]Event, 0, len(s.replay))
	for _, ev := range s.replay {
		if ev.Seq > sinceSeq {
			out = append(out, ev)
		}
	}
	return out, true
}

// Seq 返回当前已发出的最大事件序号（前端据此判断要不要补发）。
func (s *Session) Seq() uint64 {
	s.replayMu.Lock()
	defer s.replayMu.Unlock()
	return s.replaySeq
}
