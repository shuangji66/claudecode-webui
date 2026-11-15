package gateway

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"ccweb/backend/internal/agent/session"
	"ccweb/backend/internal/wsframe"
)

// writeTimeout 是单帧写超时：一个不读数据的客户端不能让广播永久阻塞。
const writeTimeout = 5 * time.Second

// wsClient 是一条浏览器 WebSocket 连接，同时实现 hub.Client。
type wsClient struct {
	conn  net.Conn
	r     *bufio.Reader
	topic string

	wmu    sync.Mutex
	closed atomic.Bool
}

// SendJSON 发送一条事件；实现 hub.Client。
func (c *wsClient) SendJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.writeFrame(wsframe.OpText, b)
}

func (c *wsClient) writeFrame(op byte, payload []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if c.closed.Load() {
		return errors.New("ws: 连接已关闭")
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	if _, err := c.conn.Write(wsframe.Encode(op, payload)); err != nil {
		c.closed.Store(true)
		return err
	}
	return nil
}

func (c *wsClient) close() {
	if c.closed.Swap(true) {
		return
	}
	c.wmu.Lock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(time.Second))
	_, _ = c.conn.Write(wsframe.EncodeClose(1000))
	c.wmu.Unlock()
	_ = c.conn.Close()
}

// clientCmd 是前端上行命令。
type clientCmd struct {
	Kind               string          `json:"kind"`
	Text               string          `json:"text,omitempty"`
	Model              string          `json:"model,omitempty"`
	Mode               string          `json:"mode,omitempty"`
	RequestID          string          `json:"request_id,omitempty"`
	Allow              *bool           `json:"allow,omitempty"`
	UpdatedInput       json.RawMessage `json:"updated_input,omitempty"`
	UpdatedPermissions json.RawMessage `json:"updated_permissions,omitempty"`
	Message            string          `json:"message,omitempty"`
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
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		http.Error(w, "missing Sec-WebSocket-Key", http.StatusBadRequest)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return
	}
	conn, brw, err := hj.Hijack()
	if err != nil {
		return
	}
	handshake := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + wsframe.AcceptKey(key) + "\r\n\r\n"
	_ = conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	if _, err := conn.Write([]byte(handshake)); err != nil {
		_ = conn.Close()
		return
	}
	_ = conn.SetWriteDeadline(time.Time{})

	c := &wsClient{conn: conn, r: brw.Reader, topic: id}
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

func (s *Server) dispatch(c *wsClient, sess *session.Session, id string, payload []byte) {
	var cmd clientCmd
	if err := json.Unmarshal(payload, &cmd); err != nil {
		s.sendError(c, "命令解析失败: "+err.Error())
		return
	}
	var err error
	switch cmd.Kind {
	case "prompt":
		if cmd.Text == "" {
			s.sendError(c, "prompt 不能为空")
			return
		}
		err = sess.Prompt(cmd.Text)
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

func (s *Server) sendError(c *wsClient, msg string) {
	b, _ := json.Marshal(map[string]string{"message": msg})
	_ = c.SendJSON(WireEvent{Kind: "error", Data: b})
}
