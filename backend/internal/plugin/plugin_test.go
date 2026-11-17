package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeBin 写一个假 claude：把收到的参数追加到 args.log，然后按 FAKE_OUT 输出、
// 按 FAKE_EXIT 退出。这样能同时验证「参数怎么拼」和「输出怎么解析」，
// 不需要任何网络或真实二进制。
func fakeBin(t *testing.T, out string, exit int) (bin, logPath string) {
	t.Helper()
	dir := t.TempDir()
	logPath = filepath.Join(dir, "args.log")
	body := "#!/bin/sh\n"
	body += "printf '%s\\n' \"$*\" >> " + logPath + "\n"
	if out != "" {
		body += "cat <<'EOF'\n" + out + "\nEOF\n"
	}
	body += "exit " + itoa(exit) + "\n"
	bin = filepath.Join(dir, "claude")
	if err := os.WriteFile(bin, []byte(body), 0o755); err != nil {
		t.Fatalf("写假 claude: %v", err)
	}
	return bin, logPath
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := ""
	for n > 0 {
		digits = string(rune('0'+n%10)) + digits
		n /= 10
	}
	return digits
}

func lastArgs(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读参数日志: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	return lines[len(lines)-1]
}

func newManager(t *testing.T, bin string) *Manager {
	t.Helper()
	home := t.TempDir()
	return New(func() (string, error) { return bin, nil }, home)
}

const listJSON = `[{"id":"hello@pt-market","version":"0.1.0","scope":"user","enabled":true,"installPath":"/tmp/x","mcpServers":{"demo":{"command":"node"}}}]`

func TestListParsesPlugins(t *testing.T) {
	bin, log := fakeBin(t, listJSON, 0)
	m := newManager(t, bin)
	list, err := m.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 || list[0].ID != "hello@pt-market" || !list[0].Enabled {
		t.Fatalf("解析结果不对: %+v", list)
	}
	if string(list[0].MCPServers) == "" {
		t.Fatal("mcpServers 应原样带出（界面要据此提示风险）")
	}
	if got := lastArgs(t, log); got != "plugin list --json" {
		t.Fatalf("参数 = %q", got)
	}
}

func TestListEmptyIsNotNil(t *testing.T) {
	bin, _ := fakeBin(t, `[]`, 0)
	m := newManager(t, bin)
	list, err := m.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	// nil 会序列化成 null，前端 .map 直接白屏：必须是空切片。
	if list == nil {
		t.Fatal("空列表应为 []Plugin{} 而不是 nil")
	}
}

// 安装参数是这条链路的关键：少 -y 会在无 TTY 时被拒，漏 --json 就解析不到结果。
func TestInstallArgs(t *testing.T) {
	bin, log := fakeBin(t, `{"command":"install","outcome":"ok","pluginId":"hello@pt-market","scope":"user"}`, 0)
	m := newManager(t, bin)
	res, err := m.Install(context.Background(), "hello@pt-market", "", "project", "")
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if !res.OK() {
		t.Fatalf("应成功: %+v", res)
	}
	args := lastArgs(t, log)
	for _, want := range []string{"plugin install hello@pt-market", "-s project", "-y", "--json"} {
		if !strings.Contains(args, want) {
			t.Fatalf("参数缺少 %q: %q", want, args)
		}
	}

	// 带 marketplace：先归一化（owner/repo → https），并透传 --accept-command。
	bin2, log2 := fakeBin(t, `{"command":"install","outcome":"ok"}`, 0)
	m2 := newManager(t, bin2)
	if _, err := m2.Install(context.Background(), "hello", "anthropics/claude-code", "user", "abc123"); err != nil {
		t.Fatalf("Install: %v", err)
	}
	args = lastArgs(t, log2)
	if !strings.Contains(args, "--marketplace https://github.com/anthropics/claude-code") {
		t.Fatalf("marketplace 未归一化成 https: %q", args)
	}
	if !strings.Contains(args, "--accept-command abc123") {
		t.Fatalf("缺少 --accept-command: %q", args)
	}
}

func TestMutateReportsCLIError(t *testing.T) {
	out := `{"command":"install","outcome":"failed","message":"Plugin \"nope\" not found","failureCode":"not_found"}`
	bin, _ := fakeBin(t, out, 1)
	m := newManager(t, bin)
	res, err := m.Install(context.Background(), "nope@pt-market", "", "user", "")
	var ce *CLIError
	if !errors.As(err, &ce) {
		t.Fatalf("应返回 CLIError，实际 %v", err)
	}
	if ce.Code != "not_found" || !strings.Contains(ce.Message, "not found") {
		t.Fatalf("错误信息不对: %+v", ce)
	}
	if res.Outcome != "failed" {
		t.Fatalf("失败时也应当把结果带出来: %+v", res)
	}
}

// 状态文件损坏这类「命令跑起来了但报错」不能算「版本不支持插件」：
// 否则界面会把整页置灰，用户永远看不到真实原因。
func TestSupportDistinguishesMissingSubcommand(t *testing.T) {
	bin, _ := fakeBin(t, `[]`, 0)
	m := newManager(t, bin)
	if ok, reason := m.Support(context.Background()); !ok || reason != "" {
		t.Fatalf("支持时应为 true 且无原因: %v %q", ok, reason)
	}

	binBad, _ := fakeBin(t, `Error: unknown command 'plugin'`, 1)
	mBad := newManager(t, binBad)
	if ok, reason := mBad.Support(context.Background()); ok || reason == "" {
		t.Fatalf("不支持时应带原因: %v %q", ok, reason)
	}

	binBroken, _ := fakeBin(t, `{"command":"list","outcome":"failed","message":"状态文件解析失败","failureCode":"bad_state"}`, 1)
	mBroken := newManager(t, binBroken)
	ok, reason := mBroken.Support(context.Background())
	if !ok || !strings.Contains(reason, "状态文件") {
		t.Fatalf("命令存在但报错时应算支持并把原因带出来: %v %q", ok, reason)
	}
}

func TestDetailsCounts(t *testing.T) {
	out := `hello 0.1.0
  Description: demo

Component inventory
  Skills (2)  greet, hi
  Agents (0)
  Hooks (1)  SessionStart  (harness-only — no model context cost)
  MCP servers (1)  demo  (tool schemas resolved at runtime; not counted)
  LSP servers (0)`
	bin, _ := fakeBin(t, out, 0)
	m := newManager(t, bin)
	d, err := m.Details(context.Background(), "hello@pt-market")
	if err != nil {
		t.Fatalf("Details: %v", err)
	}
	if d.Skills != 2 || d.Agents != 0 || d.Hooks != 1 || d.MCPServers != 1 {
		t.Fatalf("计数不对: %+v", d)
	}
	if !strings.Contains(d.Text, "Projected") && !strings.Contains(d.Text, "Component inventory") {
		t.Fatalf("原始文本应保留: %q", d.Text)
	}
}

func TestNormalizeSource(t *testing.T) {
	cases := []struct {
		in, want string
		bad      bool
	}{
		{"anthropics/claude-code", "https://github.com/anthropics/claude-code", false},
		{"anthropics/claude-code.git", "https://github.com/anthropics/claude-code.git", false},
		{"https://github.com/a/b", "https://github.com/a/b", false},
		{"/tmp/market", "/tmp/market", false},
		{"git@github.com:a/b.git", "", true},
		{"ssh://git@x/y", "", true},
		{"ftp://x/y", "", true},
		{"", "", true},
		{"only-name", "", true},
	}
	for _, c := range cases {
		got, err := NormalizeSource(c.in)
		if c.bad {
			if err == nil {
				t.Fatalf("%q 应报错，实际 %q", c.in, got)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Fatalf("%q → %q (%v)，期望 %q", c.in, got, err, c.want)
		}
	}
}

func TestRejectsBadIdentifiers(t *testing.T) {
	bin, log := fakeBin(t, `{"outcome":"ok"}`, 0)
	m := newManager(t, bin)
	for _, id := range []string{"hello", "-x@market", "a@b@c", "../x@market", ""} {
		if _, err := m.Uninstall(context.Background(), id, "user", false); err == nil {
			t.Fatalf("%q 应被拒", id)
		}
	}
	if _, err := os.Stat(log); err == nil {
		// 非法标识必须在 spawn 之前被挡掉：一次都不该调到 CLI。
		if strings.TrimSpace(readAll(t, log)) != "" {
			t.Fatalf("非法标识不应触达 CLI: %q", readAll(t, log))
		}
	}
	if _, err := m.Install(context.Background(), "hello@pt-market", "", "root", ""); err == nil {
		t.Fatal("非法作用域应被拒")
	}
}

func readAll(t *testing.T, path string) string {
	t.Helper()
	b, _ := os.ReadFile(path)
	return string(b)
}

// 装之前能看清单：plugin.json 里声明 hooks/mcpServers、目录里有 hooks/ 都算风险。
func TestInspectDeclaredComponents(t *testing.T) {
	root := t.TempDir()
	pluginDir := filepath.Join(root, "plugins", "danger")
	if err := os.MkdirAll(filepath.Join(pluginDir, ".claude-plugin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(pluginDir, "commands"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(pluginDir, "skills", "greet"), 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"name":"danger","hooks":{"SessionStart":[]},"mcpServers":{"demo":{"command":"node"}}}`
	if err := os.WriteFile(filepath.Join(pluginDir, ".claude-plugin", "plugin.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pluginDir, "commands", "hi.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	marketplaceJSON := `[{"name":"pt-market","source":"directory","path":"` + root + `","installLocation":"` + root + `"}]`
	bin, _ := fakeBin(t, marketplaceJSON, 0)
	// 同一个假二进制要依次回答 list / marketplace list / list --available，
	// 用一个按参数分支的脚本更贴近真实。
	script := "#!/bin/sh\n" +
		"case \"$*\" in\n" +
		"  plugin\\ list\\ --available\\ --json) echo '" + `{"installed":[],"available":[{"pluginId":"danger@pt-market","name":"danger","source":"./plugins/danger"}]}` + "' ;;\n" +
		"  plugin\\ list\\ --json) echo '[]' ;;\n" +
		"  plugin\\ marketplace\\ list\\ --json) echo '" + marketplaceJSON + "' ;;\n" +
		"  *) exit 1 ;;\n" +
		"esac\n"
	_ = bin
	dir := t.TempDir()
	binPath := filepath.Join(dir, "claude")
	if err := os.WriteFile(binPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	m := newManager(t, binPath)
	got := m.Inspect(context.Background(), "danger@pt-market")
	if !got.Found {
		t.Fatalf("应找到插件目录: %+v", got)
	}
	if !got.Hooks || !got.MCPServers {
		t.Fatalf("应识别出 hooks 与 mcpServers: %+v", got)
	}
	if got.Commands != 1 || got.Skills != 1 {
		t.Fatalf("命令/技能计数不对: %+v", got)
	}
}

// 清单是外部数据：source 不能把读取带出 marketplace 目录。
func TestInspectRefusesEscape(t *testing.T) {
	root := t.TempDir()
	script := "#!/bin/sh\n" +
		"case \"$*\" in\n" +
		"  plugin\\ list\\ --available\\ --json) echo '" + `{"installed":[],"available":[{"pluginId":"evil@pt-market","name":"evil","source":"../../etc"}]}` + "' ;;\n" +
		"  plugin\\ list\\ --json) echo '[]' ;;\n" +
		"  plugin\\ marketplace\\ list\\ --json) echo '" + `[{"name":"pt-market","installLocation":"` + root + `"}]` + "' ;;\n" +
		"  *) exit 1 ;;\n" +
		"esac\n"
	dir := t.TempDir()
	binPath := filepath.Join(dir, "claude")
	if err := os.WriteFile(binPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	m := newManager(t, binPath)
	if got := m.Inspect(context.Background(), "evil@pt-market"); got.Found {
		t.Fatalf("越界 source 不应被采纳: %+v", got)
	}
}

// 代理必须真的进子进程环境：本站点「配了代理却装不上插件」就是漏了这一层。
func TestEnvCarriesProxy(t *testing.T) {
	t.Setenv("https_proxy", "")
	SetProxySource(func() string { return "http://127.0.0.1:7890" })
	t.Cleanup(func() { SetProxySource(nil) })

	bin, _ := fakeBin(t, `[]`, 0)
	m := newManager(t, bin)
	env := strings.Join(m.env(), "\n")
	for _, want := range []string{"https_proxy=http://127.0.0.1:7890", "HTTPS_PROXY=http://127.0.0.1:7890", "GIT_TERMINAL_PROMPT=0"} {
		if !strings.Contains(env, want) {
			t.Fatalf("环境缺少 %q", want)
		}
	}
	if !strings.Contains(env, "HOME="+m.Home()) {
		t.Fatalf("HOME 必须是 claude 的 HOME（插件状态落在这里）: %v", m.Home())
	}
	// 回环永远直连，否则本机中继会被塞给代理。
	if !strings.Contains(env, "NO_PROXY=") && !strings.Contains(env, "no_proxy=") {
		t.Fatal("应带 NO_PROXY")
	}
}

func TestRunTimesOut(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "claude")
	// 睡超过超时时间：必须报超时而不是挂住。
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nsleep 5\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	m := newManager(t, bin)
	start := time.Now()
	_, _, err := m.run(context.Background(), 200*time.Millisecond, nil, "list", "--json")
	if err == nil || !strings.Contains(err.Error(), "超时") {
		t.Fatalf("应报超时，实际 %v", err)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatalf("超时没有生效：%s", time.Since(start))
	}
}

func TestUnmarshalPayloadLastLine(t *testing.T) {
	var res Result
	raw := []byte("progress line\n{\"outcome\":\"ok\",\"pluginId\":\"a@b\"}\n")
	if err := unmarshalPayload(raw, &res); err != nil {
		t.Fatalf("应解析最后一行: %v", err)
	}
	if res.PluginID != "a@b" {
		t.Fatalf("结果不对: %+v", res)
	}
	var list []Plugin
	if err := unmarshalPayload([]byte("[{\"id\":\"x@y\"}]"), &list); err != nil || len(list) != 1 {
		t.Fatalf("整段数组也要认: %v %+v", err, list)
	}
	if err := unmarshalPayload([]byte("not json"), &list); err == nil {
		t.Fatal("非 JSON 应报错")
	}
	raw2, _ := json.Marshal(Result{})
	if string(raw2) == "" {
		t.Fatal("sanity")
	}
}

// 一次探测失败不能记成「版本不支持」：`plugin list` 会在别的 CLI 进程写状态文件时
// 偶发失败，缓存下来整页就永远置灰了（实测踩到过）。
func TestSupportDoesNotCacheFailure(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "ready")
	bin := filepath.Join(dir, "claude")
	script := "#!/bin/sh\n" +
		"if [ -f " + marker + " ]; then echo '[]'; exit 0; fi\n" +
		"echo 'temporary failure' >&2; exit 1\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	m := newManager(t, bin)
	if ok, _ := m.Support(context.Background()); ok {
		t.Fatal("第一次应判为不可用")
	}
	if err := os.WriteFile(marker, []byte("1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if ok, reason := m.Support(context.Background()); !ok {
		t.Fatalf("失败结果不该被缓存，第二次应重新探测成功: %q", reason)
	}
}
