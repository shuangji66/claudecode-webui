package gateway

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"ccweb/backend/internal/terminal"
	"ccweb/backend/internal/wsframe"
)

// maxTerminals 是同一进程内最多同时存在的内置终端数。
// 每个终端是一个真实 shell，必须给上限，避免一个页面开几十个把机器拖垮。
const maxTerminals = 8

// termClientCmd 是终端 WebSocket 的上行命令。
type termClientCmd struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	Cols uint16 `json:"cols,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
}

// termEvent 是终端 WebSocket 的文本控制帧；输出走二进制帧。
type termEvent struct {
	Type    string `json:"type"`
	Cwd     string `json:"cwd,omitempty"`
	Shell   string `json:"shell,omitempty"`
	Code    int    `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

// handleTerminalWS 处理 /ws/terminal?cwd=<abs>&cols=&rows=&token=。
//
// 协议：
//   - 客户端文本帧：{"type":"input","data":...} / {"type":"resize","cols","rows"} / {"type":"ping"}
//   - 服务端文本帧：ready / exit / error / pong
//   - 服务端二进制帧：PTY 原始输出（前端用 TextDecoder 流式解码）
//
// 终端进程与连接同生命周期：关页/关侧栏即 SIGHUP。这样不会留下看不见的 shell，
// 代价是重新打开会得到一个新 shell。
func (s *Server) handleTerminalWS(w http.ResponseWriter, r *http.Request) {
	if !s.d.Guard.Check(channelOf(r), r.Header.Get("Authorization"), r.URL.Query().Get("token")) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	cwd, err := s.authorizedCwd(r.URL.Query().Get("cwd"))
	if err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, errCwdForbidden) {
			code = http.StatusForbidden
		}
		http.Error(w, err.Error(), code)
		return
	}
	shell, err := terminal.FindShell(s.d.TerminalShell)
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	cols, _ := strconv.Atoi(r.URL.Query().Get("cols"))
	rows, _ := strconv.Atoi(r.URL.Query().Get("rows"))

	select {
	case s.termSlots <- struct{}{}:
		defer func() { <-s.termSlots }()
	default:
		http.Error(w, "内置终端数量已达上限，请先关闭其它终端", http.StatusTooManyRequests)
		return
	}

	conn, reader, err := upgradeWebSocket(w, r)
	if err != nil {
		return
	}
	c := newWSClient(conn, reader, "")
	defer c.close()

	sess, err := terminal.Start(shell, cwd, uint16(cols), uint16(rows))
	if err != nil {
		_ = c.SendJSON(termEvent{Type: "error", Message: err.Error()})
		return
	}
	defer sess.Close()

	if err := c.SendJSON(termEvent{Type: "ready", Cwd: cwd, Shell: shell}); err != nil {
		return
	}

	// PTY -> 浏览器：二进制帧保留原始字节，ANSI 序列不被 JSON 转义破坏。
	// 写失败时主动关掉连接，让下面的 clientDone 立刻解除阻塞；不能在这里等 shell 退出，
	// 否则一个不读数据的客户端会把 shell 一直挂着。
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		buf := make([]byte, 32<<10)
		for {
			n, err := sess.Read(buf)
			if n > 0 {
				if werr := c.writeFrame(wsframe.OpBinary, buf[:n]); werr != nil {
					c.close()
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	// 浏览器 -> PTY：文本 JSON 命令。读到关闭/出错即结束连接。
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		for {
			// 没有读超时的话，一个半开连接（手机丢网、webview 被挂起）会永久占住
			// 一个终端槽位：槽位上限 8，攒够之后所有新终端都是 429，只能重启进程。
			// 前端每 25 秒发一次 ping，两分钟足够宽松。
			_ = c.conn.SetReadDeadline(time.Now().Add(readIdleTimeout))
			op, payload, err := wsframe.ReadMessage(c.r, 1<<20)
			if err != nil {
				return
			}
			switch op {
			case wsframe.OpClose:
				return
			case wsframe.OpPing:
				if err := c.writeFrame(wsframe.OpPong, payload); err != nil {
					return
				}
			case wsframe.OpText, wsframe.OpBinary:
				var cmd termClientCmd
				if err := json.Unmarshal(payload, &cmd); err != nil {
					_ = c.SendJSON(termEvent{Type: "error", Message: "命令解析失败"})
					continue
				}
				switch cmd.Type {
				case "input":
					if len(cmd.Data) == 0 {
						continue
					}
					if len(cmd.Data) > 64<<10 {
						_ = c.SendJSON(termEvent{Type: "error", Message: "单次输入超过 64KB"})
						continue
					}
					if _, err := sess.Write([]byte(cmd.Data)); err != nil {
						return
					}
				case "resize":
					if err := sess.Resize(cmd.Cols, cmd.Rows); err != nil {
						return
					}
				case "ping":
					_ = c.SendJSON(termEvent{Type: "pong"})
				default:
					_ = c.SendJSON(termEvent{Type: "error", Message: "未知终端命令: " + cmd.Type})
				}
			}
		}
	}()

	select {
	case <-clientDone:
	case <-sess.Done():
		// shell 退出后把 PTY 缓冲里剩下的输出排空，再发 exit。
		select {
		case <-readDone:
		case <-time.After(2 * time.Second):
		}
		_ = sess.Wait()
		_ = c.SendJSON(termEvent{Type: "exit", Code: sess.ExitCode()})
	}
}
