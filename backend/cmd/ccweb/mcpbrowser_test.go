package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ccweb/backend/internal/browserbin"
)

// 工具名与驱动命令必须一一对应：多一个工具没有实现、少一个模型就用不上。
func TestBrowserToolDefsCoverRunnerCommands(t *testing.T) {
	defs := browserToolDefs()
	want := map[string]bool{
		toolBrowserOpen: true, toolBrowserSnapshot: true, toolBrowserText: true,
		toolBrowserClick: true, toolBrowserType: true, toolBrowserPress: true,
		toolBrowserScreenshot: true, toolBrowserEval: true,
		toolBrowserStatus: true, toolBrowserClose: true,
	}
	if len(defs) != len(want) {
		t.Fatalf("工具数 %d，want %d", len(defs), len(want))
	}
	for _, d := range defs {
		name, _ := d["name"].(string)
		if !want[name] {
			t.Fatalf("多出/写错了工具: %q", name)
		}
		if runnerCmd(name) == "" {
			t.Fatalf("%s 没有对应的驱动命令", name)
		}
		desc, _ := d["description"].(string)
		if len(desc) < 40 {
			t.Fatalf("%s 的描述太短，模型判断不了什么时候用它: %q", name, desc)
		}
		if _, ok := d["inputSchema"].(map[string]any); !ok {
			t.Fatalf("%s 缺 inputSchema", name)
		}
	}
	// 收尾契约必须写在 close 的描述里：这是「任务结束前关浏览器」的唯一提示。
	for _, d := range defs {
		if d["name"] == toolBrowserClose {
			desc := d["description"].(string)
			if !strings.Contains(desc, "最终答复") || !strings.Contains(desc, "必须") {
				t.Fatalf("browser_close 描述缺收尾契约: %q", desc)
			}
		}
	}
}

// MCP 参数用 snake_case（与另两个内置服务一致），驱动进程用 camelCase；
// 映射写错的表现是「参数传了但没生效」，很难从错误里看出来。
func TestBrowserArgsMapping(t *testing.T) {
	args, err := browserArgs(toolBrowserOpen, json.RawMessage(`{"url":"example.com","wait_until":"networkidle","timeout_ms":5000,"max_refs":30}`))
	if err != nil {
		t.Fatalf("browserArgs: %v", err)
	}
	if args["url"] != "example.com" {
		t.Fatalf("args = %v", args)
	}
	if args["waitUntil"] != "networkidle" || args["timeoutMs"] != 5000 || args["maxRefs"] != 30 {
		t.Fatalf("camelCase 映射不对: %v", args)
	}

	// url 必填：缺了要在这里就拒，别把空地址发给浏览器。
	if _, err := browserArgs(toolBrowserOpen, json.RawMessage(`{}`)); err == nil {
		t.Fatal("缺 url 应报错")
	}

	// click 三选一：ref / selector / text 都没有时必须报错（否则驱动会点第一个匹配项）。
	if _, err := browserArgs(toolBrowserClick, json.RawMessage(`{}`)); err == nil {
		t.Fatal("click 缺定位参数应报错")
	}
	if _, err := browserArgs(toolBrowserClick, json.RawMessage(`{"ref":"e3"}`)); err != nil {
		t.Fatalf("ref 定位不该报错: %v", err)
	}

	// type 必须有内容与定位。
	if _, err := browserArgs(toolBrowserType, json.RawMessage(`{"selector":"#q"}`)); err != nil {
		t.Fatalf("允许空文本（清空输入框）: %v", err)
	}
	if _, err := browserArgs(toolBrowserType, json.RawMessage(`{"text":"hi"}`)); err == nil {
		t.Fatal("type 缺定位应报错")
	}

	if _, err := browserArgs(toolBrowserScreenshot, json.RawMessage(`{"full_page":true,"path":"a.png"}`)); err != nil {
		t.Fatalf("screenshot: %v", err)
	}
	// eval 的表达式必填。
	if _, err := browserArgs(toolBrowserEval, json.RawMessage(`{"script":"  "}`)); err == nil {
		t.Fatal("eval 空表达式应报错")
	}
}

// 运行时没装时：除 status/close 外一律给出可执行的安装指引（模型据此告诉用户去哪点）。
func TestCallBrowserToolWithoutRuntime(t *testing.T) {
	mgr, err := browserbin.Open(t.TempDir())
	if err != nil {
		t.Fatalf("browserbin.Open: %v", err)
	}
	r := &browserRunner{mgr: mgr}

	res := callBrowserTool(r, toolBrowserOpen, json.RawMessage(`{"url":"example.com"}`))
	if !res.IsError || !strings.Contains(res.Content[0]["text"].(string), "设置 → MCP → 内置浏览器") {
		t.Fatalf("未安装时应给出安装指引: %+v", res)
	}

	status := callBrowserTool(r, toolBrowserStatus, nil)
	if status.IsError {
		t.Fatalf("status 在未安装时也要能回答: %+v", status)
	}
	if text := status.Content[0]["text"].(string); !strings.Contains(text, "未安装") || !strings.Contains(text, "1.63.0") {
		t.Fatalf("status 文案 = %q", text)
	}

	// close 是幂等收尾：没有浏览器时也算成功，不该让模型以为失败了。
	if res := callBrowserTool(r, toolBrowserClose, nil); res.IsError {
		t.Fatalf("close 应幂等成功: %+v", res)
	}
}

// ref 清单必须把 ref 放在行首：模型下一次 click 要照着抄，埋在句子里就会抄错。
func TestFormatRefsPutsRefFirst(t *testing.T) {
	out := formatRefs([]runnerRef{
		{Ref: "e1", Role: "a", Name: "首页"},
		{Ref: "e2", Role: "input", Type: "text", Disabled: true},
	})
	for _, want := range []string{"e1  a  首页", "e2  input/text", "禁用"} {
		if !strings.Contains(out, want) {
			t.Fatalf("缺 %q:\n%s", want, out)
		}
	}
	if empty := formatRefs(nil); !strings.Contains(empty, "browser_text") {
		t.Fatalf("空清单应指向 browser_text: %q", empty)
	}
}

// 截图结果必须给出文件路径（模型用它去 Read 那张图），而不是把字节塞进上下文。
func TestFormatScreenshotResultGivesPath(t *testing.T) {
	raw := json.RawMessage(`{"path":"/tmp/a.png","bytes":2048,"url":"https://x"}`)
	res := formatBrowserResult(toolBrowserScreenshot, raw)
	text := res.Content[0]["text"].(string)
	if !strings.Contains(text, "/tmp/a.png") || !strings.Contains(text, "Read") {
		t.Fatalf("截图结果 = %q", text)
	}
}

// Go 侧等回包的预算必须跟着工具的 timeout_ms 走（且要有上限）：
// 模型把导航超时放宽到 120s 时，我们 90s 就掐掉等于参数没生效。
func TestBrowserTimeoutFollowsToolArgument(t *testing.T) {
	if got := browserTimeout("open", nil); got != browserCallTimeout {
		t.Fatalf("默认 = %v，want %v", got, browserCallTimeout)
	}
	if got := browserTimeout("screenshot", nil); got != browserShotTimeout {
		t.Fatalf("截图默认 = %v，want %v", got, browserShotTimeout)
	}
	// 90s 默认 + 120s 参数 → 135s（参数 + 15s 余量）。
	if got := browserTimeout("open", map[string]any{"timeoutMs": 120000}); got != 135*time.Second {
		t.Fatalf("放宽后 = %v", got)
	}
	// 小于默认值时不该把预算压低（Go 侧等得比页面短没有意义）。
	if got := browserTimeout("open", map[string]any{"timeoutMs": 5000}); got != browserCallTimeout {
		t.Fatalf("缩小时 = %v，want %v", got, browserCallTimeout)
	}
	// 再大也封顶，别让一次调用挂到 MCP 的 tools/call 超时。
	if got := browserTimeout("open", map[string]any{"timeoutMs": 3600000}); got != browserMaxTimeout {
		t.Fatalf("上限 = %v，want %v", got, browserMaxTimeout)
	}
}

// 截图落点必须收进工作区：这些工具是预放行的，path 又是模型给的，
// 任意落点等于把「截图」变成「覆盖工作区外任意可写文件」。
func TestScreenshotPathStaysInWorkspace(t *testing.T) {
	root := t.TempDir()
	// 工作区里一条指向外面的符号链接：按字面判断会放行，按真实路径必须拒绝。
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Skipf("创建符号链接失败: %v", err)
	}

	cases := []struct {
		name string
		raw  string
		ok   bool
	}{
		{"空值用默认落点", "", true},
		{"相对路径", "shots/a.png", true},
		{"工作区里的绝对路径", filepath.Join(root, "a.png"), true},
		{"父目录穿越", "../escape.png", false},
		{"绝对路径在外面", filepath.Join(outside, "a.png"), false},
		{"经符号链接逃出去", filepath.Join(root, "link", "a.png"), false},
		{"系统目录", "/etc/cron.d/x", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := screenshotPath(root, tc.raw)
			if tc.ok {
				if err != nil {
					t.Fatalf("应放行，实际 %v", err)
				}
				if tc.raw != "" && !filepath.IsAbs(got) {
					t.Fatalf("应返回绝对路径，实际 %q", got)
				}
				return
			}
			if err == nil {
				t.Fatalf("应拒绝，实际放行到 %q", got)
			}
		})
	}
}
