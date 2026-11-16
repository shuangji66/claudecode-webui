package gateway

import (
	"encoding/json"
	"net/http"
	"path/filepath"

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
	body := map[string]any{
		"version":            s.d.Cfg.Version,
		"base_url":           s.d.Cfg.BaseURL,
		"socket":             s.d.Cfg.AdminSock,
		"claude_bin":         s.d.Manager.Binary(),
		"claude_version":     s.d.ClaudeVersion,
		"projects_root":      s.d.ProjectsRoot,
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
		"auth_required": s.d.Guard.Required(),
		"frontend":      webui.HasIndex(),
		"max_sessions":  s.d.Cfg.MaxSessions,
		"started_at":    s.d.StartedAt,
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
	if err := s.ensureCwdAuthorized(abs); err != nil {
		writeErr(w, err.Error(), http.StatusForbidden)
		return
	}
	if req.Resume != "" && s.d.Conversations != nil {
		if rec, ok := s.d.Conversations.Get(req.Resume); ok {
			if rec.Deleted {
				writeErr(w, "该对话已删除", http.StatusConflict)
				return
			}
			if rec.Cwd != "" && filepath.Clean(rec.Cwd) != abs {
				writeErr(w, "该对话属于其它工作目录", http.StatusConflict)
				return
			}
		}
	}
	var info manager.Info
	if req.Resume != "" {
		info, err = s.d.Manager.Resume(req.Resume, abs, req.Model, req.PermissionMode)
	} else {
		info, err = s.d.Manager.Create(abs, req.Model, req.PermissionMode)
	}
	if err != nil {
		writeErr(w, err.Error(), http.StatusConflict)
		return
	}
	if req.Resume != "" {
		// 打开已有对话 = 一次「最近活跃」；新建的空对话等首条消息再落元数据。
		s.touchConversation(info)
	}
	s.touchWorkspace(abs)
	writeJSON(w, info)
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
	if err := s.ensureCwdAuthorized(abs); err != nil {
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
