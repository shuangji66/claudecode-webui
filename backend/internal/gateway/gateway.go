// Package gateway 是对外唯一入口：路由 + 两条通道（unix socket / TCP 端口）+ 鉴权。
//
// 两条通道提供的页面相同，差别只在路径前缀与凭据：
//   - unix socket：前置网关（nginx / 飞牛网关）按 baseurl 前缀反代，是可信入口，
//     不校验「TCP 访问密码」（CCWEB_AUTH_TOKEN 仍然两条通道都校验）；
//   - TCP 端口：挂在根路径、不注入 baseurl，局域网可达，设置页打开鉴权后要求访问密码。
//
// socket 路径与 baseurl 来自环境变量（见 config 包），TCP 端口来自设置。
package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"ccweb/backend/internal/agent/manager"
	"ccweb/backend/internal/agent/session"
	"ccweb/backend/internal/authz"
	"ccweb/backend/internal/config"
	"ccweb/backend/internal/conversation"
	"ccweb/backend/internal/hub"
	"ccweb/backend/internal/mcp"
	"ccweb/backend/internal/plugin"
	"ccweb/backend/internal/schedule"
	"ccweb/backend/internal/settings"
	"ccweb/backend/internal/skills"
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
	// SessionsUsing 返回从该二进制启动、仍在运行的会话 id；部署页据此显示
	// 「几个对话正在用这个版本」。
	SessionsUsing(bin string) []string
	// CloseSessionsUsing 结束这些会话（等进程退出），删除版本目录前用。
	CloseSessionsUsing(bin string) []string
	Create(cwd, model, permissionMode string) (manager.Info, error)
	Resume(id, cwd, model, permissionMode string) (manager.Info, error)
	// StartFresh 用同一个 id 起全新会话（--session-id）：给「claude 那边没有转录」
	// 的对话用，此时 --resume 必然让 CLI 退出，而 id 又不能换。
	StartFresh(id, cwd, model, permissionMode string) (manager.Info, error)
	// Fork 从已有对话复制出一个新会话（新 id 由 manager 生成），原会话不受影响。
	Fork(oldID, cwd, model, permissionMode string) (manager.Info, error)
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
	// Schedules 是自动化任务存储；为 nil 时相关路由返回 503。
	Schedules *schedule.Store
	// Claude 是 claude 版本管理（下载/切换）；为 nil 时部署相关路由返回 503。
	Claude ClaudeDeployer
	// Skills 管理 SKILL.md（个人/项目）；为 nil 时技能路由返回 503。
	Skills *skills.Manager
	// Mcp 管理 MCP server 配置（用户级 .claude.json / 项目级 .mcp.json）；
	// 为 nil 时相关路由返回 503。
	Mcp *mcp.Manager
	// Plugins 通过 `claude plugin` 管理插件与 marketplace；为 nil 时相关路由返回 503。
	Plugins *plugin.Manager
	// Dirs 读写飞牛「用户授权目录」（scope trim.file.userAccess）；为 nil 时
	// 「设置 → 目录」显示「本部署没有接飞牛目录接口」。
	Dirs DirAuth
	// DirsProtected 是撤销时一律拒绝的路径（应用自己的安装目录 / 数据目录）：
	// 撤销它们等于让运行中的进程读不到自己的二进制与数据。
	DirsProtected []string
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
	// notifiedMu/notifiedLatest 记录已推送过的最新版本号，避免每小时把同一条
	// 「有更新」重复推给所有标签页（每次推送前端都会再拉一次 /api/claude/status）。
	notifiedMu     sync.Mutex
	notifiedLatest string

	// pluginMu 同时保护下面四个字段：插件变更任务的状态与「可用插件」缓存。
	// 任务同一时刻只有一个（CLI 会读改写同一批配置文件），所以用单槽而不是队列。
	pluginMu        sync.Mutex
	pluginJob       *pluginJobView
	pluginAvail     []pluginAvailable
	pluginAvailAt   time.Time
	pluginAvailNote string
	// pluginAvailLoaded 表示已经尝试读过落盘缓存；pluginAutoTried 表示已经自动
	// 补过一次「可用插件」（每进程只自动一次，失败留给用户手动重试）。
	pluginAvailLoaded bool
	pluginAutoTried   bool

	// runner 是自动化任务的调度循环（装配层创建后接进来）；为 nil 时
	// 「立即执行」返回 503。
	runner *schedule.Runner

	// tcp 是直连 TCP 端口的监听状态：端口来自设置，保存后可运行期换端口。
	tcp tcpState
	// tcpOpMu 串行化「改端口/开关 + 落盘」这一整段：两个标签页同时保存时，
	// 不能让监听和 settings.json 各自保留不同请求的结果。
	tcpOpMu sync.Mutex
}

// New 构造网关。
func New(d Deps, logger *log.Logger) *Server {
	if logger == nil {
		logger = log.New(os.Stdout, "[ccweb] ", log.LstdFlags)
	}
	s := &Server{d: d, mux: http.NewServeMux(), log: logger, termSlots: make(chan struct{}, maxTerminals)}
	// TCP 访问密码存在设置里、可运行期修改，所以把取值函数接到 Guard 上，
	// 而不是启动时快照一份。unix socket 通道本来就不校验它。
	if d.Guard != nil && d.Settings != nil {
		d.Guard.SetPasswordSource(func() string {
			_, hash := d.Settings.TCPAccess()
			return hash
		})
	}
	s.routes()
	return s
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /api/health", s.handleHealth)
	// 登录是唯一接受明文密码的接口：它把密码换成随机会话令牌。
	s.mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	s.mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
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
	s.mux.HandleFunc("POST /api/workspaces/rename", s.authed(s.handleRenameWorkspace))
	// 飞牛「已授权目录」：只查/删，授权由用户在选择器或授权页确认（前端负责）。
	s.mux.HandleFunc("GET /api/dirs", s.authed(s.handleListDirs))
	s.mux.HandleFunc("POST /api/dirs/remove", s.authed(s.handleRemoveDir))
	s.mux.HandleFunc("GET /api/fs/list", s.authed(s.handleBrowseDirs))
	s.mux.HandleFunc("POST /api/fs/mkdir", s.authed(s.handleMkdir))
	s.mux.HandleFunc("POST /api/fs/access", s.authed(s.handleFsAccess))
	s.mux.HandleFunc("POST /api/fs/host-file", s.authed(s.handleFsHostFile))
	s.mux.HandleFunc("GET /api/fs/tree", s.authed(s.handleFsTree))
	s.mux.HandleFunc("GET /api/fs/complete", s.authed(s.handleFsComplete))
	s.mux.HandleFunc("GET /api/fs/file", s.authed(s.handleFsFile))
	s.mux.HandleFunc("GET /api/fs/download", s.authed(s.handleFsDownload))
	s.mux.HandleFunc("GET /api/fs/raw", s.authed(s.handleFsRaw))
	s.mux.HandleFunc("GET /api/git/repos", s.authed(s.handleGitRepos))
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
	s.mux.HandleFunc("POST /api/git/pull", s.authed(s.handleGitPull))
	s.mux.HandleFunc("GET /api/history", s.authed(s.handleListHistory))
	s.mux.HandleFunc("GET /api/history/transcript", s.authed(s.handleHistoryTranscript))
	s.mux.HandleFunc("GET /api/history/subagent", s.authed(s.handleHistorySubagent))
	s.mux.HandleFunc("GET /api/history/export", s.authed(s.handleHistoryExport))
	s.mux.HandleFunc("GET /api/history/preview", s.authed(s.handleHistoryPreview))
	s.mux.HandleFunc("POST /api/session/task", s.authed(s.handleSessionTask))
	s.mux.HandleFunc("GET /api/conversations", s.authed(s.handleListConversations))
	s.mux.HandleFunc("PATCH /api/conversations", s.authed(s.handlePatchConversation))
	s.mux.HandleFunc("DELETE /api/conversations", s.authed(s.handleDeleteConversation))
	s.mux.HandleFunc("POST /api/conversations/fork", s.authed(s.handleForkConversation))
	// 自动化任务（宿主级调度）：任务列表 / 增删改 / 暂停恢复 / 立即执行 / 运行记录。
	s.mux.HandleFunc("GET /api/schedules", s.authed(s.handleListSchedules))
	s.mux.HandleFunc("POST /api/schedules", s.authed(s.handleCreateSchedule))
	s.mux.HandleFunc("PATCH /api/schedules", s.authed(s.handleUpdateSchedule))
	s.mux.HandleFunc("DELETE /api/schedules", s.authed(s.handleDeleteSchedule))
	s.mux.HandleFunc("POST /api/schedules/action", s.authed(s.handleScheduleAction))
	s.mux.HandleFunc("GET /api/schedules/deliveries", s.authed(s.handleScheduleDeliveries))
	s.mux.HandleFunc("GET /api/settings", s.authed(s.handleGetSettings))
	s.mux.HandleFunc("PUT /api/settings", s.authed(s.handlePutSettings))
	s.mux.HandleFunc("POST /api/settings/test", s.authed(s.handleTestProvider))
	s.mux.HandleFunc("POST /api/settings/models", s.authed(s.handleFetchModels))
	s.mux.HandleFunc("POST /api/settings/verify", s.authed(s.handleVerifyModel))
	s.mux.HandleFunc("POST /api/settings/proxy", s.authed(s.handleApplyProxy))
	s.mux.HandleFunc("GET /api/skills", s.authed(s.handleListSkills))
	s.mux.HandleFunc("GET /api/skills/doc", s.authed(s.handleGetSkill))
	s.mux.HandleFunc("PUT /api/skills/doc", s.authed(s.handleSaveSkill))
	s.mux.HandleFunc("DELETE /api/skills/doc", s.authed(s.handleDeleteSkill))
	s.mux.HandleFunc("POST /api/skills/import", s.authed(s.handleImportSkills))
	s.mux.HandleFunc("GET /api/mcp", s.authed(s.handleListMcp))
	s.mux.HandleFunc("POST /api/mcp", s.authed(s.handleSaveMcp))
	s.mux.HandleFunc("DELETE /api/mcp", s.authed(s.handleDeleteMcp))
	s.mux.HandleFunc("POST /api/mcp/enabled", s.authed(s.handleSetMcpEnabled))
	s.mux.HandleFunc("POST /api/mcp/probe", s.authed(s.handleProbeMcp))
	s.mux.HandleFunc("GET /api/plugins", s.authed(s.handleListPlugins))
	s.mux.HandleFunc("GET /api/plugins/available", s.authed(s.handleAvailablePlugins))
	s.mux.HandleFunc("POST /api/plugins/refresh", s.authed(s.handleRefreshPlugins))
	s.mux.HandleFunc("GET /api/plugins/details", s.authed(s.handlePluginDetails))
	s.mux.HandleFunc("POST /api/plugins/install", s.authed(s.handleInstallPlugin))
	s.mux.HandleFunc("POST /api/plugins/enabled", s.authed(s.handleSetPluginEnabled))
	s.mux.HandleFunc("POST /api/plugins/update", s.authed(s.handleUpdatePlugin))
	s.mux.HandleFunc("POST /api/plugins/uninstall", s.authed(s.handleUninstallPlugin))
	s.mux.HandleFunc("POST /api/plugins/marketplace", s.authed(s.handlePluginMarketplace))
	s.mux.HandleFunc("GET /api/search", s.authed(s.handleGetSearch))
	s.mux.HandleFunc("POST /api/search/config", s.authed(s.handleSaveSearch))
	s.mux.HandleFunc("POST /api/search/test", s.authed(s.handleTestSearch))
	s.mux.HandleFunc("POST /api/search/attach", s.authed(s.handleAttachSearch))
	s.mux.HandleFunc("POST /api/search/detach", s.authed(s.handleDetachSearch))
	s.mux.HandleFunc("GET /api/claude/status", s.authed(s.handleClaudeStatus))
	s.mux.HandleFunc("POST /api/claude/check", s.authed(s.handleClaudeCheck))
	s.mux.HandleFunc("POST /api/claude/install", s.authed(s.handleClaudeInstall))
	s.mux.HandleFunc("POST /api/claude/cancel", s.authed(s.handleClaudeCancel))
	s.mux.HandleFunc("DELETE /api/claude/version", s.authed(s.handleClaudeDelete))
	s.mux.HandleFunc("POST /api/claude/active", s.authed(s.handleClaudeActive))
	s.mux.HandleFunc("POST /api/claude/source", s.authed(s.handleClaudeSource))
	s.mux.HandleFunc("GET /ws", s.handleWS)
	s.mux.HandleFunc("GET /ws/terminal", s.handleTerminalWS)
	s.mux.HandleFunc("/", s.handleSPA)
}

// Handler 返回 unix socket 通道的根 handler：带 baseurl 前缀剥离，
// 鉴权只认环境变量令牌（TCP 访问密码不适用于本机 socket）。
func (s *Server) Handler() http.Handler {
	return s.channelHandler(authz.ChannelUnix, s.d.Cfg.BaseURL)
}

// TCPHandler 返回直连 TCP 端口用的根 handler：挂在根路径（不注入 baseurl），
// 并且启用鉴权时要求 TCP 访问密码。
func (s *Server) TCPHandler() http.Handler {
	return s.channelHandler(authz.ChannelTCP, "")
}

// channelHandler 把通道与本次请求的有效 baseurl 放进 context。
//
// baseurl 必须跟着请求走而不是全局读配置：同一个进程里 unix 通道可能挂在
// /app/ccweb 下，TCP 通道则始终是根路径；SPA 注入 <base>、/api/info 的
// base_url 都由它决定。
func (s *Server) channelHandler(ch authz.Channel, base string) http.Handler {
	base = strings.TrimRight(base, "/")
	h := withBaseURL(base, s.mux)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), channelKey{}, ch)
		ctx = context.WithValue(ctx, baseKey{}, base)
		h.ServeHTTP(w, r.WithContext(ctx))
	})
}

// context key 用私有类型，避免和别的包撞键。
type channelKey struct{}
type baseKey struct{}

// channelOf 返回请求到达的通道；未标注时按 unix socket 处理。
func channelOf(r *http.Request) authz.Channel {
	if v, ok := r.Context().Value(channelKey{}).(authz.Channel); ok {
		return v
	}
	return authz.ChannelUnix
}

// channelName 把通道转成 /api/info 里的字符串。
func channelName(ch authz.Channel) string {
	if ch == authz.ChannelTCP {
		return "tcp"
	}
	return "unix"
}

// baseOf 返回本次请求的有效 baseurl（TCP 通道为空串）。
// 没经过 channelHandler 的调用（单测直接打 mux）退回配置里的 baseurl。
func (s *Server) baseOf(r *http.Request) string {
	if v, ok := r.Context().Value(baseKey{}).(string); ok {
		return v
	}
	return strings.TrimRight(s.d.Cfg.BaseURL, "/")
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
			// 裸前缀直接当根处理，**不要**重定向到 base+"/"。
			// 飞牛网关（trim_http_cgi）会把会话凭据放在 query 上（?token=…），
			// 301 会把它丢掉：随后那次请求没有任何凭据，网关直接回 13 字节的
			// "invalid token"（HTTP 200、text/plain），而应用根本收不到请求。
			// 而且 301 会被浏览器/webview 长期缓存，凭据再也不会被带上。
			// 相对资源本来就靠 index.html 里注入的 <base href="{base}/"> 解析，
			// 所以裸前缀不需要尾斜杠也能正确加载。
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/"
			h.ServeHTTP(w, r2)
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

// authed 是 HTTP 侧的鉴权中间件（凭据要求跟着通道走）。
func (s *Server) authed(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.d.Guard.Check(channelOf(r), r.Header.Get("Authorization"), r.URL.Query().Get("token")) {
			writeErr(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

// ListenAndServe 先起 unix socket（阻塞），再起 TCP 端口（后台）。
//
// TCP 监听失败不退出进程：那样用户连设置页都进不去改端口。失败只记日志，
// 端口写进 /api/info 的状态，设置页保存一次即重试。
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
	// 端口访问默认关闭；开启后才监听。绑定失败不退出进程：用户还要进设置页改端口。
	if s.d.Settings != nil {
		if enabled, _ := s.d.Settings.TCPAccess(); enabled {
			if err := s.ListenTCP(s.configuredTCPPort()); err != nil {
				s.log.Printf("TCP 访问端口 %d 监听失败（可在「设置 → 访问」里改端口后重试）: %v", s.configuredTCPPort(), err)
			}
		}
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
