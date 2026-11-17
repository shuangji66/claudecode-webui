package process

import (
	"slices"
	"strings"
	"testing"
)

func TestArgsAlwaysIncludesStdioPermissionPrompt(t *testing.T) {
	// 这是本项目最关键的单个参数：不带它，需要审批的工具会被 fail-closed 静默拒绝，
	// can_use_tool 永远不会发到前端。
	args := Args(Options{})
	i := slices.Index(args, "--permission-prompt-tool")
	if i < 0 {
		t.Fatal("缺少 --permission-prompt-tool")
	}
	if i+1 >= len(args) || args[i+1] != "stdio" {
		t.Fatalf("--permission-prompt-tool 后面应为 stdio，实际 %v", args)
	}
}

func TestArgsBaseline(t *testing.T) {
	args := Args(Options{})
	for _, want := range []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"} {
		if !slices.Contains(args, want) {
			t.Fatalf("缺少 %q: %v", want, args)
		}
	}
	// 未要求流式分片时不应带上
	if slices.Contains(args, "--include-partial-messages") {
		t.Fatal("未开启时不应当带 --include-partial-messages")
	}
}

// fork 的语义全在参数顺序上：--resume 旧 → --fork-session → --session-id 新。
// 实测 2.1.326 只有这样才会「把历史复制到新 id、原会话不动」。
func TestArgsFork(t *testing.T) {
	args := Args(Options{Resume: "old-id", SessionID: "new-id", Fork: true})
	i := slices.Index(args, "--resume")
	if i < 0 || i+1 >= len(args) || args[i+1] != "old-id" {
		t.Fatalf("--resume 后应为旧 id: %v", args)
	}
	if len(args) <= i+2 || args[i+2] != "--fork-session" {
		t.Fatalf("--resume 后应紧跟 --fork-session: %v", args)
	}
	assertPair(t, args, "--session-id", "new-id")
}

// 不带 Fork 时绝不能出现 --fork-session：普通 resume 会因此每轮都复制一份转录。
func TestArgsNoForkByDefault(t *testing.T) {
	args := Args(Options{Resume: "old-id", SessionID: "new-id"})
	if slices.Contains(args, "--fork-session") {
		t.Fatalf("未要求分叉时不应带 --fork-session: %v", args)
	}
}

func TestArgsOptions(t *testing.T) {
	args := Args(Options{
		Model:                  "sonnet",
		PermissionMode:         "acceptEdits",
		Resume:                 "sid-1",
		SessionID:              "uuid-1",
		AddDirs:                []string{"/a", "", "/b"},
		IncludePartialMessages: true,
	})
	if !slices.Contains(args, "--include-partial-messages") {
		t.Fatal("应带 --include-partial-messages")
	}
	assertPair(t, args, "--model", "sonnet")
	assertPair(t, args, "--permission-mode", "acceptEdits")
	assertPair(t, args, "--resume", "sid-1")
	assertPair(t, args, "--session-id", "uuid-1")
	// 空目录应被跳过
	if strings.Count(strings.Join(args, " "), "/a") != 1 {
		t.Fatalf("add-dir 处理异常: %v", args)
	}
	if slices.Contains(args, "") {
		t.Fatal("不应包含空参数")
	}
}

func assertPair(t *testing.T, args []string, flag, want string) {
	t.Helper()
	i := slices.Index(args, flag)
	if i < 0 {
		t.Fatalf("缺少 %s", flag)
	}
	if i+1 >= len(args) || args[i+1] != want {
		t.Fatalf("%s 的值 = %v, want %s", flag, args[i+1:], want)
	}
}

func TestCleanEnvStripsAndForces(t *testing.T) {
	in := []string{
		"HOME=/old",
		"PWD=/old",
		"CLAUDECODE=1",
		"CLAUDE_CODE_ENTRYPOINT=cli",
		"ANTHROPIC_BASE_URL=http://relay.local",
		"ANTHROPIC_API_KEY=sk-x",
		"PATH=/usr/bin",
	}
	out := CleanEnv(in, "/new/home", "/new/cwd")

	if slices.Contains(out, "HOME=/old") || slices.Contains(out, "PWD=/old") {
		t.Fatalf("旧的 HOME/PWD 应被剔除: %v", out)
	}
	if slices.Contains(out, "CLAUDECODE=1") || slices.Contains(out, "CLAUDE_CODE_ENTRYPOINT=cli") {
		t.Fatalf("会话标记变量应被剔除: %v", out)
	}
	if !slices.Contains(out, "HOME=/new/home") || !slices.Contains(out, "PWD=/new/cwd") {
		t.Fatalf("应强制注入 HOME/PWD: %v", out)
	}
	// 反代相关变量必须原样保留：这是本项目支持自定义中转的基础。
	if !slices.Contains(out, "ANTHROPIC_BASE_URL=http://relay.local") {
		t.Fatal("ANTHROPIC_BASE_URL 不应被剔除")
	}
	if !slices.Contains(out, "ANTHROPIC_API_KEY=sk-x") {
		t.Fatal("ANTHROPIC_API_KEY 不应被剔除")
	}
	// 环境变量重复时后者生效，所以 HOME 只能出现一次。
	if n := countPrefix(out, "HOME="); n != 1 {
		t.Fatalf("HOME 出现 %d 次，应为 1", n)
	}
}

func countPrefix(list []string, prefix string) int {
	n := 0
	for _, kv := range list {
		if strings.HasPrefix(kv, prefix) {
			n++
		}
	}
	return n
}

func TestArgsAllowBypassPermissions(t *testing.T) {
	args := strings.Join(Args(Options{AllowBypassPermissions: true}), " ")
	if !strings.Contains(args, "--allow-dangerously-skip-permissions") {
		t.Fatalf("缺少 --allow-dangerously-skip-permissions: %s", args)
	}
	// 它是能力开关，不是模式：不能顺手把会话起成 bypass。
	if strings.Contains(args, "--dangerously-skip-permissions ") || strings.Contains(args, "--permission-mode bypassPermissions") {
		t.Fatalf("不应改启动模式: %s", args)
	}
	if strings.Contains(strings.Join(Args(Options{}), " "), "--allow-dangerously-skip-permissions") {
		t.Fatal("默认不应带这个开关")
	}
}

func TestArgsEffort(t *testing.T) {
	args := strings.Join(Args(Options{Effort: "high"}), " ")
	if !strings.Contains(args, "--effort high") {
		t.Fatalf("缺少 --effort: %s", args)
	}
	args = strings.Join(Args(Options{}), " ")
	if strings.Contains(args, "--effort") {
		t.Fatalf("空 Effort 不应传参: %s", args)
	}
}

func TestCleanEnvStripsProxy(t *testing.T) {
	env := CleanEnv([]string{
		"HTTPS_PROXY=http://host:1",
		"https_proxy=http://host:1",
		"ALL_PROXY=socks5://host:2",
		"NO_PROXY=example.com",
		"NODE_USE_ENV_PROXY=1",
		"PATH=/bin",
	}, "/home/u", "/work")
	joined := strings.Join(env, ",")
	for _, key := range []string{"HTTPS_PROXY", "https_proxy", "ALL_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY"} {
		if strings.Contains(joined, key+"=") {
			t.Fatalf("继承代理未剔除 %s: %v", key, env)
		}
	}
	if !strings.Contains(joined, "PATH=/bin") {
		t.Fatalf("普通环境变量不应被误删: %v", env)
	}
}

// 子代理正文转发是能力开关：默认不带，只有探测到二进制支持时才加。
func TestArgsForwardSubagentText(t *testing.T) {
	if slices.Contains(Args(Options{IncludePartialMessages: true}), "--forward-subagent-text") {
		t.Fatal("未开启时不应带 --forward-subagent-text")
	}
	if !slices.Contains(Args(Options{ForwardSubagentText: true}), "--forward-subagent-text") {
		t.Fatal("开启时应带 --forward-subagent-text")
	}
}

// 内置搜索注册后，会话靠这两个参数把内置 WebSearch/WebFetch 挡掉、把自己的
// MCP 搜索工具放行。名字要原样到模型眼前，别被拼成别的形状。
func TestArgsToolRules(t *testing.T) {
	if slices.Contains(Args(Options{}), "--allowedTools") || slices.Contains(Args(Options{}), "--disallowedTools") {
		t.Fatal("没有规则时不应带这两个参数")
	}
	args := Args(Options{
		AllowedTools:    []string{"mcp__ccweb-web__web_search", "mcp__ccweb-web__web_fetch"},
		DisallowedTools: []string{"WebSearch", "WebFetch"},
	})
	joined := strings.Join(args, " ")
	for _, want := range []string{
		"--allowedTools mcp__ccweb-web__web_search,mcp__ccweb-web__web_fetch",
		"--disallowedTools WebSearch,WebFetch",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("缺少 %q: %v", want, args)
		}
	}
}

func TestCleanEnvEnsuresPath(t *testing.T) {
	// 空环境（启动器没给 PATH）时也要补一个可用的 PATH，否则 claude 里的
	// bash 工具与 git 都找不到。
	t.Setenv("PATH", "")
	env := CleanEnv(nil, "/home/cc", "/w")
	found := false
	for _, kv := range env {
		if strings.HasPrefix(kv, "PATH=") && strings.TrimPrefix(kv, "PATH=") != "" {
			found = true
		}
	}
	if !found {
		t.Fatalf("环境里应有非空 PATH: %v", env)
	}

	// 已有 PATH 时保持原样（不要覆盖用户的 PATH）。
	t.Setenv("PATH", "/custom/bin")
	env = CleanEnv([]string{"PATH=/custom/bin"}, "/home/cc", "/w")
	for _, kv := range env {
		if kv == "PATH=" || strings.HasPrefix(kv, "PATH=") && kv != "PATH=/custom/bin" {
			t.Fatalf("PATH 被改写: %v", env)
		}
	}
}
