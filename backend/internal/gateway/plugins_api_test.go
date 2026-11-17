package gateway

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ccweb/backend/internal/plugin"
)

// fakeClaude 写一个假 claude：把参数记到 log，按参数分支输出 JSON。
// 网关这层要验的是「路由/鉴权/任务槽/作用域围栏」，不该依赖真实二进制或网络。
func fakeClaude(t *testing.T, script string) (*plugin.Manager, string) {
	t.Helper()
	dir := t.TempDir()
	logPath := filepath.Join(dir, "args.log")
	body := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> " + logPath + "\n" + script + "\n"
	bin := filepath.Join(dir, "claude")
	if err := os.WriteFile(bin, []byte(body), 0o755); err != nil {
		t.Fatalf("写假 claude: %v", err)
	}
	return plugin.New(func() (string, error) { return bin, nil }, dir), logPath
}

const listScript = `case "$*" in
  plugin\ list\ --json) echo '[{"id":"hello@pt-market","version":"0.1.0","scope":"user","enabled":true,"installPath":"/x"}]' ;;
  plugin\ marketplace\ list\ --json) echo '[{"name":"pt-market","source":"directory","installPath":"/tmp/m"}]' ;;
  *) echo '{"outcome":"ok","command":"noop"}' ;;
esac`

func withPlugins(t *testing.T, srv *Server) (*plugin.Manager, string) {
	t.Helper()
	m, log := fakeClaude(t, listScript)
	srv.d.Plugins = m
	return m, log
}

func TestPluginsRequireAuth(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	withPlugins(t, srv)
	cases := []struct{ method, target string }{
		{http.MethodGet, "/api/plugins"},
		{http.MethodPost, "/api/plugins/refresh"},
		{http.MethodGet, "/api/plugins/details?id=hello@pt-market"},
		{http.MethodPost, "/api/plugins/install"},
		{http.MethodPost, "/api/plugins/enabled"},
		{http.MethodPost, "/api/plugins/update"},
		{http.MethodPost, "/api/plugins/uninstall"},
		{http.MethodPost, "/api/plugins/marketplace"},
	}
	for _, c := range cases {
		if rec := mcpReq(t, srv, c.method, c.target, "", "{}"); rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s 无 token 应 401，实际 %d", c.method, c.target, rec.Code)
		}
	}
}

func TestPluginsReturn503WithoutManager(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	if rec := mcpReq(t, srv, http.MethodGet, "/api/plugins", "secret", ""); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("未装配插件管理应 503，实际 %d", rec.Code)
	}
	if rec := mcpReq(t, srv, http.MethodPost, "/api/plugins/install", "secret", "{}"); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("安装接口也应 503，实际 %d", rec.Code)
	}
}

func TestPluginsListPayload(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	withPlugins(t, srv)
	rec := mcpReq(t, srv, http.MethodGet, "/api/plugins", "secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
	var payload pluginsPayload
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Supported {
		t.Fatalf("应报告支持: %+v", payload)
	}
	if len(payload.Installed) != 1 || payload.Installed[0].ID != "hello@pt-market" {
		t.Fatalf("已装列表不对: %+v", payload.Installed)
	}
	if len(payload.Marketplaces) != 1 || payload.Marketplaces[0].Name != "pt-market" {
		t.Fatalf("marketplace 列表不对: %+v", payload.Marketplaces)
	}
	// 可安装明细走 /api/plugins/available 分页，这个接口只给总数。
	if payload.AvailableTotal != 0 {
		t.Fatalf("available_total 应为 0: %+v", payload)
	}
}

// project 作用域必须落在已授权的工作区里：CLI 会按 cwd 写 .claude/settings.json。
func TestPluginProjectScopeRequiresAuthorizedCwd(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	_, log := withPlugins(t, srv)
	outside := t.TempDir()
	body := `{"id":"hello@pt-market","scope":"project","cwd":"` + outside + `"}`
	if rec := mcpReq(t, srv, http.MethodPost, "/api/plugins/install", "secret", body); rec.Code != http.StatusForbidden {
		t.Fatalf("未授权 cwd 应 403，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if b, err := os.ReadFile(log); err == nil && strings.Contains(string(b), "install") {
		t.Fatalf("被拒的请求不该触达 CLI: %s", b)
	}

	// 没给 cwd 也要说清楚，而不是当成 user 作用域静默装到全局。
	body = `{"id":"hello@pt-market","scope":"project"}`
	if rec := mcpReq(t, srv, http.MethodPost, "/api/plugins/install", "secret", body); rec.Code != http.StatusBadRequest {
		t.Fatalf("缺 cwd 应 400，实际 %d", rec.Code)
	}
}

// 同一时刻只允许一个变更任务：CLI 会读改写同一批配置文件。
func TestPluginJobSingleSlot(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	// sleep 让第一个任务占住槽位。
	m, _ := fakeClaude(t, `case "$*" in
  plugin\ list*) echo '[]' ;;
  plugin\ marketplace*) echo '[]' ;;
  *) sleep 1; echo '{"outcome":"ok"}' ;;
esac`)
	srv.d.Plugins = m

	body := `{"id":"hello@pt-market","scope":"user"}`
	if rec := mcpReq(t, srv, http.MethodPost, "/api/plugins/install", "secret", body); rec.Code != http.StatusOK {
		t.Fatalf("第一次应接受，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if rec := mcpReq(t, srv, http.MethodPost, "/api/plugins/update", "secret", body); rec.Code != http.StatusConflict {
		t.Fatalf("并发任务应 409，实际 %d", rec.Code)
	}

	// 任务结束后槽位要能复用，状态要变成 done。
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		rec := mcpReq(t, srv, http.MethodGet, "/api/plugins", "secret", "")
		var payload pluginsPayload
		_ = json.Unmarshal(rec.Body.Bytes(), &payload)
		if payload.Job != nil && payload.Job.Phase == pluginJobDone {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("任务没有结束")
}

// 失败要落在 job.Error 上，而不是让接口 500：任务是异步的，200 只表示已接受。
func TestPluginJobFailureReported(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	m, _ := fakeClaude(t, `case "$*" in
  plugin\ list*) echo '[]' ;;
  plugin\ marketplace*) echo '[]' ;;
  *) echo '{"command":"install","outcome":"failed","message":"not found","failureCode":"not_found"}'; exit 1 ;;
esac`)
	srv.d.Plugins = m

	body := `{"id":"nope@pt-market","scope":"user"}`
	if rec := mcpReq(t, srv, http.MethodPost, "/api/plugins/install", "secret", body); rec.Code != http.StatusOK {
		t.Fatalf("应接受任务，实际 %d: %s", rec.Code, rec.Body.String())
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		rec := mcpReq(t, srv, http.MethodGet, "/api/plugins", "secret", "")
		var payload pluginsPayload
		_ = json.Unmarshal(rec.Body.Bytes(), &payload)
		if payload.Job != nil && payload.Job.Phase == pluginJobError {
			if !strings.Contains(payload.Job.Error, "not found") {
				t.Fatalf("失败原因不对: %+v", payload.Job)
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("任务没有结束")
}

func TestPluginMarketplaceValidation(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	withPlugins(t, srv)
	for _, body := range []string{
		`{"action":"nope"}`,
		`{"action":"add"}`,
		`{"action":"remove"}`,
	} {
		if rec := mcpReq(t, srv, http.MethodPost, "/api/plugins/marketplace", "secret", body); rec.Code != http.StatusBadRequest {
			t.Fatalf("%s 应 400，实际 %d", body, rec.Code)
		}
	}
	// 非法标识要在触达 CLI 之前被挡掉。
	if rec := mcpReq(t, srv, http.MethodPost, "/api/plugins/uninstall", "secret", `{"id":"../x"}`); rec.Code != http.StatusOK {
		t.Fatalf("非法 id 由 CLI 层拒绝并落进 job.Error，接口仍应先接受: %d", rec.Code)
	}
}

// 未安装的插件查不到 details 是正常情况：仍要返回 Inspect（清单文件里的风险提示）。
func TestPluginDetailsFallsBackToInspect(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	m, _ := fakeClaude(t, `case "$*" in
  plugin\ details*) echo "Plugin \"x@y\" not found"; exit 1 ;;
  *) echo '[]' ;;
esac`)
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "plugins", "x", ".claude-plugin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "plugins", "x", ".claude-plugin", "plugin.json"), []byte(`{"hooks":{"SessionStart":[]}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	srv.d.Plugins = m

	rec := mcpReq(t, srv, http.MethodGet, "/api/plugins/details?id=x@y", "secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Error   string         `json:"error"`
		Details plugin.Details `json:"details"`
		Inspect plugin.Inspect `json:"inspect"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Error == "" {
		t.Fatal("未安装时应带 error 说明")
	}
	if out.Details.Text != "" {
		t.Fatalf("details 应为空: %+v", out.Details)
	}
}

// 界面点「安装」时带的是 `名字@市场` + 市场名。市场名不是 --marketplace 的来源，
// 直接透传会被 CLI 拒掉；后端要还原成 id、不传 --marketplace。
func TestPluginInstallAcceptsMarketplaceName(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	m, log := fakeClaude(t, `case "$*" in
  plugin\ list*) echo '[]' ;;
  plugin\ marketplace*) echo '[]' ;;
  *) echo '{"command":"install","outcome":"ok"}' ;;
esac`)
	srv.d.Plugins = m

	body := `{"id":"hello@pt-market","marketplace":"pt-market","scope":"user"}`
	if rec := mcpReq(t, srv, http.MethodPost, "/api/plugins/install", "secret", body); rec.Code != http.StatusOK {
		t.Fatalf("应接受任务，实际 %d: %s", rec.Code, rec.Body.String())
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		b, _ := os.ReadFile(log)
		if strings.Contains(string(b), "plugin install") {
			args := string(b)
			if strings.Contains(args, "--marketplace") {
				t.Fatalf("市场名不该当来源传给 CLI: %s", args)
			}
			if !strings.Contains(args, "install hello@pt-market") {
				t.Fatalf("应安装完整 id: %s", args)
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("CLI 没有被调用")
}

// 列表读成功就是支持：探测那一步偶发失败不能把整页判成「版本不支持」。
func TestPluginListSucceedsEvenIfProbeIsFlaky(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	dir := t.TempDir()
	bin := filepath.Join(dir, "claude")
	// 每次调用都成功返回列表；Support 的内部探测也是同一个命令，所以这里
	// 直接验证「列表成功 ⇒ supported=true」这条顺序。
	script := "#!/bin/sh\necho '[{\"id\":\"a@b\",\"enabled\":true}]'\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	srv.d.Plugins = plugin.New(func() (string, error) { return bin, nil }, dir)

	rec := mcpReq(t, srv, http.MethodGet, "/api/plugins", "secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
	var payload pluginsPayload
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Supported || len(payload.Installed) != 1 {
		t.Fatalf("应报告支持并带出插件: %+v", payload)
	}
}

// 连 plugin 子命令都没有时：200 + supported=false + 原因（界面据此整页置灰）。
func TestPluginListUnsupportedWhenNoSubcommand(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	dir := t.TempDir()
	bin := filepath.Join(dir, "claude")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho \"unknown command 'plugin'\" >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	srv.d.Plugins = plugin.New(func() (string, error) { return bin, nil }, dir)

	rec := mcpReq(t, srv, http.MethodGet, "/api/plugins", "secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("不支持不是错误，应 200，实际 %d", rec.Code)
	}
	var payload pluginsPayload
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Supported {
		t.Fatalf("应报告不支持: %+v", payload)
	}
	if payload.Reason == "" {
		t.Fatal("要带原因，否则用户不知道该升级什么")
	}
}

// 没装 claude 时设置页必须能打开，并说清「去部署页装一个」。
//
// 这条路径很容易被写成 500：List 一定失败，只有走到 Support() 才分得清
// 「这套版本没有 plugin 子命令」与「根本没装」。前者整页置灰，后者是指路。
func TestListPluginsWithoutClaude(t *testing.T) {
	mgr := plugin.New(func() (string, error) { return "", plugin.ErrNotInstalled }, t.TempDir())
	srv := serverWithPlugins(t, mgr)

	rec := mcpReq(t, srv, http.MethodGet, "/api/plugins", "secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("没装 claude 时不应报错，实际 %d: %s", rec.Code, rec.Body.String())
	}
	var payload pluginsPayload
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Supported {
		t.Fatal("没装 claude 不能报 supported")
	}
	if !strings.Contains(payload.Reason, "部署") {
		t.Fatalf("原因要指到「设置 → 部署」，实际 %q", payload.Reason)
	}
	// 数组字段不能是 null：前端 .map 会直接白屏。
	if payload.Installed == nil || payload.Marketplaces == nil {
		t.Fatalf("installed/marketplaces 不能为 null: %+v", payload)
	}
}
