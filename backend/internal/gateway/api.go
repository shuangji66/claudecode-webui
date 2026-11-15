package gateway

import (
	"encoding/json"
	"net/http"

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
	writeJSON(w, map[string]any{
		"version":         s.d.Cfg.Version,
		"base_url":        s.d.Cfg.BaseURL,
		"socket":          s.d.Cfg.AdminSock,
		"claude_bin":      s.d.Manager.Binary(),
		"claude_version":  s.d.ClaudeVersion,
		"projects_root":   s.d.ProjectsRoot,
		"data_dir":        s.d.Cfg.DataDir,
		"claude_home":     s.d.Cfg.ClaudeHome,
		"settings_file":   s.d.Cfg.SettingsFile,
		"workspaces_file": s.d.Cfg.WorkspacesFile,
		"auto_start":      s.d.Cfg.AutoStart,
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
	})
}

func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"sessions": s.d.Manager.List()})
}

type createSessionReq struct {
	Cwd            string `json:"cwd"`
	Model          string `json:"model"`
	PermissionMode string `json:"permission_mode"`
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
	info, err := s.d.Manager.Create(abs, req.Model, req.PermissionMode)
	if err != nil {
		writeErr(w, err.Error(), http.StatusConflict)
		return
	}
	s.touchWorkspace(abs)
	writeJSON(w, info)
}

// handleEnsureSession 返回同目录下已存在的会话；没有则创建。
// 前端启动 / 切换工作区走这个端点，避免与后端自动拉起重复启动 claude。
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
