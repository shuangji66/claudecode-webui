package gateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ccweb/backend/internal/mcp"
	"ccweb/backend/internal/settings"
)

// 这两组接口都能读改本机文件（MCP 配置、搜索密钥），鉴权与 cwd 围栏是硬要求。
// 网关层的测试不碰真实 claude：MCP 管理器挂在临时目录上就够。

func mcpReq(t *testing.T, srv *Server, method, target, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, target, nil)
	} else {
		req = httptest.NewRequest(method, target, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

// withMcp 给测试服务器装上 MCP 管理（配置文件都在临时目录里），返回用户级配置路径。
func withMcp(t *testing.T, srv *Server) string {
	t.Helper()
	dir := t.TempDir()
	user := filepath.Join(dir, "home", ".claude.json")
	srv.d.Mcp = mcp.New(user, filepath.Join(dir, "mcp-disabled.json"))
	return user
}

func TestMcpAndSearchRequireAuth(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	withMcp(t, srv)
	cases := []struct{ method, target string }{
		{http.MethodGet, "/api/mcp"},
		{http.MethodPost, "/api/mcp"},
		{http.MethodDelete, "/api/mcp?scope=user&name=x"},
		{http.MethodPost, "/api/mcp/enabled"},
		{http.MethodPost, "/api/mcp/probe"},
		{http.MethodGet, "/api/search"},
		{http.MethodPost, "/api/search/config"},
		{http.MethodPost, "/api/search/test"},
	}
	for _, c := range cases {
		if rec := mcpReq(t, srv, c.method, c.target, "", "{}"); rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s 无 token 应 401，实际 %d", c.method, c.target, rec.Code)
		}
	}
}

func TestMcpRoutesReturn503WithoutManager(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	// newTestServer 不装 Mcp：这套部署没有 MCP 管理。
	if rec := mcpReq(t, srv, http.MethodGet, "/api/mcp", "secret", ""); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("/api/mcp 应 503，实际 %d", rec.Code)
	}
	// 没有 MCP 管理时同步注册是空操作（不是错误）：搜索本身照样能用。
	if err := srv.EnsureSearchMCP(); err != nil {
		t.Fatalf("没有 MCP 管理时 EnsureSearchMCP 应空转: %v", err)
	}
	// 搜索状态本身不依赖 MCP，但必须明说这套部署不支持注册。
	rec := mcpReq(t, srv, http.MethodGet, "/api/search", "secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("/api/search 应 200，实际 %d", rec.Code)
	}
	var status map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status["mcp_supported"] != false {
		t.Fatalf("mcp_supported 应为 false: %v", status)
	}
}

// 密钥只回脱敏值：任何响应里出现明文都算泄漏（前端组件、日志、截图都会带着它）。
func TestSearchStatusNeverLeaksPlainKey(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	withMcp(t, srv)
	key := "sk-search-abcdefgh-1234567890"
	enabled := true
	if _, err := srv.d.Settings.Apply(settings.Patch{SearchAPIKey: &key, SearchEnabled: &enabled}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	rec := mcpReq(t, srv, http.MethodGet, "/api/search", "secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if strings.Contains(body, key) {
		t.Fatalf("响应里出现了明文密钥: %s", body)
	}
	var status struct {
		KeySet    bool   `json:"search_api_key_set"`
		KeyMasked string `json:"search_api_key_masked"`
		Attached  bool   `json:"attached"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if !status.KeySet || status.KeyMasked == "" {
		t.Fatalf("应回脱敏值: %+v", status)
	}
	if status.Attached {
		t.Fatal("还没注册时 attached 应为 false")
	}
}

// 项目级配置只能落在授权目录内：未授权 cwd 必须 403，且不创建任何文件。
func TestMcpProjectScopeRequiresAuthorizedCwd(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	withMcp(t, srv)
	outside := t.TempDir()
	body := `{"cwd":"` + outside + `","server":{"name":"x","scope":"project","type":"stdio","command":"node"}}`
	if rec := mcpReq(t, srv, http.MethodPost, "/api/mcp", "secret", body); rec.Code != http.StatusForbidden {
		t.Fatalf("未授权 cwd 应 403，实际 %d: %s", rec.Code, rec.Body.String())
	}
	// 用户级不需要 cwd，同一份配置里的 cwd 也不能把它带偏。
	userBody := `{"cwd":"` + outside + `","server":{"name":"y","scope":"user","type":"stdio","command":"node"}}`
	if rec := mcpReq(t, srv, http.MethodPost, "/api/mcp", "secret", userBody); rec.Code != http.StatusOK {
		t.Fatalf("用户级应 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
}

// 探测只接受已保存的服务名：请求里带命令进来等于给接口开了「免审批执行任意命令」。
func TestProbeOnlyAcceptsSavedServers(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	withMcp(t, srv)
	body := `{"scope":"user","name":"missing","command":"sh","args":["-c","echo hacked"]}`
	if rec := mcpReq(t, srv, http.MethodPost, "/api/mcp/probe", "secret", body); rec.Code != http.StatusNotFound {
		t.Fatalf("未保存的服务应 404，实际 %d: %s", rec.Code, rec.Body.String())
	}
	// 非法服务名同样要在触达文件系统之前被挡住。
	bad := `{"scope":"user","name":"../etc","command":"sh"}`
	if rec := mcpReq(t, srv, http.MethodPost, "/api/mcp", "secret", bad); rec.Code != http.StatusBadRequest {
		t.Fatalf("非法名字应 400，实际 %d: %s", rec.Code, rec.Body.String())
	}
}

// 注册内置搜索时要一并落到配置里的是「工具常驻工具表」：不然 claude 会把这两个
// 工具藏到 ToolSearch 后面，模型只看到名字、看不到描述，最终又得靠 CLAUDE.md 硬记。
//
// 注册动作现在归后端（`EnsureSearchMCP`），界面不再有「注册到 Claude」按钮。
func TestEnsureSearchMCPRegistersWhenEnabled(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	withMcp(t, srv)
	key, enabled := "sk-search-key", true
	if _, err := srv.d.Settings.Apply(settings.Patch{SearchAPIKey: &key, SearchEnabled: &enabled}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if err := srv.EnsureSearchMCP(); err != nil {
		t.Fatalf("EnsureSearchMCP: %v", err)
	}
	payload, err := srv.d.Mcp.List("")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	var found *mcp.Server
	for i := range payload.User {
		if payload.User[i].Name == mcpSearchServer {
			found = &payload.User[i]
		}
	}
	if found == nil {
		t.Fatalf("没注册上: %+v", payload.User)
	}
	if !found.AlwaysLoad {
		t.Fatal("内置搜索必须 alwaysLoad，否则模型看不到工具描述")
	}
	if found.Type != mcp.TypeStdio || found.Command == "" {
		t.Fatalf("注册形态不对: %+v", found)
	}

	// 状态里仍然回 attached：界面用它说一句「已注册 / 未注册」，但不再给按钮。
	rec := mcpReq(t, srv, http.MethodGet, "/api/search", "secret", "")
	var status struct {
		Attached bool `json:"attached"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if !status.Attached {
		t.Fatalf("状态不对: %+v", status)
	}
}

// 老版本注册的条目没有 alwaysLoad。以前靠界面那颗「重新注册」按钮补救，
// 现在由 Ensure 逐字段比对顺手改掉——否则那颗按钮一删，这些部署永远修不回来。
func TestEnsureSearchMCPRepairsLegacyEntry(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	withMcp(t, srv)
	key, enabled := "sk-search-key", true
	if _, err := srv.d.Settings.Apply(settings.Patch{SearchAPIKey: &key, SearchEnabled: &enabled}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if _, err := srv.d.Mcp.Save("", mcp.Server{
		Name:    mcpSearchServer,
		Scope:   mcp.ScopeUser,
		Type:    mcp.TypeStdio,
		Command: "/old/ccweb",
		Args:    []string{"mcp-web"},
	}); err != nil {
		t.Fatalf("写入老条目: %v", err)
	}
	if err := srv.EnsureSearchMCP(); err != nil {
		t.Fatalf("EnsureSearchMCP: %v", err)
	}
	cur, err := srv.d.Mcp.Find("", mcp.ScopeUser, mcpSearchServer)
	if err != nil {
		t.Fatalf("Find: %v", err)
	}
	if !cur.AlwaysLoad {
		t.Fatal("ensure 应该把老条目的 alwaysLoad 补上")
	}
	if cur.Command == "/old/ccweb" {
		t.Fatal("ensure 应该把命令改成当前二进制的绝对路径")
	}
}

// 关掉搜索就要把这条服务摘掉：留着它，模型照样看得见两个工具，
// 点进去只会得到「内置搜索未启用」，等于把开关做成了半成品。
func TestEnsureSearchMCPRemovesWhenDisabled(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	withMcp(t, srv)
	key, enabled := "sk-search-key", true
	if _, err := srv.d.Settings.Apply(settings.Patch{SearchAPIKey: &key, SearchEnabled: &enabled}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if err := srv.EnsureSearchMCP(); err != nil {
		t.Fatalf("EnsureSearchMCP: %v", err)
	}
	off := false
	if _, err := srv.d.Settings.Apply(settings.Patch{SearchEnabled: &off}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if err := srv.EnsureSearchMCP(); err != nil {
		t.Fatalf("EnsureSearchMCP: %v", err)
	}
	if _, err := srv.d.Mcp.Find("", mcp.ScopeUser, mcpSearchServer); !errors.Is(err, mcp.ErrNotFound) {
		t.Fatalf("关掉之后不该还在配置里: %v", err)
	}
	// 再关一次不能报错（启动时幂等调用）。
	if err := srv.EnsureSearchMCP(); err != nil {
		t.Fatalf("重复 EnsureSearchMCP: %v", err)
	}
}

// 配置一致时不要重写 .claude.json：那是 claude 自己的状态文件，
// 每次启动都动一遍只会多一份写坏的风险。
func TestEnsureSearchMCPLeavesFreshEntryAlone(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	userConfig := withMcp(t, srv)
	key, enabled := "sk-search-key", true
	if _, err := srv.d.Settings.Apply(settings.Patch{SearchAPIKey: &key, SearchEnabled: &enabled}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if err := srv.EnsureSearchMCP(); err != nil {
		t.Fatalf("EnsureSearchMCP: %v", err)
	}
	before, err := os.ReadFile(userConfig)
	if err != nil {
		t.Fatalf("读配置: %v", err)
	}
	if err := srv.EnsureSearchMCP(); err != nil {
		t.Fatalf("EnsureSearchMCP: %v", err)
	}
	after, err := os.ReadFile(userConfig)
	if err != nil {
		t.Fatalf("读配置: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("配置没变时不该重写 .claude.json")
	}
}

// 内置搜索也是「由 ccweb 维护」的一条：MCP 页面只留探测与停用，
// 编辑/删除一律 409（否则删完搜索面板还写着「已启用」，工具却没了）。
func TestBuiltinSearchMcpCannotBeEditedOrDeleted(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	withMcp(t, srv)
	key, enabled := "sk-search-key", true
	if _, err := srv.d.Settings.Apply(settings.Patch{SearchAPIKey: &key, SearchEnabled: &enabled}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if err := srv.EnsureSearchMCP(); err != nil {
		t.Fatalf("EnsureSearchMCP: %v", err)
	}

	rec := mcpReq(t, srv, http.MethodGet, "/api/mcp", "secret", "")
	var payload mcp.Payload
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	var found *mcp.Server
	for i := range payload.User {
		if payload.User[i].Name == mcpSearchServer {
			found = &payload.User[i]
		}
	}
	if found == nil || !found.Builtin {
		t.Fatalf("%s 应带 builtin 标记: %+v", mcpSearchServer, payload.User)
	}

	edited := `{"server":{"name":"` + mcpSearchServer + `","scope":"user","type":"stdio","command":"/bin/sh","args":["-c","x"]}}`
	if rec := mcpReq(t, srv, http.MethodPost, "/api/mcp", "secret", edited); rec.Code != http.StatusConflict {
		t.Fatalf("编辑内置搜索应 409，实际 %d: %s", rec.Code, rec.Body.String())
	}
	del := "/api/mcp?scope=user&name=" + mcpSearchServer
	if rec := mcpReq(t, srv, http.MethodDelete, del, "secret", ""); rec.Code != http.StatusConflict {
		t.Fatalf("删除内置搜索应 409，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if _, err := srv.d.Mcp.Find("", mcp.ScopeUser, mcpSearchServer); err != nil {
		t.Fatalf("被拒的删除不能真删掉配置: %v", err)
	}
}

// 会话层的两条规则：放行面板自己的搜索工具，挡掉 claude 自带的 WebSearch/WebFetch。
// 名字必须与 mcp__<服务名>__<工具> 的拼法一致，否则放行的是不存在的工具。
func TestSearchToolRules(t *testing.T) {
	allow, deny := SearchToolRules()
	wantAllow := map[string]bool{
		"mcp__" + SearchMCPServer + "__web_search": true,
		"mcp__" + SearchMCPServer + "__web_fetch":  true,
	}
	if len(allow) != len(wantAllow) {
		t.Fatalf("allow = %v", allow)
	}
	for _, n := range allow {
		if !wantAllow[n] {
			t.Fatalf("多出/写错了放行项: %v", allow)
		}
	}
	if len(deny) != 2 || deny[0] != "WebSearch" || deny[1] != "WebFetch" {
		t.Fatalf("deny = %v", deny)
	}
}

// 内置服务（自动化任务的 ccweb-schedule）不能改也不能删：启动流程每次都会把它写回
// 配置，改完下次启动被覆盖、删掉下次启动又长回来，中间那段时间只是让模型白丢三个工具。
// 列表要打 builtin 标记（界面据此只留探测与启停），POST/DELETE 也直接回 409。
func TestBuiltinScheduleMcpCannotBeEditedOrDeleted(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	withMcp(t, srv)
	if err := srv.EnsureScheduleMCP(); err != nil {
		t.Fatalf("注册自动化任务 MCP: %v", err)
	}

	rec := mcpReq(t, srv, http.MethodGet, "/api/mcp", "secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("列表应 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
	var payload mcp.Payload
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	var found *mcp.Server
	for i := range payload.User {
		if payload.User[i].Name == ScheduleMCPServer {
			found = &payload.User[i]
		}
	}
	if found == nil {
		t.Fatalf("列表里没有 %s: %+v", ScheduleMCPServer, payload.User)
	}
	if !found.Builtin {
		t.Fatalf("自动化任务 MCP 应带 builtin 标记: %+v", *found)
	}

	// 编辑同样拒绝：改了下次启动会被 EnsureScheduleMCP 覆盖回原样。
	edited := `{"server":{"name":"` + ScheduleMCPServer + `","scope":"user","type":"stdio","command":"/bin/sh","args":["-c","x"]}}`
	if rec := mcpReq(t, srv, http.MethodPost, "/api/mcp", "secret", edited); rec.Code != http.StatusConflict {
		t.Fatalf("编辑内置服务应 409，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if cur, err := srv.d.Mcp.Find("", mcp.ScopeUser, ScheduleMCPServer); err != nil || cur.Command == "/bin/sh" {
		t.Fatalf("被拒的编辑不能真写进配置: %+v / %v", cur, err)
	}

	del := "/api/mcp?scope=user&name=" + ScheduleMCPServer
	if rec := mcpReq(t, srv, http.MethodDelete, del, "secret", ""); rec.Code != http.StatusConflict {
		t.Fatalf("删除内置服务应 409，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if _, err := srv.d.Mcp.Find("", mcp.ScopeUser, ScheduleMCPServer); err != nil {
		t.Fatalf("被拒的删除不能真删掉配置: %v", err)
	}

	// 普通服务照旧可以删：这次改动只针对内置的那几条。
	body := `{"server":{"name":"github","scope":"user","type":"stdio","command":"npx"}}`
	if rec := mcpReq(t, srv, http.MethodPost, "/api/mcp", "secret", body); rec.Code != http.StatusOK {
		t.Fatalf("保存普通服务应 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if rec := mcpReq(t, srv, http.MethodDelete, "/api/mcp?scope=user&name=github", "secret", ""); rec.Code != http.StatusOK {
		t.Fatalf("删除普通服务应 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
}
