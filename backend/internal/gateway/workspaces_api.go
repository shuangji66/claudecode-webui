package gateway

import (
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"ccweb/backend/internal/project"
	"ccweb/backend/internal/workspace"
)

// workspacesPayload 是前端启动与切换工作区所需的完整视图。
type workspacesPayload struct {
	Workspaces []workspace.Entry `json:"workspaces"`
	Current    string            `json:"current"`
	// Root 是 CCWEB_PROJECTS_ROOT，目录选择器把它作为默认起点。
	Root string `json:"root"`
}

func (s *Server) currentWorkspaces() workspacesPayload {
	payload := workspacesPayload{Workspaces: []workspace.Entry{}, Root: s.d.ProjectsRoot}
	if s.d.Workspaces == nil {
		return payload
	}
	payload.Workspaces = s.d.Workspaces.List()
	payload.Current = s.d.Workspaces.Current()
	return payload
}

func (s *Server) handleListWorkspaces(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.currentWorkspaces())
}

type workspaceReq struct {
	Path string `json:"path"`
}

// handleAddWorkspace 授权一个目录并切换过去。
func (s *Server) handleAddWorkspace(w http.ResponseWriter, r *http.Request) {
	if s.d.Workspaces == nil {
		writeErr(w, "工作区存储未启用", http.StatusServiceUnavailable)
		return
	}
	var req workspaceReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := s.d.Workspaces.Add(req.Path); err != nil {
		writeErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, s.currentWorkspaces())
}

// handleRemoveWorkspace 移除授权目录；仍有会话在用的目录不允许直接移除。
func (s *Server) handleRemoveWorkspace(w http.ResponseWriter, r *http.Request) {
	if s.d.Workspaces == nil {
		writeErr(w, "工作区存储未启用", http.StatusServiceUnavailable)
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		writeErr(w, "missing path", http.StatusBadRequest)
		return
	}
	abs := filepath.Clean(path)
	for _, info := range s.d.Manager.List() {
		if filepath.Clean(info.Cwd) == abs {
			writeErr(w, "该目录还有运行中的会话，请先关闭会话再移除", http.StatusConflict)
			return
		}
	}
	if err := s.d.Workspaces.Remove(abs); err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, workspace.ErrNotFound) {
			code = http.StatusNotFound
		}
		writeErr(w, err.Error(), code)
		return
	}
	writeJSON(w, s.currentWorkspaces())
}

// handleSetCurrentWorkspace 只切换当前工作区，不创建会话。
// 前端切换后会立刻调用 ensure，把 claude 拉起来。
func (s *Server) handleSetCurrentWorkspace(w http.ResponseWriter, r *http.Request) {
	if s.d.Workspaces == nil {
		writeErr(w, "工作区存储未启用", http.StatusServiceUnavailable)
		return
	}
	var req workspaceReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.d.Workspaces.SetCurrent(req.Path); err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, workspace.ErrNotFound) {
			code = http.StatusNotFound
		}
		writeErr(w, err.Error(), code)
		return
	}
	writeJSON(w, s.currentWorkspaces())
}

// handleRenameWorkspace 只改授权目录的显示名（侧栏、选择器里用它），不动真实路径。
func (s *Server) handleRenameWorkspace(w http.ResponseWriter, r *http.Request) {
	if s.d.Workspaces == nil {
		writeErr(w, "工作区存储未启用", http.StatusServiceUnavailable)
		return
	}
	var req struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.Path) == "" {
		writeErr(w, "missing path", http.StatusBadRequest)
		return
	}
	if _, err := s.d.Workspaces.Rename(req.Path, req.Name); err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, workspace.ErrNotFound) {
			code = http.StatusNotFound
		}
		writeErr(w, err.Error(), code)
		return
	}
	writeJSON(w, s.currentWorkspaces())
}

// handleMkdir 在指定目录下新建一层子目录，供「添加授权目录」弹窗的「新建文件夹」使用。
//
// 与浏览接口一样属于敏感能力（能在宿主机上创建目录），因此同样挂在 authed 后面；
// 目录名只允许单层，不允许分隔符（见 project.Mkdir）。
func (s *Server) handleMkdir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	dir, err := project.Mkdir(req.Path, req.Name)
	if err != nil {
		writeErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]string{"path": dir})
}

// fsPayload 是「添加授权目录」浏览器的返回。
type fsPayload struct {
	Path    string        `json:"path"`
	Parent  string        `json:"parent"`
	Entries []project.Dir `json:"entries"`
	Roots   []string      `json:"roots"`
}

// handleBrowseDirs 列出服务器上的目录，供前端目录选择器使用。
//
// 这是敏感接口（能枚举宿主机目录），因此必须挂在 authed 后面；路径不限制在
// ProjectsRoot 内，否则「授权任意目录」就无从操作。真正阻止越权使用的是
// 会话创建时的 workspace.Allows 校验，浏览本身只读。
func (s *Server) handleBrowseDirs(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	roots := s.browseRoots()
	if strings.TrimSpace(path) == "" {
		path = s.d.ProjectsRoot
		if path == "" && len(roots) > 0 {
			path = roots[0]
		}
	}
	hidden := false
	if v := r.URL.Query().Get("hidden"); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			hidden = b
		}
	}
	browse, err := project.Browse(path, hidden, project.DefaultLimit)
	if err != nil {
		writeErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, fsPayload{Path: browse.Path, Parent: browse.Parent, Entries: browse.Entries, Roots: roots})
}

// browseRoots 返回目录选择器的快捷入口：项目根 + 已授权目录，去重。
func (s *Server) browseRoots() []string {
	seen := make(map[string]bool)
	out := make([]string, 0, 4)
	add := func(p string) {
		p = filepath.Clean(strings.TrimSpace(p))
		if p == "" || p == "." || seen[p] {
			return
		}
		seen[p] = true
		out = append(out, p)
	}
	if s.d.ProjectsRoot != "" {
		add(s.d.ProjectsRoot)
	}
	if s.d.Workspaces != nil {
		for _, p := range s.d.Workspaces.Paths() {
			add(p)
		}
	}
	return out
}

// ensureCwdAuthorized 校验 cwd 是否在授权目录内。
// 未配置 workspaces（单测 / 旧配置）时不做限制，避免升级即不可用。
func (s *Server) ensureCwdAuthorized(abs string) error {
	if s.d.Workspaces == nil {
		return nil
	}
	if s.d.Workspaces.Allows(abs) {
		return nil
	}
	if s.d.ProjectsRoot != "" && filepath.Clean(abs) == filepath.Clean(s.d.ProjectsRoot) {
		return nil
	}
	return errors.New("目录未授权：请先在左侧「工作区」里添加该目录")
}
