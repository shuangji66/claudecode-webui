package gateway

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"ccweb/backend/internal/plugin"
)

// availableClaude 写一个假 claude：list/marketplace 走空结果，--available 回指定条数。
// log 里记录每次调用的参数，用来断言「有缓存时不该再问 CLI」。
func availableClaude(t *testing.T, count int) (*plugin.Manager, string) {
	t.Helper()
	dir := t.TempDir()
	logPath := filepath.Join(dir, "args.log")
	items := make([]string, 0, count)
	for i := 0; i < count; i++ {
		items = append(items, `{"pluginId":"plugin-`+strconv.Itoa(i)+`@demo","name":"plugin-`+strconv.Itoa(i)+
			`","description":"demo plugin `+strconv.Itoa(i)+`","marketplaceName":"demo"}`)
	}
	available := `{"installed":[],"available":[` + strings.Join(items, ",") + `]}`
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> " + logPath + "\n" +
		"case \"$*\" in\n" +
		"  plugin\\ list\\ --available\\ --json) echo '" + available + "' ;;\n" +
		"  plugin\\ list*) echo '[]' ;;\n" +
		"  plugin\\ marketplace*) echo '[{\"name\":\"demo\",\"source\":\"directory\",\"installLocation\":\"/tmp/demo\"}]' ;;\n" +
		"  *) echo '{\"outcome\":\"ok\"}' ;;\n" +
		"esac\n"
	bin := filepath.Join(dir, "claude")
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatalf("写假 claude: %v", err)
	}
	return plugin.New(func() (string, error) { return bin, nil }, dir), logPath
}

// serverWithPlugins 造一个带 MCP/插件管理、且 DataDir 可写的测试服务器。
func serverWithPlugins(t *testing.T, mgr *plugin.Manager) *Server {
	t.Helper()
	srv, _ := newTestServer(t, "secret")
	srv.d.Plugins = mgr
	srv.d.Cfg.DataDir = t.TempDir()
	return srv
}

func waitPluginJob(t *testing.T, srv *Server) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if job := srv.pluginJobSnapshot(); job != nil && job.Phase != pluginJobRunning {
			return
		}
		time.Sleep(30 * time.Millisecond)
	}
	t.Fatal("插件任务没有结束")
}

func TestFilterAvailablePlugins(t *testing.T) {
	items := []pluginAvailable{
		{PluginID: "a@m", Name: "code-review", Description: "Automated code review", Marketplace: "m"},
		{PluginID: "b@m", Name: "commit", Description: "git commit workflows", Marketplace: "m"},
		{PluginID: "c@n", Name: "0x", Description: "DeFi tools", Marketplace: "n"},
	}
	cases := []struct {
		name    string
		q       string
		market  string
		hide    bool
		wantIDs []string
	}{
		{name: "无过滤", wantIDs: []string{"a@m", "b@m", "c@n"}},
		{name: "大小写不敏感", q: "REVIEW", wantIDs: []string{"a@m"}},
		{name: "命中说明", q: "defi", wantIDs: []string{"c@n"}},
		{name: "多词全部命中", q: "git commit", wantIDs: []string{"b@m"}},
		{name: "多词缺一个则不中", q: "git review", wantIDs: []string{}},
		{name: "按市场筛选", market: "m", wantIDs: []string{"a@m", "b@m"}},
		{name: "只看未安装", hide: true, wantIDs: []string{"b@m", "c@n"}},
	}
	for _, c := range cases {
		installed := map[string]bool{"a@m": true}
		got := filterAvailablePlugins(items, c.q, c.market, c.hide, installed)
		ids := make([]string, 0, len(got))
		for _, item := range got {
			ids = append(ids, item.PluginID)
		}
		if strings.Join(ids, ",") != strings.Join(c.wantIDs, ",") {
			t.Fatalf("%s: 得到 %v，期望 %v", c.name, ids, c.wantIDs)
		}
	}
}

// 首次打开（没有缓存）要在后台自动补一次，并把结果落盘。
func TestPluginAvailableAutoRefreshAndPersist(t *testing.T) {
	mgr, _ := availableClaude(t, 130)
	srv := serverWithPlugins(t, mgr)

	rec := mcpReq(t, srv, http.MethodGet, "/api/plugins", "secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
	var payload pluginsPayload
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	// 请求本身不等目录：先回空总数 + 一个 running 的任务。
	if payload.Job == nil || payload.Job.Kind != "refresh" {
		t.Fatalf("应自动起一个刷新任务: %+v", payload.Job)
	}
	waitPluginJob(t, srv)

	// 缓存文件落盘，且带上 claude HOME（换部署时不该串）。
	path := filepath.Join(srv.d.Cfg.DataDir, pluginAvailableCacheFile)
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("目录缓存没落盘: %v", err)
	}
	var cache pluginAvailableCache
	if err := json.Unmarshal(b, &cache); err != nil {
		t.Fatal(err)
	}
	if cache.Home != mgr.Home() || len(cache.Items) != 130 {
		t.Fatalf("缓存内容不对: home=%q items=%d", cache.Home, len(cache.Items))
	}
}

// 重进前端（或重启进程）先读落盘缓存，不再问 CLI 的 --available。
func TestPluginAvailableCacheFirstOnRestart(t *testing.T) {
	mgr, _ := availableClaude(t, 40)
	srv := serverWithPlugins(t, mgr)
	dataDir := srv.d.Cfg.DataDir

	// 第一次：自动刷新并把缓存写盘。
	mcpReq(t, srv, http.MethodGet, "/api/plugins", "secret", "")
	waitPluginJob(t, srv)

	// 第二个进程：同一个 DataDir，但换一个「禁止 --available」的假二进制。
	dir := t.TempDir()
	logPath := filepath.Join(dir, "args.log")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> " + logPath + "\n" +
		"case \"$*\" in\n" +
		"  plugin\\ list*) echo '[]' ;;\n" +
		"  plugin\\ marketplace*) echo '[{\"name\":\"demo\",\"source\":\"directory\",\"installLocation\":\"/tmp/demo\"}]' ;;\n" +
		"  plugin\\ list\\ --available*) echo 'boom' >&2; exit 1 ;;\n" +
		"  *) echo '{\"outcome\":\"ok\"}' ;;\n" +
		"esac\n"
	bin := filepath.Join(dir, "claude")
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	mgr2 := plugin.New(func() (string, error) { return bin, nil }, mgr.Home())
	srv2, _ := newTestServer(t, "secret")
	srv2.d.Plugins = mgr2
	srv2.d.Cfg.DataDir = dataDir

	rec := mcpReq(t, srv2, http.MethodGet, "/api/plugins", "secret", "")
	var payload pluginsPayload
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.AvailableTotal != 40 || payload.AvailableAt == "" {
		t.Fatalf("应直接用缓存: total=%d at=%q", payload.AvailableTotal, payload.AvailableAt)
	}
	if payload.Job != nil {
		t.Fatalf("有缓存时不该再自动刷新: %+v", payload.Job)
	}
	if b, _ := os.ReadFile(logPath); strings.Contains(string(b), "--available") {
		t.Fatalf("有缓存时不该再跑 --available: %s", b)
	}

	// 明细也可以直接分页读出来。
	rec = mcpReq(t, srv2, http.MethodGet, "/api/plugins/available?limit=5", "secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
	var page pluginAvailablePage
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 5 || page.Total != 40 || page.Matched != 40 {
		t.Fatalf("分页结果不对: %+v", page)
	}
}

// 分页 / 过滤 / 只看未安装都在服务端完成，前端只拿一页。
func TestPluginAvailablePagingHandler(t *testing.T) {
	mgr, _ := availableClaude(t, 25)
	srv := serverWithPlugins(t, mgr)
	srv.setPluginAvailable([]pluginAvailable{
		{PluginID: "p0@m", Name: "alpha", Description: "first", Marketplace: "m"},
		{PluginID: "p1@m", Name: "beta", Description: "second", Marketplace: "m"},
		{PluginID: "p2@n", Name: "gamma", Description: "third", Marketplace: "n"},
	}, time.Now(), "")

	get := func(qs string) pluginAvailablePage {
		t.Helper()
		rec := mcpReq(t, srv, http.MethodGet, "/api/plugins/available"+qs, "secret", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
		}
		var page pluginAvailablePage
		if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		return page
	}

	if page := get("?limit=2"); len(page.Items) != 2 || page.Matched != 3 || page.Total != 3 {
		t.Fatalf("第一页不对: %+v", page)
	}
	page := get("?limit=2&offset=2")
	if len(page.Items) != 1 || page.Items[0].PluginID != "p2@n" {
		t.Fatalf("第二页不对: %+v", page)
	}
	if page := get("?q=BETA"); len(page.Items) != 1 || page.Items[0].PluginID != "p1@m" {
		t.Fatalf("搜索不对: %+v", page)
	}
	if page := get("?market=n"); len(page.Items) != 1 || page.Items[0].PluginID != "p2@n" {
		t.Fatalf("市场筛选不对: %+v", page)
	}
	// limit 上限保护：一次要一万条也只给 100。
	if page := get("?limit=10000"); page.Limit != pluginPageMax {
		t.Fatalf("limit 应被夹到 %d，实际 %d", pluginPageMax, page.Limit)
	}
}

// 刷新失败不能把已经读到的目录清空。
//
// 离线是常态（NAS 在内网、registry 偶尔不可达）：点一次「刷新可用插件」失败，
// 如果顺手把内存里的目录抹成空，界面上 3743 条会立刻变成 0 条，而且
// pluginAvailLoaded 已经为 true，不会再从落盘缓存里读回来——只能重启进程。
func TestPluginAvailableKeepsCatalogOnRefreshFailure(t *testing.T) {
	mgr, _ := availableClaude(t, 3)
	srv := serverWithPlugins(t, mgr)
	srv.setPluginAvailable([]pluginAvailable{
		{PluginID: "p0@m", Name: "alpha", Description: "first", Marketplace: "m"},
		{PluginID: "p1@m", Name: "beta", Description: "second", Marketplace: "m"},
	}, time.Now(), "")
	// 模拟「用户已经打开过设置页」：落盘缓存只读一次，之后内存就是唯一来源。
	// 不先标记的话，下面的断言会被 loadPluginCache 重新读盘掩盖掉。
	srv.loadPluginCache()

	// 失败路径：refreshAvailable 里就是 setPluginAvailable(nil, 零值时间, 原因)。
	srv.setPluginAvailable(nil, time.Time{}, "拉取失败: dial tcp: 网络不可达")

	page := pluginAvailablePageFor(t, srv, "?limit=10")
	if page.Total != 2 || page.Matched != 2 || len(page.Items) != 2 {
		t.Fatalf("刷新失败后应保留上一次的目录: total=%d matched=%d items=%d", page.Total, page.Matched, len(page.Items))
	}
	if !strings.Contains(page.Note, "网络不可达") {
		t.Fatalf("失败原因要带出去，实际 %q", page.Note)
	}

	// 主接口的 total 同理：它决定界面是否显示「可安装」这一块。
	rec := mcpReq(t, srv, http.MethodGet, "/api/plugins", "secret", "")
	var payload pluginsPayload
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.AvailableTotal != 2 {
		t.Fatalf("主接口应保留目录条数，实际 %d", payload.AvailableTotal)
	}
	if !strings.Contains(payload.AvailableNote, "网络不可达") {
		t.Fatalf("主接口要带上失败原因，实际 %q", payload.AvailableNote)
	}
}

// 从没有目录到第一次刷新失败：条数是 0，但原因必须看得见（界面据此说「为什么是空的」）。
func TestPluginAvailableNoteWithoutCatalog(t *testing.T) {
	mgr, _ := availableClaude(t, 0)
	srv := serverWithPlugins(t, mgr)
	srv.setPluginAvailable(nil, time.Time{}, "拉取失败: 离线")

	page := pluginAvailablePageFor(t, srv, "")
	if page.Total != 0 || len(page.Items) != 0 {
		t.Fatalf("没有目录时不该有结果: %+v", page)
	}
	if page.Note != "拉取失败: 离线" {
		t.Fatalf("没有目录时也要带上失败原因，实际 %q", page.Note)
	}
}

// pluginAvailablePageFor 读一页可安装插件（断言状态码后解析）。
func pluginAvailablePageFor(t *testing.T, srv *Server, qs string) pluginAvailablePage {
	t.Helper()
	rec := mcpReq(t, srv, http.MethodGet, "/api/plugins/available"+qs, "secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
	var page pluginAvailablePage
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
		t.Fatalf("解析分页响应: %v", err)
	}
	return page
}
