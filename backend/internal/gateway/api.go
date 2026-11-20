package gateway

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"

	"ccweb/backend/internal/agent/manager"
	"ccweb/backend/internal/history"
	"ccweb/backend/internal/project"
	"ccweb/backend/internal/webui"
)

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"ok": true})
}

// handleInfo 返回前端启动所需的环境信息。
func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	// 前端第一屏要判断「有没有装 claude」，这里顺手带一份精简状态，
	// 免得再发一次 /api/claude/status 才能决定弹不弹安装提示。
	//
	// 未装配部署管理时**不带这两个字段**：前端据此区分"确实没装"与"这套部署不
	// 走托管安装"，否则会误弹一个装不了东西的安装提示。
	ch := channelOf(r)
	tcpPort, tcpListening, tcpErr := s.TCPStatus()
	body := map[string]any{
		"version": s.d.Cfg.Version,
		// base_url 是本次请求的有效前缀：unix 通道是网关前缀，TCP 通道为空。
		"base_url":       s.baseOf(r),
		"socket":         s.d.Cfg.AdminSock,
		"claude_bin":     s.d.Manager.Binary(),
		"claude_version": s.d.ClaudeVersion,
		"projects_root":  s.d.ProjectsRoot,
		// trim_app 是飞牛里的 appname：前端打开授权页（openAppAuth）要带上它，
		// 后端调用 trim API 用的是同一个值，所以只从配置派生一份。
		"trim_app":           s.d.Cfg.TrimAppName,
		"data_dir":           s.d.Cfg.DataDir,
		"claude_home":        s.d.Cfg.ClaudeHome,
		"settings_file":      s.d.Cfg.SettingsFile,
		"workspaces_file":    s.d.Cfg.WorkspacesFile,
		"conversations_file": s.d.Cfg.ConversationsFile,
		"auto_start":         s.d.Cfg.AutoStart,
		"current_workspace": func() string {
			if s.d.Workspaces == nil {
				return ""
			}
			return s.d.Workspaces.Current()
		}(),
		// auth_required / auth_mode 都按「本次请求的通道」回答：同一个进程里
		// unix socket 免密、TCP 端口要密码，不能给一个全局答案。
		"auth_required": s.d.Guard.Required(ch),
		"auth_mode":     s.d.Guard.Mode(ch),
		// channel 让前端区分「本机网关入口」与「TCP 直连入口」：改访问密码后
		// 只有 TCP 入口需要把本地凭据一起换掉。
		"channel": channelName(ch),
		// TCP 直连通道的真实状态，供「设置 → 访问」显示「监听中 / 监听失败」。
		"tcp_port":      tcpPort,
		"tcp_listening": tcpListening,
		"tcp_error":     tcpErr,
		"frontend":      webui.HasIndex(),
		"max_sessions":  s.d.Cfg.MaxSessions,
		// claude 用户级 settings 的提问超时（never / 60s / 5m / 10m）：提问卡片据此提示
		// 「不回答的话 CLI 到点会自己收尾」。没配就是空串。
		"ask_question_timeout": askQuestionTimeout(s.d.Cfg.ClaudeHome),
		"started_at":           s.d.StartedAt,
	}
	if s.d.Claude != nil {
		st := s.d.Claude.Status()
		body["claude_installed"] = len(st.Installed) > 0
		body["claude_active"] = st.Active
	}
	writeJSON(w, body)
}

func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"sessions": s.d.Manager.List()})
}

type createSessionReq struct {
	Cwd            string `json:"cwd"`
	Model          string `json:"model"`
	PermissionMode string `json:"permission_mode"`
	// Resume 非空时恢复该 id 对应的 claude 对话，而不是新建。
	Resume string `json:"resume,omitempty"`
}

func (s *Server) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	var req createSessionReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	abs, err := project.Validate(req.Cwd)
	if err != nil {
		writeErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.ensureCwdAuthorizedReal(abs); err != nil {
		writeErr(w, err.Error(), http.StatusForbidden)
		return
	}
	// resume 的两种走法：claude 那边有转录才真 `--resume`；没有（还没发过消息的
	// 空对话、转录被删）就同 id 新建，否则 CLI 直接退出
	// （stderr: No conversation found with session ID: …），界面上就是一个永远
	// 起不来的对话，而 id 又不能换。
	resume := strings.TrimSpace(req.Resume)
	// 这次调用会不会**把一条已有对话的进程拉起来**：拉起来之后列表里那一行的
	// live/state 从「未运行」变成「活跃」，进程结束也有一次广播
	// （`NoteSessionClosed`），可「起来」这一次原来一条都没有——别的设备要等自己
	// 下次刷新列表才看得到，侧栏里那一行一直显示「未运行」。
	//
	// 只认「本来不在跑」：已经在跑的会话被再打开一次（切回同一条对话很常见）不该
	// 广播——每次推送都让所有连接重扫一遍全部转录（见 BroadcastConversationsChanged）。
	wasLive := false
	if resume != "" {
		_, wasLive = s.conversationInfo(resume)
	}
	hasTranscript := resume == "" || s.hasTranscript(resume)
	hasRecord := false
	if resume != "" && s.d.Conversations != nil {
		if rec, ok := s.d.Conversations.Get(resume); ok {
			if rec.Deleted {
				writeErr(w, "该对话已删除", http.StatusConflict)
				return
			}
			if rec.Cwd != "" && filepath.Clean(rec.Cwd) != abs {
				writeErr(w, "该对话属于其它工作目录", http.StatusConflict)
				return
			}
			hasRecord = true
		}
	}
	var info manager.Info
	switch {
	case resume == "":
		info, err = s.d.Manager.Create(abs, req.Model, req.PermissionMode)
	case hasTranscript:
		info, err = s.d.Manager.Resume(resume, abs, req.Model, req.PermissionMode)
	default:
		info, err = s.d.Manager.StartFresh(resume, abs, req.Model, req.PermissionMode)
	}
	if err != nil {
		writeErr(w, err.Error(), http.StatusConflict)
		return
	}
	if resume != "" && (hasTranscript || hasRecord) {
		// 打开已有对话 = 一次「最近活跃」。**没转录又没有记录的**就是「刚点完
		// 新对话」：那一步绝不能落元数据，落下去就是一条没有转录、重启后
		// --resume 不起来的幽灵条目（见根 AGENTS.md「空对话不要落元数据」）。
		s.touchConversation(info)
	}
	s.touchWorkspace(abs)
	// 进程刚被拉起来：别的设备上那一行得从「未运行」变「活跃」。
	// **只在这条对话确实是由这次调用起出来的才推**（wasLive=false）——已经在跑的
	// 会话被反复打开不该推到每个连接上去重扫转录。
	//
	// 空对话（没有转录、走 StartFresh 同 id 新建）也走这里且必须推：进程同样真的
	// 起来了，而且它此前根本不在别人的列表里。
	if resume != "" && !wasLive {
		s.BroadcastConversationsChanged()
	}
	writeJSON(w, info)
}

// hasTranscript 报告 claude 是否已经为这条对话写过转录。
//
// HistoryDir 未配置（或 id 为空）时按「有」处理：宁可让 --resume 按老行为报错，
// 也不要把一条有历史的对话当新的起（那会丢掉上下文）。
func (s *Server) hasTranscript(id string) bool {
	if id == "" || s.d.HistoryDir == "" {
		return true
	}
	return history.TranscriptExists(s.d.HistoryDir, id)
}

// handleEnsureSession 兼容旧客户端：同目录已有存活会话则返回，没有则新建。
// 新版前端按对话 id 走 /api/session {resume}，不再用这个按目录 ensure 的入口。
func (s *Server) handleEnsureSession(w http.ResponseWriter, r *http.Request) {
	var req createSessionReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	abs, err := project.Validate(req.Cwd)
	if err != nil {
		writeErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.ensureCwdAuthorizedReal(abs); err != nil {
		writeErr(w, err.Error(), http.StatusForbidden)
		return
	}
	info, err := s.d.Manager.Ensure(abs, req.Model, req.PermissionMode)
	if err != nil {
		writeErr(w, err.Error(), http.StatusConflict)
		return
	}
	s.touchWorkspace(abs)
	writeJSON(w, info)
}

func (s *Server) touchWorkspace(abs string) {
	if s.d.Workspaces != nil {
		s.d.Workspaces.Touch(abs)
	}
}

func (s *Server) handleCloseSession(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		writeErr(w, "missing id", http.StatusBadRequest)
		return
	}
	if err := s.d.Manager.Close(id); err != nil {
		writeErr(w, err.Error(), http.StatusNotFound)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "id": id})
}

func (s *Server) handleListProjects(w http.ResponseWriter, r *http.Request) {
	entries, err := project.List(s.d.ProjectsRoot, project.DefaultLimit)
	if err != nil {
		writeErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"root": s.d.ProjectsRoot, "projects": entries})
}

func (s *Server) handleListHistory(w http.ResponseWriter, r *http.Request) {
	sessions, err := history.List(s.d.HistoryDir)
	if err != nil {
		writeErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"history": sessions})
}

// managerInfo 便于测试断言。
func managerInfo(m []manager.Info) []manager.Info { return m }
