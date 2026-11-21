package gateway

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"ccweb/backend/internal/browserbin"
	"ccweb/backend/internal/mcp"
)

// 注册出来的配置必须能被 claude 直接跑起来：命令是本二进制的绝对路径、
// 子命令是 mcp-browser、环境里带运行时目录，且常驻工具表（否则模型只看到一串
// mcp__ccweb-browser__browser_open 的名字，认不出它是「打开网页」）。
func TestEnsureBrowserMCPRegistersUserLevelServer(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	withMcp(t, srv)
	dir := t.TempDir()
	srv.d.Cfg.BrowserDir = dir

	if err := srv.EnsureBrowserMCP(); err != nil {
		t.Fatalf("EnsureBrowserMCP: %v", err)
	}
	got, err := srv.d.Mcp.Find("", mcp.ScopeUser, BrowserMCPServer)
	if err != nil {
		t.Fatalf("注册后应能找到: %v", err)
	}
	if got.Type != mcp.TypeStdio {
		t.Fatalf("type = %q", got.Type)
	}
	if !got.AlwaysLoad {
		t.Fatal("内置浏览器必须是 alwaysLoad")
	}
	if got.Command == "" || filepath.Base(got.Command) == "" {
		t.Fatalf("command = %q", got.Command)
	}
	if len(got.Args) != 1 || got.Args[0] != "mcp-browser" {
		t.Fatalf("args = %v", got.Args)
	}
	if got.Env["CCWEB_BROWSER_DIR"] != dir {
		t.Fatalf("env = %v", got.Env)
	}

	// 幂等：第二次注册不该重写配置（.claude.json 是 claude 自己的状态文件）。
	before, _ := srv.d.Mcp.Find("", mcp.ScopeUser, BrowserMCPServer)
	if err := srv.EnsureBrowserMCP(); err != nil {
		t.Fatalf("第二次 EnsureBrowserMCP: %v", err)
	}
	after, _ := srv.d.Mcp.Find("", mcp.ScopeUser, BrowserMCPServer)
	if before.Command != after.Command || len(after.Args) != 1 {
		t.Fatalf("重复注册改动了配置: %+v → %+v", before, after)
	}
}

// 用户改了数据目录（换部署方式）时，注册的 env 要跟着改。
func TestEnsureBrowserMCPUpdatesChangedEnv(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	withMcp(t, srv)
	srv.d.Cfg.BrowserDir = t.TempDir()
	if err := srv.EnsureBrowserMCP(); err != nil {
		t.Fatalf("EnsureBrowserMCP: %v", err)
	}
	srv.d.Cfg.BrowserDir = t.TempDir()
	if err := srv.EnsureBrowserMCP(); err != nil {
		t.Fatalf("第二次 EnsureBrowserMCP: %v", err)
	}
	got, err := srv.d.Mcp.Find("", mcp.ScopeUser, BrowserMCPServer)
	if err != nil {
		t.Fatalf("Find: %v", err)
	}
	if got.Env["CCWEB_BROWSER_DIR"] != srv.d.Cfg.BrowserDir {
		t.Fatalf("env 没跟着改: %v", got.Env)
	}
}

// 内置浏览器和自动化任务一样由启动流程维护：列表要打标记，删除要 409
// （删掉下次启动又长回来，中间只是让模型白丢十个工具）。
func TestBuiltinBrowserMcpCannotBeDeleted(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	withMcp(t, srv)
	if err := srv.EnsureBrowserMCP(); err != nil {
		t.Fatalf("EnsureBrowserMCP: %v", err)
	}

	rec := mcpReq(t, srv, http.MethodGet, "/api/mcp", "secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("列表 %d: %s", rec.Code, rec.Body.String())
	}
	var payload mcp.Payload
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, s := range payload.User {
		if s.Name == BrowserMCPServer {
			found = true
			if !s.Builtin {
				t.Fatalf("应带 builtin 标记: %+v", s)
			}
		}
	}
	if !found {
		t.Fatalf("列表里没有 %s", BrowserMCPServer)
	}

	if rec := mcpReq(t, srv, http.MethodDelete, "/api/mcp?scope=user&name="+BrowserMCPServer, "secret", ""); rec.Code != http.StatusConflict {
		t.Fatalf("删除内置服务应 409，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if _, err := srv.d.Mcp.Find("", mcp.ScopeUser, BrowserMCPServer); err != nil {
		t.Fatalf("被拒的删除不该真的删掉: %v", err)
	}
}

// 放行的工具名必须与 mcp__<服务名>__<工具> 的拼法一致，否则放行的是不存在的工具。
func TestBrowserToolRules(t *testing.T) {
	allow := BrowserToolRules()
	if len(allow) == 0 {
		t.Fatal("allow 为空")
	}
	want := map[string]bool{}
	for _, tool := range []string{
		"browser_open", "browser_snapshot", "browser_text", "browser_click", "browser_type",
		"browser_press", "browser_screenshot", "browser_eval", "browser_status", "browser_close",
	} {
		want["mcp__"+BrowserMCPServer+"__"+tool] = true
	}
	if len(allow) != len(want) {
		t.Fatalf("allow = %v", allow)
	}
	for _, name := range allow {
		if !want[name] {
			t.Fatalf("多出/写错了放行项: %q", name)
		}
		if !strings.HasPrefix(name, "mcp__"+BrowserMCPServer+"__") {
			t.Fatalf("工具名前缀不对: %q", name)
		}
	}
}

// 没装配运行时（Deps.Browser 为 nil）时路由给 503，而不是 panic。
func TestBrowserRoutesWithoutManager(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	for _, tc := range []struct{ method, target string }{
		{http.MethodGet, "/api/browser"},
		{http.MethodPost, "/api/browser/install"},
		{http.MethodPost, "/api/browser/cancel"},
		{http.MethodDelete, "/api/browser"},
	} {
		rec := mcpReq(t, srv, tc.method, tc.target, "secret", "")
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s %s = %d，want 503", tc.method, tc.target, rec.Code)
		}
	}
}

// 装上运行时后，状态接口要把内核与 node 一起报出来（界面据此画卡片）。
func TestBrowserStatusRoute(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	dir := t.TempDir()
	mgr, err := browserbin.Open(filepath.Join(dir, "browser"))
	if err != nil {
		t.Fatalf("browserbin.Open: %v", err)
	}
	srv.d.Browser = mgr

	rec := mcpReq(t, srv, http.MethodGet, "/api/browser", "secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("状态 %d: %s", rec.Code, rec.Body.String())
	}
	var st browserbin.Status
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	if st.Playwright != browserbin.PlaywrightVersion {
		t.Fatalf("playwright = %q", st.Playwright)
	}
	if len(st.Kernels) != len(browserbin.Kernels) {
		t.Fatalf("kernels = %+v", st.Kernels)
	}
	if st.Installed {
		t.Fatal("空目录不该是已安装")
	}
}
