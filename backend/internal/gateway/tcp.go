package gateway

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"ccweb/backend/internal/settings"
)

// tcpState 是 TCP 直连通道的监听状态。
//
// 端口来自设置（默认 3141），可以在运行期改：新端口先 bind 成功，才切换过去，
// 所以「端口被占用 / 权限不足」不会把已经在用的入口弄丢。
type tcpState struct {
	mu sync.Mutex
	// ln 是当前正在接受的 listener；nil 表示没有在监听。
	ln net.Listener
	// srv 是当前 listener 对应的 http.Server；关闭端口访问时要连活动连接一起断开。
	srv *http.Server
	// retired 是换端口时留下的旧 http.Server：旧连接还挂在上面，
	// 关闭端口访问时要一并 Close（只关 listener 的话这些页面会继续可用）。
	retired []*http.Server
	// port 是当前正在监听的端口（不是设置里的目标端口）。
	port int
	// lastErr 是最近一次 bind 失败的原因；成功后清空。
	lastErr string
}

// configuredTCPPort 返回设置里要求的 TCP 端口。
func (s *Server) configuredTCPPort() int {
	port := settings.DefaultTCPPort
	if s.d.Settings != nil {
		if v := s.d.Settings.Get().TCPPort; v > 0 {
			port = v
		}
	}
	return port
}

// TCPStatus 返回正在监听的端口、是否在监听，以及最近一次绑定失败的原因。
// 供 /api/info 给「设置 → 访问」展示真实状态。
func (s *Server) TCPStatus() (port int, listening bool, errText string) {
	s.tcp.mu.Lock()
	defer s.tcp.mu.Unlock()
	return s.tcp.port, s.tcp.ln != nil, s.tcp.lastErr
}

// ListenTCP 在指定端口上（重新）监听 HTTP 服务。
//
// 关键取舍：先 bind 新端口，成功后才关掉旧 listener。端口冲突或权限不足时
// 旧入口继续可用，用户还能从设置页改回去；失败原因记进 TCPStatus。
// 只关 listener、不关旧 http.Server：已经打开的页面与 WebSocket 不因为换端口
// 被踢下线（旧连接自然结束），旧 server 记进 retired 等关闭端口访问时统一清理。
func (s *Server) ListenTCP(port int) error {
	if !settings.ValidTCPPort(port) {
		return fmt.Errorf("gateway: TCP 端口 %d 越界（%d–%d）", port, settings.MinTCPPort, settings.MaxTCPPort)
	}
	addr := net.JoinHostPort(s.d.Cfg.TCPHost, strconv.Itoa(port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		s.tcp.mu.Lock()
		s.tcp.lastErr = err.Error()
		s.tcp.mu.Unlock()
		return fmt.Errorf("gateway: 监听 TCP %s: %w", addr, err)
	}
	srv := &http.Server{
		Handler:           s.TCPHandler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	s.tcp.mu.Lock()
	oldLn, oldSrv := s.tcp.ln, s.tcp.srv
	s.tcp.ln = ln
	s.tcp.srv = srv
	s.tcp.port = port
	s.tcp.lastErr = ""
	if oldSrv != nil {
		s.tcp.retired = append(s.tcp.retired, oldSrv)
	}
	s.tcp.mu.Unlock()

	go func() {
		err := srv.Serve(ln)
		// 换端口时我们会主动关掉旧 listener，那属于正常路径，不要刷日志。
		if err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, net.ErrClosed) {
			s.log.Printf("TCP 访问端口 %d 退出: %v", port, err)
		}
	}()
	if oldLn != nil {
		_ = oldLn.Close()
	}
	return nil
}

// detachTCP 把当前监听状态整体摘下，交给调用方关闭。
//
// 先把状态清空再关：调用方拿到的是一份快照，之后即使有人立刻重新开启端口，
// 也不会被这次关闭误伤（旧 http.Server 与新 server 是两个对象）。
func (s *Server) detachTCP() (net.Listener, []*http.Server) {
	s.tcp.mu.Lock()
	defer s.tcp.mu.Unlock()
	ln := s.tcp.ln
	srvs := append([]*http.Server(nil), s.tcp.retired...)
	if s.tcp.srv != nil {
		srvs = append(srvs, s.tcp.srv)
	}
	s.tcp.ln = nil
	s.tcp.srv = nil
	s.tcp.retired = nil
	s.tcp.port = 0
	s.tcp.lastErr = ""
	return ln, srvs
}

// CloseTCP 立即停止端口访问：关闭监听并断开全部已建立的 TCP 连接（含 WebSocket）。
//
// 关闭端口访问是安全动作，不能只停 listener：那样已经打开的页面会继续可用，
// 直到自己断开为止。换端口走的是 ListenTCP（只关旧 listener），不要混用。
func (s *Server) CloseTCP() {
	ln, srvs := s.detachTCP()
	if ln != nil {
		_ = ln.Close()
	}
	for _, srv := range srvs {
		// Close 会关闭 listener 与全部活动连接，正好是「关掉端口访问」的语义。
		_ = srv.Close()
	}
}

// StopTCPGracefully 立即停止接受新连接（释放端口），延迟断开已有连接。
//
// 关闭端口访问时用：先把 listener 关掉、端口立刻可再次绑定，已有连接再活
// delay 这段时间——足够让「保存成功」的响应送出去，也避免立刻重开端口时
// 旧的延迟关闭把新 listener 一起带走。会话在调用方清理。
func (s *Server) StopTCPGracefully(delay time.Duration) {
	ln, srvs := s.detachTCP()
	if ln != nil {
		_ = ln.Close()
	}
	if len(srvs) == 0 {
		return
	}
	go func() {
		time.Sleep(delay)
		for _, srv := range srvs {
			_ = srv.Close()
		}
	}()
}
