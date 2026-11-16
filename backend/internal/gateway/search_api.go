package gateway

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"time"

	"ccweb/backend/internal/mcp"
	"ccweb/backend/internal/search"
	"ccweb/backend/internal/settings"
)

// 内置搜索：把 DeepSeek 的 Search / Fetch API 通过「本二进制的一个 MCP 子命令」
// （`ccweb mcp-web`）接到 claude 上。
//
// 为什么不是 Claude Code 的 plugin：plugin 要走 marketplace 与 `claude plugin`
// 安装，本项目没有那条链路；MCP 反而是它已经管起来的东西。
//
// 这里的四个接口分工：
//   - GET  /api/search          读配置 + 是否已注册（不返回密钥明文）
//   - POST /api/search/config   保存基地址/密钥/条数/开关（复用 settings 的校验）
//   - POST /api/search/test     用已保存的配置真打一次，验证网关到底支不支持
//   - POST /api/search/attach   注册到**用户级** MCP 配置（全局生效）
//   - POST /api/search/detach   从用户级配置里移除

// mcpSearchServer 是写进 claude 的 mcpServers 的键名。
const mcpSearchServer = "ccweb-web"

type searchStatus struct {
	BaseURL   string `json:"base_url"`
	Count     int    `json:"search_count"`
	Enabled   bool   `json:"search_enabled"`
	KeySet    bool   `json:"search_api_key_set"`
	KeyMasked string `json:"search_api_key_masked"`
	// Attached 表示用户级 MCP 配置里已经有这条内置服务。
	Attached bool `json:"attached"`
	// ServerName / Command 供界面显示「注册成了什么、用的哪个二进制」。
	ServerName string `json:"server_name"`
	Command    string `json:"command"`
	// MCPSupported 为 false 表示这套部署没有装 MCP 管理（Deps.Mcp 为 nil）。
	MCPSupported bool `json:"mcp_supported"`
}

// selfPath 返回当前可执行文件路径：注册 MCP 服务时要用绝对路径。
func selfPath() string {
	if p, err := os.Executable(); err == nil {
		return p
	}
	return ""
}

func (s *Server) searchStatus() searchStatus {
	cur := s.d.Settings.Get()
	out := searchStatus{
		BaseURL: cur.SearchBaseURL,
		Count:   cur.SearchCount,
		Enabled: cur.SearchEnabled,
		KeySet:  cur.SearchAPIKey != "",
		// 与设置页其它密钥同一套脱敏（settings.Mask）：同一个密钥在两处显示成
		// 两种样子，用户会以为存的是两把不同的钥匙。
		KeyMasked:  settings.Mask(cur.SearchAPIKey),
		ServerName: mcpSearchServer,
		Command:    selfPath(),
	}
	if s.d.Mcp == nil {
		return out
	}
	out.MCPSupported = true
	payload, err := s.d.Mcp.List("")
	if err != nil {
		return out
	}
	for _, srv := range payload.User {
		if srv.Name == mcpSearchServer {
			out.Attached = true
		}
	}
	return out
}

func (s *Server) handleGetSearch(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.searchStatus())
}

// handleSaveSearch 保存内置搜索配置。
//
// 走 settings.Apply 而不是自己写盘：那里已经有「空串=沿用旧值」「clear_key 才清空」
// 的语义与校验，重复一份必然会漂移。
func (s *Server) handleSaveSearch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		BaseURL  *string `json:"base_url"`
		APIKey   *string `json:"api_key"`
		ClearKey *bool   `json:"clear_key"`
		Count    *int    `json:"count"`
		Enabled  *bool   `json:"enabled"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := s.d.Settings.Apply(settings.Patch{
		SearchBaseURL:  body.BaseURL,
		SearchAPIKey:   body.APIKey,
		SearchClearKey: body.ClearKey,
		SearchCount:    body.Count,
		SearchEnabled:  body.Enabled,
	}); err != nil {
		writeErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, s.searchStatus())
}

// handleTestSearch 用已保存的配置打一次搜索。
//
// 为什么必须用**已保存**的配置：测试按钮的意义是验证「现在这套设置能不能用」，
// 顺手把未保存的密钥塞进来测通、再忘点保存，只会让人以为配好了。
func (s *Server) handleTestSearch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Query string `json:"query"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body)
	cur := s.d.Settings.Get()
	if cur.SearchAPIKey == "" {
		writeErr(w, "还没填搜索密钥", http.StatusBadRequest)
		return
	}
	q := body.Query
	if q == "" {
		q = "deepseek"
	}
	start := time.Now()
	results, err := search.Search(r.Context(), cur.SearchBaseURL, cur.SearchAPIKey, q, cur.SearchCount)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "latency_ms": latency, "error": err.Error()})
		return
	}
	// 只回前几条的标题与链接：测试按钮的用途是「通不通」。
	preview := make([]map[string]string, 0, len(results))
	for i, res := range results {
		if i >= 3 {
			break
		}
		preview = append(preview, map[string]string{"title": res.Title, "url": res.URL})
	}
	writeJSON(w, map[string]any{"ok": true, "latency_ms": latency, "count": len(results), "results": preview})
}

// handleAttachSearch 把内置搜索注册成用户级 MCP 服务（全局生效）。
func (s *Server) handleAttachSearch(w http.ResponseWriter, r *http.Request) {
	if s.d.Mcp == nil {
		writeErr(w, "MCP 管理未启用", http.StatusServiceUnavailable)
		return
	}
	exe := selfPath()
	if exe == "" {
		writeErr(w, "无法确定 ccweb 可执行文件路径", http.StatusInternalServerError)
		return
	}
	if cur := s.d.Settings.Get(); !cur.SearchEnabled || cur.SearchAPIKey == "" {
		writeErr(w, "先启用内置搜索并填写密钥，再注册到 Claude", http.StatusBadRequest)
		return
	}
	// env 让子命令读同一份设置：数据目录用于兜底定位，配置文件路径优先。
	env := map[string]string{"CCWEB_DATA_DIR": s.d.Cfg.DataDir}
	if s.d.Cfg.SettingsFile != "" {
		env["CCWEB_SETTINGS_FILE"] = s.d.Cfg.SettingsFile
	}
	if _, err := s.d.Mcp.Save("", mcp.Server{
		Name:    mcpSearchServer,
		Scope:   mcp.ScopeUser,
		Type:    mcp.TypeStdio,
		Command: exe,
		Args:    []string{"mcp-web"},
		Env:     env,
	}); err != nil {
		writeMcpError(w, err)
		return
	}
	writeJSON(w, s.searchStatus())
}

// handleDetachSearch 把内置搜索从用户级配置里移除（不存在也算成功）。
func (s *Server) handleDetachSearch(w http.ResponseWriter, r *http.Request) {
	if s.d.Mcp == nil {
		writeErr(w, "MCP 管理未启用", http.StatusServiceUnavailable)
		return
	}
	if err := s.d.Mcp.Delete("", mcp.ScopeUser, mcpSearchServer); err != nil && !errors.Is(err, mcp.ErrNotFound) {
		writeMcpError(w, err)
		return
	}
	writeJSON(w, s.searchStatus())
}
