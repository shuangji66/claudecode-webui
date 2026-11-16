// Package gateway 是对外唯一入口：unix socket + baseurl 前缀 + 路由 + 鉴权。
//
// 程序自身不监听 TCP，由前置网关（nginx / 飞牛网关）把 HTTP 与 WebSocket
// 反代到这个 socket。baseurl 与 socket 路径全部来自环境变量（见 config 包）。
package gateway

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"ccweb/backend/internal/agent/manager"
	"ccweb/backend/internal/agent/session"
	"ccweb/backend/internal/authz"
	"ccweb/backend/internal/config"
	"ccweb/backend/internal/conversation"
	"ccweb/backend/internal/hub"
	"ccweb/backend/internal/settings"
	"ccweb/backend/internal/workspace"
)

// WireEvent 是推给前端的事件信封。
type WireEvent struct {
	Kind string          `json:"kind"`
	SID  string          `json:"sid,omitempty"`
	Data json.RawMessage `json:"data,omitempty"`
}

// SessionManager 是网关对 agent 子域的最小依赖。
// 抽成接口是为了让网关可以脱离真实 claude 二进制做单元测试。
type SessionManager interface {
	Binary() string
	Create(cwd, model, permissionMode string) (manager.Info, error)
	Resume(id, cwd, model, permissionMode string) (manager.Info, error)
	Ensure(cwd, model, permissionMode string) (manager.Info, error)
	Get(id string) (*session.Session, bool)
	List() []manager.Info
	Close(id string) error
}

// Deps 是网关的依赖。
type Deps struct {
	Cfg           config.Config
	Guard         *authz.Guard
	Hub           *hub.Hub
	Manager       SessionManager
	HistoryDir    string
	ProjectsRoot  string
	Settings      *settings.Store
	Workspaces    *workspace.Store
	Conversations *conversation.Store
	ClaudeVersion string
	TerminalShell string
	StartedAt     time.Time
}

// Server 是网关实例。
type Server struct {
	d   Deps
	mux *http.ServeMux
	log *log.Logger
	// termSlots 限制同时存在的内置终端数量；每个终端是一个真实 shell。
	termSlots chan struct{}
}

// New 构造网关。
func New(d Deps, logger *log.Logger) *Server {
	if logger == nil {
		logger = log.New(os.Stdout, "[ccweb] ", log.LstdFlags)
	}
	s := &Server{d: d, mux: http.NewServeMux(), log: logger, termSlots: make(chan struct{}, maxTerminals)}
	s.routes()
	return s
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /api/health", s.handleHealth)
	s.mux.HandleFunc("GET /api/info", s.authed(s.handleInfo))
	s.mux.HandleFunc("GET /api/sessions", s.authed(s.handleListSessions))
	s.mux.HandleFunc("POST /api/session", s.authed(s.handleCreateSession))
	s.mux.HandleFunc("POST /api/session/ensure", s.authed(s.handleEnsureSession))
	s.mux.HandleFunc("DELETE /api/session", s.authed(s.handleCloseSession))
	s.mux.HandleFunc("GET /api/projects", s.authed(s.handleListProjects))
	s.mux.HandleFunc("GET /api/workspaces", s.authed(s.handleListWorkspaces))
	s.mux.HandleFunc("POST /api/workspaces", s.authed(s.handleAddWorkspace))
	s.mux.HandleFunc("DELETE /api/workspaces", s.authed(s.handleRemoveWorkspace))
	s.mux.HandleFunc("POST /api/workspaces/current", s.authed(s.handleSetCurrentWorkspace))
	s.mux.HandleFunc("GET /api/fs/list", s.authed(s.handleBrowseDirs))
	s.mux.HandleFunc("GET /api/fs/tree", s.authed(s.handleFsTree))
	s.mux.HandleFunc("GET /api/fs/file", s.authed(s.handleFsFile))
	s.mux.HandleFunc("GET /api/fs/raw", s.authed(s.handleFsRaw))
	s.mux.HandleFunc("GET /api/git/status", s.authed(s.handleGitStatus))
	s.mux.HandleFunc("GET /api/git/diff", s.authed(s.handleGitDiff))
	s.mux.HandleFunc("GET /api/git/show", s.authed(s.handleGitShow))
	s.mux.HandleFunc("GET /api/git/log", s.authed(s.handleGitLog))
	s.mux.HandleFunc("GET /api/git/branches", s.authed(s.handleGitBranches))
	s.mux.HandleFunc("POST /api/git/stage", s.authed(s.handleGitStage))
	s.mux.HandleFunc("POST /api/git/unstage", s.authed(s.handleGitUnstage))
	s.mux.HandleFunc("POST /api/git/discard", s.authed(s.handleGitDiscard))
	s.mux.HandleFunc("POST /api/git/commit", s.authed(s.handleGitCommit))
	s.mux.HandleFunc("POST /api/git/checkout", s.authed(s.handleGitCheckout))
	s.mux.HandleFunc("POST /api/git/sync", s.authed(s.handleGitSync))
	s.mux.HandleFunc("GET /api/history", s.authed(s.handleListHistory))
	s.mux.HandleFunc("GET /api/history/transcript", s.authed(s.handleHistoryTranscript))
	s.mux.HandleFunc("GET /api/conversations", s.authed(s.handleListConversations))
	s.mux.HandleFunc("PATCH /api/conversations", s.authed(s.handlePatchConversation))
	s.mux.HandleFunc("DELETE /api/conversations", s.authed(s.handleDeleteConversation))
	s.mux.HandleFunc("GET /api/settings", s.authed(s.handleGetSettings))
	s.mux.HandleFunc("PUT /api/settings", s.authed(s.handlePutSettings))
	s.mux.HandleFunc("POST /api/settings/test", s.authed(s.handleTestProvider))
	s.mux.HandleFunc("POST /api/settings/models", s.authed(s.handleFetchModels))
	s.mux.HandleFunc("POST /api/settings/verify", s.authed(s.handleVerifyModel))
	s.mux.HandleFunc("POST /api/settings/proxy", s.authed(s.handleApplyProxy))
	s.mux.HandleFunc("GET /ws", s.handleWS)
	s.mux.HandleFunc("GET /ws/terminal", s.handleTerminalWS)
	s.mux.HandleFunc("/", s.handleSPA)
}

// Handler 返回带 baseurl 前缀剥离的根 handler。
func (s *Server) Handler() http.Handler {
	return withBaseURL(s.d.Cfg.BaseURL, s.mux)
}

// withBaseURL 负责剥离网关配置的前缀；前缀不匹配的请求一律 404，
// 避免把裸路径暴露给外部扫描。
func withBaseURL(base string, h http.Handler) http.Handler {
	base = strings.TrimRight(base, "/")
	if base == "" {
		return h
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if p == base {
			// 让相对资源能正确解析，补一个尾斜杠。
			http.Redirect(w, r, base+"/", http.StatusMovedPermanently)
			return
		}
		if !strings.HasPrefix(p, base+"/") {
			http.NotFound(w, r)
			return
		}
		r2 := r.Clone(r.Context())
		r2.URL.Path = strings.TrimPrefix(p, base)
		h.ServeHTTP(w, r2)
	})
}

// authed 是 HTTP 侧的鉴权中间件。
func (s *Server) authed(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.d.Guard.Check(r.Header.Get("Authorization"), r.URL.Query().Get("token")) {
			writeErr(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

// ListenAndServe 在 unix socket 上提供服务。
func (s *Server) ListenAndServe() error {
	sock := s.d.Cfg.AdminSock
	if err := os.MkdirAll(filepath.Dir(sock), 0o700); err != nil {
		return fmt.Errorf("gateway: 创建 socket 目录: %w", err)
	}
	// 上次进程残留的 socket 文件会让 Listen 直接失败。
	if err := os.Remove(sock); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("gateway: 清理旧 socket: %w", err)
	}
	ln, err := net.Listen("unix", sock)
	if err != nil {
		return fmt.Errorf("gateway: 监听 %s: %w", sock, err)
	}
	if err := os.Chmod(sock, 0o660); err != nil {
		s.log.Printf("chmod socket 失败: %v", err)
	}
	srv := &http.Server{
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	return srv.Serve(ln)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
