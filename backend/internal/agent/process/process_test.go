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

func TestDiscoverExplicitMissing(t *testing.T) {
	if _, err := Discover("/nonexistent/definitely-not-claude", ""); err == nil {
		t.Fatal("显式路径不存在时应报错")
	}
}

func TestDiscoverRejectsDirectory(t *testing.T) {
	if _, err := Discover(t.TempDir(), ""); err == nil {
		t.Fatal("传入目录时应报错")
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
