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
// 这里的接口分工：
//   - GET  /api/search          读配置 + 是否已注册（不返回密钥明文）
//   - POST /api/search/config   保存基地址/密钥/条数/开关（复用 settings 的校验），
//     保存后立刻 EnsureSearchMCP 同步一次注册状态
//   - POST /api/search/test     用已保存的配置真打一次，验证网关到底支不支持
//
// **没有 attach / detach**：这条服务与自动化任务、内置浏览器一样由本应用维护
// （`EnsureSearchMCP`），界面上只剩「启用」与 MCP 页的「停用」两个开关。
// 曾经有手工的「注册到 Claude / 移除」两颗按钮，于是同一份用户级配置有了两个入口：
// MCP 页能删、面板能注册，删掉之后 search_enabled 还是 true、会话规则还放行那两个工具，
// 但服务不存在——表现就是「搜索莫名其妙不能用」。

// mcpSearchServer 是写进 claude 的 mcpServers 的键名。
const mcpSearchServer = "ccweb-web"

// SearchMCPServer 是对外暴露的服务名：装配层要靠它判断「内置搜索是否已注册」。
const SearchMCPServer = mcpSearchServer

// 内置搜索注册后，会话层面的两条工具规则（见 SearchToolRules）。
var (
	searchDisallowedTools = []string{"WebSearch", "WebFetch"}
	searchAllowedTools    = []string{
		"mcp__" + mcpSearchServer + "__web_search",
		"mcp__" + mcpSearchServer + "__web_fetch",
	}
)

// SearchToolRules 返回内置搜索启用时该加到会话上的工具规则：允许面板自己的两个
// 搜索工具、禁止 claude 内置的 WebSearch/WebFetch。
//
// 为什么要在会话参数里做，而不是让用户去改 settings.json：
//   - 内置那两个工具在自建中转下走的是 Anthropic 服务端工具，通常根本调不通；
//     但它们仍会以裸名字出现在延迟工具名单里，和 mcp__ccweb-web__web_search 抢选择。
//     实测 --disallowedTools 会把它们从延迟名单里一并抹掉，模型看不到也就不会试。
//   - MCP 工具默认要过 can_use_tool 审批。每搜一次弹一次审批（或被拒一次）之后，
//     模型就学会不用它了。允许列表让搜索像 Read 一样直接可用——代价是它会自己花钱，
//     所以调用方必须先确认「用户真的启用了搜索」。
//
// 规则随会话进程启动而定：注册/取消注册之后新建的会话才生效，与 MCP server 本身的
// 生命周期一致（都是会话启动时连接的）。
func SearchToolRules() (allow, deny []string) {
	return searchAllowedTools, searchDisallowedTools
}

type searchStatus struct {
	BaseURL   string `json:"base_url"`
	Count     int    `json:"search_count"`
	Enabled   bool   `json:"search_enabled"`
	KeySet    bool   `json:"search_api_key_set"`
	KeyMasked string `json:"search_api_key_masked"`
	// Attached 表示用户级配置里**真的有**这条服务（claude 能连上）。界面只用它说一句
	// 状态，注册/移除不再由用户点（见 EnsureSearchMCP）。
	Attached bool `json:"attached"`
	// Disabled 表示这条服务被「停用」摘进了本应用的暂存（不在 claude 的配置里）。
	// 它和 Attached 互斥，界面据此说「已停用（去用户级列表里启用）」而不是「已注册」。
	Disabled bool `json:"disabled"`
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
		if srv.Name != mcpSearchServer {
			continue
		}
		// `List` 会把「停用暂存」里的条目一起列出来（界面要能看到并重新启用），
		// 但那一条已经不在 claude 的配置里、会话根本连不上——停用的服务算「已注册」
		// 的话，面板上就会写「已注册，要关就点停用」，而它其实早就关了。
		// 两者互斥：同一时刻只可能是其中一种（配置里已有的同名条目会盖掉暂存那条）。
		if srv.Disabled {
			out.Disabled = true
		} else {
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
	// 启用/改密钥/关掉都要立刻同步注册状态：否则要么等到下次重启才生效（用户以为
	// 开关没用），要么服务还在、密钥已经换了（工具照旧失败）。
	if err := s.EnsureSearchMCP(); err != nil {
		// 配置已经落盘了，这里必须说清楚是哪一步失败，不能让人以为保存没生效。
		writeErr(w, "配置已保存，但同步 MCP 注册失败: "+err.Error(), http.StatusInternalServerError)
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

// EnsureSearchMCP 把内置搜索同步成用户级 MCP 服务（幂等）。
//
// 与自动化任务 / 内置浏览器同一套：这条配置归本应用所有，启动时与每次保存设置后
// 都对齐一次，界面上只剩「启用」与 MCP 页的「停用」两个开关。
//
// 启用且填了密钥 → 写进配置（带 alwaysLoad，见下）；否则从配置里删掉。
// 判定「要不要写」不看配置里有没有，而是逐字段比对——老版本注册的条目没有
// alwaysLoad，只有比对才会被这次启动顺手修好，而不是永远留一颗「重新注册」按钮。
func (s *Server) EnsureSearchMCP() error {
	if s.d.Mcp == nil {
		return nil
	}
	cur := s.d.Settings.Get()
	if !cur.SearchEnabled || cur.SearchAPIKey == "" {
		// 不存在也算成功（Delete 对 ErrNotFound 之外才报错）。
		if err := s.d.Mcp.Delete("", mcp.ScopeUser, mcpSearchServer); err != nil && !errors.Is(err, mcp.ErrNotFound) {
			return err
		}
		return nil
	}
	exe := selfPath()
	if exe == "" {
		return errors.New("无法确定 ccweb 可执行文件路径")
	}
	// env 让子命令读同一份设置：数据目录用于兜底定位，配置文件路径优先。
	env := map[string]string{"CCWEB_DATA_DIR": s.d.Cfg.DataDir}
	if s.d.Cfg.SettingsFile != "" {
		env["CCWEB_SETTINGS_FILE"] = s.d.Cfg.SettingsFile
	}
	want := mcp.Server{
		Name:    mcpSearchServer,
		Scope:   mcp.ScopeUser,
		Type:    mcp.TypeStdio,
		Command: exe,
		Args:    []string{"mcp-web"},
		Env:     env,
		// 必须常驻工具表：默认的延迟加载只把工具名发给模型、不带描述，
		// 模型不会意识到这个 MCP 服务是「联网搜索」，只能靠用户在 CLAUDE.md 里硬写。
		AlwaysLoad: true,
	}
	// Find 会连「停用暂存」一起看：停用中的条目不等于不存在，Save 会改暂存副本、
	// 不会把它顺手启用（这是「停用」能在重启后保持的原因）。
	if cur2, err := s.d.Mcp.Find("", mcp.ScopeUser, mcpSearchServer); err == nil {
		if cur2.Type == want.Type && cur2.Command == want.Command &&
			sameStrings(cur2.Args, want.Args) && sameEnv(cur2.Env, want.Env) && cur2.AlwaysLoad {
			return nil
		}
	}
	_, err := s.d.Mcp.Save("", want)
	return err
}
