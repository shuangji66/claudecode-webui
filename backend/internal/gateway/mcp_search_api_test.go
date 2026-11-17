package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

// withMcp 给测试服务器装上 MCP 管理（配置文件都在临时目录里）。
func withMcp(t *testing.T, srv *Server) {
	t.Helper()
	dir := t.TempDir()
	srv.d.Mcp = mcp.New(filepath.Join(dir, "home", ".claude.json"), filepath.Join(dir, "mcp-disabled.json"))
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
		{http.MethodPost, "/api/search/attach"},
		{http.MethodPost, "/api/search/detach"},
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
	if rec := mcpReq(t, srv, http.MethodPost, "/api/search/attach", "secret", "{}"); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("/api/search/attach 应 503，实际 %d", rec.Code)
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
func TestAttachSearchSetsAlwaysLoad(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	withMcp(t, srv)
	key, enabled := "sk-search-key", true
	if _, err := srv.d.Settings.Apply(settings.Patch{SearchAPIKey: &key, SearchEnabled: &enabled}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	rec := mcpReq(t, srv, http.MethodPost, "/api/search/attach", "secret", "{}")
	if rec.Code != http.StatusOK {
		t.Fatalf("attach 应 200，实际 %d: %s", rec.Code, rec.Body.String())
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

	// 状态里要能看出这一条带没带 alwaysLoad：老版本注册的条目没有它，
	// 前端据此提示「补上常驻」，而不是让用户以为已经生效了。
	rec = mcpReq(t, srv, http.MethodGet, "/api/search", "secret", "")
	var status struct {
		Attached   bool `json:"attached"`
		AlwaysLoad bool `json:"always_load"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if !status.Attached || !status.AlwaysLoad {
		t.Fatalf("状态不对: %+v", status)
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
