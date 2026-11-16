package gateway

import (
	"bufio"
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
	Text               string           `json:"text,omitempty"`
	Attachments        []wireAttachment `json:"attachments,omitempty"`
	Model              string           `json:"model,omitempty"`
	Mode               string           `json:"mode,omitempty"`
	RequestID          string           `json:"request_id,omitempty"`
	Allow              *bool            `json:"allow,omitempty"`
	UpdatedInput       json.RawMessage  `json:"updated_input,omitempty"`
	UpdatedPermissions json.RawMessage  `json:"updated_permissions,omitempty"`
	Message            string           `json:"message,omitempty"`
}

// handleWS 处理 /ws?id=<session>。
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if !s.d.Guard.Check(r.Header.Get("Authorization"), r.URL.Query().Get("token")) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}
	sess, ok := s.d.Manager.Get(id)
	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	conn, reader, err := upgradeWebSocket(w, r)
	if err != nil {
		return
	}

	c := newWSClient(conn, reader, id)
	s.d.Hub.Subscribe(id, c)
	defer func() {
		s.d.Hub.Unsubscribe(id, c)
		c.close()
	}()

	// 先发快照：后加入的连接也能立刻渲染出历史与 UI 目录。
	snapshot, _ := json.Marshal(map[string]any{
		"info": map[string]any{
			"id":    id,
			"cwd":   sess.Cwd,
			"state": sess.State(),
		},
		"init": sess.InitPayload(),
	})
	if err := c.SendJSON(WireEvent{Kind: "session.snapshot", SID: id, Data: snapshot}); err != nil {
		return
	}

	for {
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
		err = sess.PromptWithAttachments(cmd.Text, atts)
		if err == nil {
			// 首条消息把对话落进持久化列表；后续消息刷新 last_active。
			if info, ok := s.conversationInfo(id); ok {
				s.touchConversation(info)
			}
		}
	case "interrupt":
		err = sess.Interrupt()
	case "model":
		err = sess.SetModel(cmd.Model)
	case "permission_mode":
		err = sess.SetPermissionMode(cmd.Mode)
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

func (s *Server) sendError(c *wsClient, msg string) {
	b, _ := json.Marshal(map[string]string{"message": msg})
	_ = c.SendJSON(WireEvent{Kind: "error", Data: b})
}
