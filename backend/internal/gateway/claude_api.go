package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"ccweb/backend/internal/claudebin"
)

// ClaudeDeployer 是网关对「claude 版本管理」子域的依赖。
//
// 抽成接口有两个原因：网关单测不该去连 npm registry；以及安装是后台任务，
// 网关只负责触发与查询，不持有任务状态。
type ClaudeDeployer interface {
	Status() claudebin.Status
	Check(ctx context.Context) (claudebin.CheckResult, error)
	StartInstall(version, source string) error
	CancelInstall() error
	Delete(version string) error
	SetActive(version string) error
	SetSource(source string) error
}

// requireDeploy 在未装配部署管理时直接 503，避免各 handler 重复判空。
func (s *Server) requireDeploy(w http.ResponseWriter) bool {
	if s.d.Claude == nil {
		writeErr(w, "部署管理未启用", http.StatusServiceUnavailable)
		return false
	}
	return true
}

// handleClaudeStatus 返回本机平台、已安装版本、生效版本与安装进度。
func (s *Server) handleClaudeStatus(w http.ResponseWriter, r *http.Request) {
	if !s.requireDeploy(w) {
		return
	}
	writeJSON(w, s.d.Claude.Status())
}

// handleClaudeCheck 查询 registry 最新版本与近期版本列表。
//
// 走 registry 可能几十 KB 到 600KB，给 20 秒上限；失败是常态（内网/离线），
// 前端只把错误显示在部署页，不影响其它功能。
func (s *Server) handleClaudeCheck(w http.ResponseWriter, r *http.Request) {
	if !s.requireDeploy(w) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	res, err := s.d.Claude.Check(ctx)
	if err != nil {
		writeErr(w, "检查更新失败: "+err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, res)
}

type installClaudeReq struct {
	Version string `json:"version"`
	Source  string `json:"source"`
}

// handleClaudeInstall 触发后台安装，立即返回；进度靠 /api/claude/status 轮询。
func (s *Server) handleClaudeInstall(w http.ResponseWriter, r *http.Request) {
	if !s.requireDeploy(w) {
		return
	}
	var req installClaudeReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.Version) == "" {
		writeErr(w, "缺少要安装的版本号", http.StatusBadRequest)
		return
	}
	err := s.d.Claude.StartInstall(req.Version, req.Source)
	switch {
	case err == nil:
		writeJSON(w, s.d.Claude.Status())
	case errors.Is(err, claudebin.ErrBusy):
		writeErr(w, err.Error(), http.StatusConflict)
	case errors.Is(err, claudebin.ErrInstalled):
		writeErr(w, err.Error(), http.StatusConflict)
	default:
		writeErr(w, err.Error(), http.StatusBadRequest)
	}
}

// handleClaudeCancel 取消正在进行的安装；没有任务时也返回当前状态（幂等）。
func (s *Server) handleClaudeCancel(w http.ResponseWriter, r *http.Request) {
	if !s.requireDeploy(w) {
		return
	}
	if err := s.d.Claude.CancelInstall(); err != nil {
		writeErr(w, "取消安装失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, s.d.Claude.Status())
}

// handleClaudeDelete 删除一个已安装且未生效的版本；仍在运行的会话用的版本不能删。
func (s *Server) handleClaudeDelete(w http.ResponseWriter, r *http.Request) {
	if !s.requireDeploy(w) {
		return
	}
	version := strings.TrimSpace(r.URL.Query().Get("version"))
	if version == "" {
		writeErr(w, "缺少要删除的版本号", http.StatusBadRequest)
		return
	}
	var bin string
	for _, v := range s.d.Claude.Status().Installed {
		if v.Version == version {
			bin = v.Path
			break
		}
	}
	if bin == "" {
		writeErr(w, "该版本未安装", http.StatusNotFound)
		return
	}
	if s.d.Manager.InUse(bin) {
		writeErr(w, "该版本仍被运行中的会话使用，请先结束这些会话", http.StatusConflict)
		return
	}
	if err := s.d.Claude.Delete(version); err != nil {
		if errors.Is(err, claudebin.ErrActive) {
			writeErr(w, err.Error(), http.StatusConflict)
		} else {
			writeErr(w, err.Error(), http.StatusBadRequest)
		}
		return
	}
	writeJSON(w, s.d.Claude.Status())
}

type activateClaudeReq struct {
	Version string `json:"version"`
}

// handleClaudeActive 切换生效版本；只影响之后新建的会话。
func (s *Server) handleClaudeActive(w http.ResponseWriter, r *http.Request) {
	if !s.requireDeploy(w) {
		return
	}
	var req activateClaudeReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.d.Claude.SetActive(req.Version); err != nil {
		writeErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, s.d.Claude.Status())
}

type claudeSourceReq struct {
	Source string `json:"source"`
}

// handleClaudeSource 记住下载源偏好（只影响后续安装）。
func (s *Server) handleClaudeSource(w http.ResponseWriter, r *http.Request) {
	if !s.requireDeploy(w) {
		return
	}
	var req claudeSourceReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.d.Claude.SetSource(req.Source); err != nil {
		writeErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, s.d.Claude.Status())
}
