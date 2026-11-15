package gateway

import (
	"encoding/json"
	"net/http"
	"strconv"

	"ccweb/backend/internal/gitctl"
)

// gitReq 是 Git 面板 POST 的统一请求体。
type gitReq struct {
	Cwd     string `json:"cwd"`
	Path    string `json:"path,omitempty"`
	Message string `json:"message,omitempty"`
	Hash    string `json:"hash,omitempty"`
	Branch  string `json:"branch,omitempty"`
}

func (s *Server) decodeGitReq(w http.ResponseWriter, r *http.Request) (gitReq, string, bool) {
	var req gitReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return req, "", false
	}
	cwd, err := s.authorizedCwd(req.Cwd)
	if err != nil {
		s.writeCwdError(w, err)
		return req, "", false
	}
	return req, cwd, true
}

func (s *Server) gitCwd(w http.ResponseWriter, r *http.Request) (string, bool) {
	cwd, err := s.authorizedCwd(r.URL.Query().Get("cwd"))
	if err != nil {
		s.writeCwdError(w, err)
		return "", false
	}
	return cwd, true
}

func writeGitError(w http.ResponseWriter, err error) {
	writeErr(w, err.Error(), http.StatusBadRequest)
}

// handleGitStatus 返回 Git 面板快照；不是仓库时返回 is_repo=false。
func (s *Server) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	cwd, ok := s.gitCwd(w, r)
	if !ok {
		return
	}
	status, err := gitctl.ReadStatus(r.Context(), cwd)
	if err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, status)
}

// handleGitDiff 返回工作区或索引侧的补丁。
func (s *Server) handleGitDiff(w http.ResponseWriter, r *http.Request) {
	cwd, ok := s.gitCwd(w, r)
	if !ok {
		return
	}
	staged := false
	if raw := r.URL.Query().Get("staged"); raw != "" {
		staged, _ = strconv.ParseBool(raw)
	}
	diff, err := gitctl.Diff(r.Context(), cwd, r.URL.Query().Get("path"), staged)
	if err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, map[string]string{"diff": diff})
}

// handleGitShow 返回一次提交的补丁。
func (s *Server) handleGitShow(w http.ResponseWriter, r *http.Request) {
	cwd, ok := s.gitCwd(w, r)
	if !ok {
		return
	}
	diff, err := gitctl.Show(r.Context(), cwd, r.URL.Query().Get("hash"))
	if err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, map[string]string{"diff": diff})
}

// handleGitLog 返回最近提交。
func (s *Server) handleGitLog(w http.ResponseWriter, r *http.Request) {
	cwd, ok := s.gitCwd(w, r)
	if !ok {
		return
	}
	count, _ := strconv.Atoi(r.URL.Query().Get("count"))
	skip, _ := strconv.Atoi(r.URL.Query().Get("skip"))
	entries, err := gitctl.Log(r.Context(), cwd, count, skip)
	if err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, map[string]any{"entries": entries})
}

// handleGitBranches 返回本地分支清单。
func (s *Server) handleGitBranches(w http.ResponseWriter, r *http.Request) {
	cwd, ok := s.gitCwd(w, r)
	if !ok {
		return
	}
	branches, err := gitctl.ListBranches(r.Context(), cwd)
	if err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, branches)
}

// handleGitStage 暂存单个文件或全部（path 为空）。
func (s *Server) handleGitStage(w http.ResponseWriter, r *http.Request) {
	req, cwd, ok := s.decodeGitReq(w, r)
	if !ok {
		return
	}
	if err := gitctl.Stage(r.Context(), cwd, req.Path); err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handleGitUnstage 取消暂存单个文件或全部。
func (s *Server) handleGitUnstage(w http.ResponseWriter, r *http.Request) {
	req, cwd, ok := s.decodeGitReq(w, r)
	if !ok {
		return
	}
	if err := gitctl.Unstage(r.Context(), cwd, req.Path); err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handleGitDiscard 丢弃一个已跟踪文件的工作区改动。
func (s *Server) handleGitDiscard(w http.ResponseWriter, r *http.Request) {
	req, cwd, ok := s.decodeGitReq(w, r)
	if !ok {
		return
	}
	if err := gitctl.Discard(r.Context(), cwd, req.Path); err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handleGitCommit 提交已暂存内容（沿用用户 git 身份）。
func (s *Server) handleGitCommit(w http.ResponseWriter, r *http.Request) {
	req, cwd, ok := s.decodeGitReq(w, r)
	if !ok {
		return
	}
	if err := gitctl.Commit(r.Context(), cwd, req.Message); err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handleGitCheckout 切换本地分支。
func (s *Server) handleGitCheckout(w http.ResponseWriter, r *http.Request) {
	req, cwd, ok := s.decodeGitReq(w, r)
	if !ok {
		return
	}
	if err := gitctl.Checkout(r.Context(), cwd, req.Branch); err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handleGitSync 先 fast-forward pull，再 push。两步分开调用，失败信息原样返回。
func (s *Server) handleGitSync(w http.ResponseWriter, r *http.Request) {
	_, cwd, ok := s.decodeGitReq(w, r)
	if !ok {
		return
	}
	if err := gitctl.Pull(r.Context(), cwd); err != nil {
		writeGitError(w, err)
		return
	}
	if err := gitctl.Push(r.Context(), cwd); err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}
