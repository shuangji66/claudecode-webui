package gateway

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"ccweb/backend/internal/agent/protocol"
	"ccweb/backend/internal/agent/session"
	"ccweb/backend/internal/wsframe"
)

// writeTimeout 是单帧写超时：一个不读数据的客户端不能让写循环永久阻塞。
const writeTimeout = 5 * time.Second

// readIdleTimeout 是「完全没有上行帧」的容忍时间。
//
// WS 建在 unix socket 上，Go 的 TCP keepalive 保护不适用，代码里也没有读超时：
// 手机丢网、webview 被系统挂起这类半开连接既不报错也不关闭，handler 一直挂着。
// 前端每 20–25 秒发一次 ping，所以两分钟足够宽松，超时即让 handler 返回。
const readIdleTimeout = 2 * time.Minute

// sendQueueLen 是每个连接的上行队列长度。
//
// 关键约束：hub.Broadcast 跑在 session 的读循环 goroutine 上，所以 SendJSON
// 绝不能碰网络。事件只入队，真正的写由 writeLoop 负责；队列满说明客户端不读数据，
// 直接判连接不可用（hub 会退订并关闭它），代价只落在这个客户端身上。
const sendQueueLen = 256

// wsClient 是一条浏览器 WebSocket 连接，同时实现 hub.Client。
type wsClient struct {
	conn  net.Conn
	r     *bufio.Reader
	topic string

	out  chan []byte
	done chan struct{}

	wmu       sync.Mutex
	closed    atomic.Bool
	closeOnce sync.Once

	// watchMu 保护 watchCancel：系统通道上的 Git 订阅（git.watch）。
	// 一个连接同时只盯一个仓库——Git 面板是单例，换仓库就是换订阅。
	watchMu     sync.Mutex
	watchCancel context.CancelFunc
}

// setWatch 替换这条连接上的仓库观察者；nil 表示取消订阅。
func (c *wsClient) setWatch(cancel context.CancelFunc) {
	c.watchMu.Lock()
	prev := c.watchCancel
	c.watchCancel = cancel
	c.watchMu.Unlock()
	if prev != nil {
		prev()
	}
}

// newWSClient 建一条连接并启动写循环。
func newWSClient(conn net.Conn, r *bufio.Reader, topic string) *wsClient {
	c := &wsClient{
		conn:  conn,
		r:     r,
		topic: topic,
		out:   make(chan []byte, sendQueueLen),
		done:  make(chan struct{}),
	}
	go c.writeLoop()
	return c
}

// writeLoop 串行写帧。写失败（含 5s 超时）就直接关 socket 退出：
// 读循环那边会立刻拿到错误并走 close()，两边都不会把广播拖住。
func (c *wsClient) writeLoop() {
	for {
		select {
		case <-c.done:
			return
		case frame := <-c.out:
			c.wmu.Lock()
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			_, err := c.conn.Write(frame)
			c.wmu.Unlock()
			if err != nil {
				c.closed.Store(true)
				_ = c.conn.Close()
				return
			}
		}
	}
}

// SendJSON 发送一条事件；实现 hub.Client。
func (c *wsClient) SendJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.writeFrame(wsframe.OpText, b)
}

// writeFrame 把一帧放进发送队列（不阻塞调用方）。
func (c *wsClient) writeFrame(op byte, payload []byte) error {
	if c.closed.Load() {
		return errors.New("ws: 连接已关闭")
	}
	frame := wsframe.Encode(op, payload)
	select {
	case c.out <- frame:
		return nil
	default:
		// 队列满 = 客户端长期不读数据。直接关 socket：写循环会退出、读循环立刻拿到
		// 错误，handler 随之返回并释放 hub 订阅，不会留下半死不活的连接。
		c.closed.Store(true)
		_ = c.conn.Close()
		return errors.New("ws: 发送队列已满，客户端未消费数据")
	}
}

func (c *wsClient) close() {
	// 写失败会把 closed 置位（见 writeFrame）。此时 close() 仍然必须关闭 socket：
	// hijack 出来的连接不归 net/http 管，没人关它就一直占着 fd，长期运行会把
	// 进程的 fd 耗光（accept 报 too many open files，整个服务不可用）。
	// 所以这里的 once 只管「socket 只关一次」，不拿 closed 当早退条件。
	already := c.closed.Swap(true)
	c.closeOnce.Do(func() {
		close(c.done)
		if !already {
			c.wmu.Lock()
			_ = c.conn.SetWriteDeadline(time.Now().Add(time.Second))
			_, _ = c.conn.Write(wsframe.EncodeClose(1000))
			c.wmu.Unlock()
		}
		_ = c.conn.Close()
	})
}

// wireAttachment 是前端上行的一条附件（base64 编码）。
type wireAttachment struct {
	Name      string `json:"name"`
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
}

// clientCmd 是前端上行命令。
type clientCmd struct {
	Kind               string           `json:"kind"`
	Cwd                string           `json:"cwd,omitempty"`
	Text               string           `json:"text,omitempty"`
	Priority           string           `json:"priority,omitempty"`
	Attachments        []wireAttachment `json:"attachments,omitempty"`
	Model              string           `json:"model,omitempty"`
	Mode               string           `json:"mode,omitempty"`
	RequestID          string           `json:"request_id,omitempty"`
	Allow              *bool            `json:"allow,omitempty"`
	UpdatedInput       json.RawMessage  `json:"updated_input,omitempty"`
	UpdatedPermissions json.RawMessage  `json:"updated_permissions,omitempty"`
	Message            string           `json:"message,omitempty"`
}

// promptEcho 是广播给同一会话其他连接的「这条提示词已经发出去了」。
//
// 为什么需要它：用户气泡是**本地乐观插入**的（sendPrompt 先 appendUser 再等 CLI），
// 而 CLI 不带 `--replay-user-messages` 时不会回显 stdin 里的消息。于是别的设备/
// 标签只看到模型突然开始思考，用户发的那句话凭空消失——这正是「另一台设备上看不到
// 我刚发的内容」。这里在写进 stdin 成功后把它广播出去，别的连接按内容去重后补一条
// 气泡（已经本地插过的连接会命中 samePromptEcho，不会重复）。
//
// 带上附件名与图片：图片本体走 data URL（与 UserBubble 的渲染输入一致），
// 不带的话对方只能看到「图片」占位。「附件：」这类文案由前端按自己的界面语言拼。
type promptEcho struct {
	Text  string      `json:"text"`
	Files []string    `json:"files,omitempty"`
	Image []echoImage `json:"images,omitempty"`
	// Interjected 标记这条是插话（priority=now）：别的设备收到后要把它并进当前回合，
	// 而不是当成新的一轮——按它切轮会把这一轮的思考与工具调用劈成两半。
	Interjected bool `json:"interjected,omitempty"`
}

type echoImage struct {
	Name      string `json:"name"`
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
}

// handleWS 处理 /ws。
//
//	/ws?id=<session>  会话通道：该会话的事件（当前唯一的业务通道）
//	/ws               系统通道：只收应用级事件（claude 更新、对话列表变化），
//	                  并接受 git.watch / git.unwatch 两条订阅命令（推送 git.changed）
//
// 系统通道是独立一条连接，而不是把系统事件挂到会话通道上：会话连接随对话开关
// （关掉对话、换工作区、删对话都会断），而「有新版本」这件事与对话无关，
// 没有打开任何对话时也要能到。共用 /ws 而不是再开一个 SSE：鉴权（?token=）、
// 心跳、指数重连都已经在这里且经过前置网关注入的验证。
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if !s.d.Guard.Check(channelOf(r), r.Header.Get("Authorization"), r.URL.Query().Get("token")) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	id := r.URL.Query().Get("id")
	var sess *session.Session
	if id != "" {
		got, ok := s.d.Manager.Get(id)
		if !ok {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
		sess = got
	}
	conn, reader, err := upgradeWebSocket(w, r)
	if err != nil {
		return
	}

	topic := id
	if topic == "" {
		topic = systemTopic
	}
	c := newWSClient(conn, reader, topic)
	s.d.Hub.Subscribe(topic, c)
	defer func() {
		s.d.Hub.Unsubscribe(topic, c)
		// 连接断了就没人看图了：不停掉观察者，它会一直每几秒 spawn 一次 git。
		c.setWatch(nil)
		c.close()
	}()

	// 系统通道没有会话快照：连上即可用，首次状态由前端启动时的 /api/claude/status 拉。
	if sess == nil {
		for {
			_ = c.conn.SetReadDeadline(time.Now().Add(readIdleTimeout))
			op, payload, err := wsframe.ReadMessage(c.r, wsframe.DefaultMaxMessageBytes)
			if err != nil {
				return
			}
			switch op {
			case wsframe.OpText, wsframe.OpBinary:
				s.dispatch(c, nil, "", payload)
			case wsframe.OpPing:
				if err := c.writeFrame(wsframe.OpPong, payload); err != nil {
					return
				}
			case wsframe.OpClose:
				return
			}
		}
	}

	// 先发快照：后加入的连接也能立刻渲染出历史与 UI 目录。
	snapshot, _ := json.Marshal(map[string]any{
		"info": map[string]any{
			"id":    id,
			"cwd":   sess.Cwd,
			"state": sess.State(),
			// 重连后界面要显示「现在真的是哪个模式」，不能拿启动时的快照顶替：
			// 用户可能在会话里切过，模型也可能自己 ExitPlanMode。
			"mode": sess.Mode(),
		},
		"init": sess.InitPayload(),
		// 挂起审批要一起重放：刷新/重连后若拿不到它们，用户就再也点不到，
		// 而 CLI 一直挂在 can_use_tool 上等回包。
		"permissions": sess.PendingPermissions(),
		// 还没结束的后台任务（task_id ↔ tool_use_id）。列表仍由前端从消息流现算，
		// 但 task_id 只在实时的 task_started 里出现——中途连上来的设备只有转录回放，
		// 拿不到它就没法中止「进行中」的后台操作。
		"tasks": sess.LiveTasks(),
	})
	if err := c.SendJSON(WireEvent{Kind: "session.snapshot", SID: id, Data: snapshot}); err != nil {
		return
	}

	for {
		_ = c.conn.SetReadDeadline(time.Now().Add(readIdleTimeout))
		op, payload, err := wsframe.ReadMessage(c.r, wsframe.DefaultMaxMessageBytes)
		if err != nil {
			return
		}
		switch op {
		case wsframe.OpText, wsframe.OpBinary:
			s.dispatch(c, sess, id, payload)
		case wsframe.OpPing:
			if err := c.writeFrame(wsframe.OpPong, payload); err != nil {
				return
			}
		case wsframe.OpClose:
			return
		}
	}
}

// upgradeWebSocket 完成 RFC 6455 握手并交出原始连接。
//
// 与 /ws 共用：浏览器无法给 WebSocket 设置自定义头，鉴权必须在调用方
// 借 ?token= 完成后再升级。
func upgradeWebSocket(w http.ResponseWriter, r *http.Request) (net.Conn, *bufio.Reader, error) {
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		http.Error(w, "missing Sec-WebSocket-Key", http.StatusBadRequest)
		return nil, nil, errors.New("missing Sec-WebSocket-Key")
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return nil, nil, errors.New("hijack unsupported")
	}
	conn, brw, err := hj.Hijack()
	if err != nil {
		return nil, nil, err
	}
	handshake := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + wsframe.AcceptKey(key) + "\r\n\r\n"
	_ = conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	if _, err := conn.Write([]byte(handshake)); err != nil {
		_ = conn.Close()
		return nil, nil, err
	}
	_ = conn.SetWriteDeadline(time.Time{})
	return conn, brw.Reader, nil
}

func (s *Server) dispatch(c *wsClient, sess *session.Session, id string, payload []byte) {
	var cmd clientCmd
	if err := json.Unmarshal(payload, &cmd); err != nil {
		s.sendError(c, "命令解析失败: "+err.Error())
		return
	}
	if sess == nil {
		// 系统通道没有会话：只认心跳与 Git 订阅。其余命令一律报错，绝不能让
		// prompt 之类落到 nil 会话上——那是 panic，会带走整个网关进程。
		//
		// Git 订阅挂在系统通道而不是会话通道：Git 面板与「打开的是哪个对话」无关，
		// 而会话连接会随对话开关（关对话、换工作区、删对话）断开重连，
		// 那时订阅要重新建立一遍，面板会短暂失去推送。
		switch cmd.Kind {
		case "ping":
			_ = c.SendJSON(WireEvent{Kind: "pong"})
			return
		case "git.watch":
			// 与 /api/git/* 同一条围栏：只有授权目录里的仓库能被盯。
			cwd, cwdErr := s.authorizedCwd(cmd.Cwd)
			if cwdErr != nil {
				s.sendError(c, cwdErr.Error())
				return
			}
			s.startGitWatch(c, cwd)
			return
		case "git.unwatch":
			c.setWatch(nil)
			return
		}
		s.sendError(c, fmt.Sprintf("系统通道不接受命令 %q", cmd.Kind))
		return
	}
	var err error
	switch cmd.Kind {
	case "prompt":
		if cmd.Text == "" && len(cmd.Attachments) == 0 {
			s.sendError(c, "prompt 不能为空")
			return
		}
		atts, attErr := decodeAttachments(cmd.Attachments)
		if attErr != nil {
			s.sendError(c, attErr.Error())
			return
		}
		// priority=now 是「插话」：立刻写进 stdin 并要求 CLI 在当前回合读到它。
		// 只认这一个值——别的取值语义（later）前端用不到，静默降级会骗人。
		switch cmd.Priority {
		case "":
			err = sess.PromptWithAttachments(cmd.Text, atts)
		case "now":
			err = sess.PromptInterject(cmd.Text, atts)
		default:
			s.sendError(c, fmt.Sprintf("未知的 priority %q（只支持 now）", cmd.Priority))
			return
		}
		if err == nil {
			// 首条消息把对话落进持久化列表；后续消息刷新 last_active。
			if info, ok := s.conversationInfo(id); ok {
				s.touchConversation(info)
			}
			// 同一会话的别的连接看不到这条提示词（CLI 不回显 stdin）：广播一份，
			// 它们按内容去重后补上气泡。发送方自己也会收到，命中 samePromptEcho
			// 后丢弃——不靠「谁发的」，多标签页同时开同一条对话时更省事。
			s.broadcastPromptEcho(id, promptEchoOf(cmd))
		}
	case "interrupt":
		err = sess.Interrupt()
	case "model":
		err = sess.SetModel(cmd.Model)
	case "permission_mode":
		// **不能在这个读循环上等 CLI 的回包**（SetPermissionMode 会等，最长 ModeTimeout）。
		// 读循环是每条连接单线程的：等的时候同一连接后面的帧全被挡住，而其中最要命的
		// 是审批回包——CLI 可能正挂在 can_use_tool 上等它，于是「切模式」要等审批、
		// 「审批」要等切模式，白等一个超时。
		// 前端本来就不等这个结果：模式以 CLI 上报的 system/status 为准，
		// 失败用 error 事件回（writeFrame 只入队，从别的 goroutine 调是安全的）。
		go func(mode string) {
			if err := sess.SetPermissionMode(mode); err != nil {
				s.sendError(c, err.Error())
			}
		}(cmd.Mode)
		return
	case "permission":
		if cmd.RequestID == "" || cmd.Allow == nil {
			s.sendError(c, "permission 需要 request_id 与 allow")
			return
		}
		err = sess.ReplyPermission(cmd.RequestID, session.PermissionReply{
			Allow:              *cmd.Allow,
			UpdatedInput:       cmd.UpdatedInput,
			UpdatedPermissions: cmd.UpdatedPermissions,
			Message:            cmd.Message,
		})
	case "ping":
		err = c.SendJSON(WireEvent{Kind: "pong", SID: id})
	default:
		s.sendError(c, fmt.Sprintf("未知命令 %q", cmd.Kind))
		return
	}
	if err != nil {
		s.sendError(c, err.Error())
	}
}

// decodeAttachments 校验并解码前端附件。
//
// 只接受图片、PDF 与文本；总解码体积 10MB，单文件图片 5MB / 文本 1MB，
// 与前端限制保持一致。文本必须能按 UTF-8 解码，避免把二进制塞给模型。
func decodeAttachments(in []wireAttachment) ([]protocol.Attachment, error) {
	if len(in) == 0 {
		return nil, nil
	}
	const maxTotal = 10 << 20
	total := 0
	out := make([]protocol.Attachment, 0, len(in))
	for _, a := range in {
		name := strings.TrimSpace(a.Name)
		if name == "" {
			name = "attachment"
		}
		if len(name) > 200 {
			name = name[:200]
		}
		mediaType := strings.ToLower(strings.TrimSpace(a.MediaType))
		okImage := mediaType == "image/png" || mediaType == "image/jpeg" || mediaType == "image/gif" || mediaType == "image/webp"
		okType := okImage || mediaType == "application/pdf" || strings.HasPrefix(mediaType, "text/")
		if !okType {
			return nil, fmt.Errorf("不支持的附件类型: %s", mediaType)
		}
		data, err := base64.StdEncoding.DecodeString(a.Data)
		if err != nil {
			return nil, fmt.Errorf("附件 %s 解码失败: %w", name, err)
		}
		if len(data) == 0 {
			return nil, fmt.Errorf("附件 %s 为空", name)
		}
		if okImage && len(data) > 5<<20 {
			return nil, fmt.Errorf("图片 %s 超过 5MB", name)
		}
		if strings.HasPrefix(mediaType, "text/") {
			if len(data) > 1<<20 {
				return nil, fmt.Errorf("文本文件 %s 超过 1MB", name)
			}
			if !utf8.Valid(data) {
				return nil, fmt.Errorf("文本文件 %s 不是 UTF-8", name)
			}
		}
		if mediaType == "application/pdf" && len(data) > 8<<20 {
			return nil, fmt.Errorf("PDF %s 超过 8MB", name)
		}
		total += len(data)
		if total > maxTotal {
			return nil, errors.New("附件总大小超过 10MB")
		}
		out = append(out, protocol.Attachment{Name: name, MediaType: mediaType, Data: data})
	}
	return out, nil
}

// broadcastPromptEcho 把一条刚写进 stdin 的提示词广播给同一会话的其他连接。
//
// 前端的气泡是本地乐观插入的，而 CLI 不带 `--replay-user-messages` 时不会把 stdin
// 里的消息回显回来：不广播的话，另一台设备/另一个标签只会看到模型突然开始思考，
// 用户刚发的那句话凭空消失。
//
// 只在写 stdin 成功后调用；发送方自己的连接也会收到，前端按内容去重（已经本地插过
// 那条气泡）直接丢弃，所以不需要区分「除我之外」。
func (s *Server) broadcastPromptEcho(id string, echo promptEcho) {
	if s.d.Hub == nil || id == "" {
		return
	}
	b, err := json.Marshal(echo)
	if err != nil {
		return
	}
	s.d.Hub.Broadcast(id, WireEvent{Kind: "prompt.echo", SID: id, Data: b})
}

// promptEchoOf 把上行命令里的正文与附件整理成广播载荷。
func promptEchoOf(cmd clientCmd) promptEcho {
	echo := promptEcho{Text: cmd.Text, Interjected: cmd.Priority == "now"}
	for _, a := range cmd.Attachments {
		mediaType := strings.ToLower(strings.TrimSpace(a.MediaType))
		if strings.HasPrefix(mediaType, "image/") {
			echo.Image = append(echo.Image, echoImage{Name: a.Name, MediaType: mediaType, Data: a.Data})
			continue
		}
		echo.Files = append(echo.Files, a.Name)
	}
	return echo
}

func (s *Server) sendError(c *wsClient, msg string) {
	b, _ := json.Marshal(map[string]string{"message": msg})
	_ = c.SendJSON(WireEvent{Kind: "error", Data: b})
}
