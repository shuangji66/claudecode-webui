// 内置浏览器：HTTP 接口 + 用户级 MCP 注册。
//
// 与内置搜索/自动化任务的分工一样：网关负责「把它注册进 claude 的 mcpServers」，
// 真正的工具在子命令 `ccweb mcp-browser` 里，浏览器内核与 playwright 包由
// internal/browserbin 托管下载（固定版本，装到 CCWEB_DATA_DIR 下）。
package gateway

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"ccweb/backend/internal/browserbin"
	"ccweb/backend/internal/mcp"
)

// BrowserMCPServer 是写进 claude 的 mcpServers 的键名（也是工具名前缀）。
const BrowserMCPServer = "ccweb-browser"

// browserTools 是内置浏览器暴露给模型的工具（`ccweb mcp-browser`）。
//
// 与内置搜索/自动化任务同一处理：这些工具只操作模型自己打开的页面，
// 不写工作区、不改配置。不预放行的话每一步点击都要弹一次审批，用户很快就会
// 切到「跳过权限」——那等于把所有工具一起放开，比只放开这几个更糟。
var browserTools = []string{
	"mcp__" + BrowserMCPServer + "__browser_open",
	"mcp__" + BrowserMCPServer + "__browser_snapshot",
	"mcp__" + BrowserMCPServer + "__browser_text",
	"mcp__" + BrowserMCPServer + "__browser_click",
	"mcp__" + BrowserMCPServer + "__browser_type",
	"mcp__" + BrowserMCPServer + "__browser_press",
	"mcp__" + BrowserMCPServer + "__browser_screenshot",
	"mcp__" + BrowserMCPServer + "__browser_eval",
	"mcp__" + BrowserMCPServer + "__browser_status",
	"mcp__" + BrowserMCPServer + "__browser_close",
}

// BrowserToolRules 返回内置浏览器注册后该预先放行的工具名。
func BrowserToolRules() []string { return browserTools }

// EnsureBrowserMCP 把 `ccweb mcp-browser` 注册成用户级 MCP 服务（幂等）。
//
// 无条件注册（即使运行时还没下载）：模型看到工具、点进去得到一句「去设置里安装」，
// 比「工具根本不存在」更容易让人知道下一步做什么。运行时的下载由界面触发。
func (s *Server) EnsureBrowserMCP() error {
	if s.d.Mcp == nil {
		return nil
	}
	exe := selfPath()
	if exe == "" {
		return errors.New("无法确定 ccweb 可执行文件路径")
	}
	env := map[string]string{"CCWEB_DATA_DIR": s.d.Cfg.DataDir}
	if s.d.Cfg.BrowserDir != "" {
		env["CCWEB_BROWSER_DIR"] = s.d.Cfg.BrowserDir
	}
	want := mcp.Server{
		Name:    BrowserMCPServer,
		Scope:   mcp.ScopeUser,
		Type:    mcp.TypeStdio,
		Command: exe,
		Args:    []string{"mcp-browser"},
		Env:     env,
		// 与另两个内置服务同一理由：延迟加载只把裸名字发给模型，
		// 它认不出 `mcp__ccweb-browser__browser_open` 是「打开网页」。
		AlwaysLoad: true,
	}
	if cur, err := s.d.Mcp.Find("", mcp.ScopeUser, BrowserMCPServer); err == nil {
		if cur.Command == want.Command && sameStrings(cur.Args, want.Args) && sameEnv(cur.Env, want.Env) {
			return nil
		}
	}
	_, err := s.d.Mcp.Save("", want)
	return err
}

// writeBrowserError 把 browserbin 的哨兵错误映射成状态码。
func writeBrowserError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, browserbin.ErrBusy):
		writeErr(w, "已有安装任务在进行，请等它结束或先取消", http.StatusConflict)
	case errors.Is(err, browserbin.ErrNoNode):
		writeErr(w, "找不到 node 运行时：内置浏览器需要 node（本应用安装时依赖 nodejs_v24，如果被卸载请先装回）", http.StatusBadRequest)
	case errors.Is(err, browserbin.ErrBadSource):
		writeErr(w, "未知的下载源", http.StatusBadRequest)
	default:
		writeErr(w, err.Error(), http.StatusInternalServerError)
	}
}

// handleBrowserStatus 返回运行时的完整快照（安装状态 / 内核 / 进度）。
func (s *Server) handleBrowserStatus(w http.ResponseWriter, r *http.Request) {
	if s.d.Browser == nil {
		writeErr(w, "内置浏览器未启用", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, s.d.Browser.Status())
}

// handleBrowserInstall 触发一次安装（后台任务，进度靠轮询 status）。
func (s *Server) handleBrowserInstall(w http.ResponseWriter, r *http.Request) {
	if s.d.Browser == nil {
		writeErr(w, "内置浏览器未启用", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		Source string `json:"source"`
	}
	// 空 body 是合法的（用默认源）；给了 body 就必须是合法 JSON，否则静默忽略
	// 会让「我明明指定了源却还是用了默认」这种问题查不出来。
	if r.Body != nil {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
			return
		}
	}
	if err := s.d.Browser.StartInstall(body.Source); err != nil {
		writeBrowserError(w, err)
		return
	}
	writeJSON(w, s.d.Browser.Status())
}

// handleBrowserCancel 取消进行中的安装（幂等）。
func (s *Server) handleBrowserCancel(w http.ResponseWriter, r *http.Request) {
	if s.d.Browser == nil {
		writeErr(w, "内置浏览器未启用", http.StatusServiceUnavailable)
		return
	}
	if err := s.d.Browser.Cancel(); err != nil {
		writeBrowserError(w, err)
		return
	}
	writeJSON(w, s.d.Browser.Status())
}

// handleBrowserRemove 删除已下载的运行时（内核 + playwright 包）。
func (s *Server) handleBrowserRemove(w http.ResponseWriter, r *http.Request) {
	if s.d.Browser == nil {
		writeErr(w, "内置浏览器未启用", http.StatusServiceUnavailable)
		return
	}
	if err := s.d.Browser.Remove(); err != nil {
		writeBrowserError(w, err)
		return
	}
	writeJSON(w, s.d.Browser.Status())
}
