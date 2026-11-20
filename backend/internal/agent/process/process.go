// Package process 负责拼装命令行参数、净化子进程环境。
//
// 该包不定位可执行文件、也不启动进程：路径只来自 internal/claudebin 的托管版本，
// 这里只产出「带什么参数、给什么环境」，便于单测。
package process

import (
	"ccweb/backend/internal/envpath"
	"strings"
)

// Options 描述一次 claude 调用的启动参数。
type Options struct {
	// Model 为空表示使用 CLI 默认模型。
	Model string
	// PermissionMode 为空表示不显式指定，交由 CLI 设置决定。
	PermissionMode string
	// Effort 是推理强度（low/medium/high/xhigh/max）；空表示用 CLI 默认。
	Effort string
	// Resume 非空则续接该 session id。
	Resume string
	// Fork 为 true 时把 Resume 的历史复制到 SessionID 指定的新会话（--fork-session），
	// 原会话不受影响。只有较新版本认识这个参数，调用方要先用 supportsFlag 探测。
	//
	// 必须和 Resume + SessionID 一起用：实测 2.1.326 上
	// `--resume <旧> --fork-session --session-id <新>` 会把历史写到新文件、
	// 行内 sessionId 全部重写成新 id，旧文件字节不变。
	Fork bool
	// SessionID 非空则强制使用该 session id（必须是 UUID）。
	SessionID string
	// AddDirs 追加可访问目录。
	AddDirs []string
	// IncludePartialMessages 打开逐 token 流式（stream_event）。
	IncludePartialMessages bool
	// ForwardSubagentText 把子代理的正文与思考也转发到 stdout（带 parent_tool_use_id）。
	// 只有较新版本支持，调用方要先用 manager.supportsFlag 探测。
	ForwardSubagentText bool
	// IncludeHookEvents 把 hook 的生命周期帧（`hook_started` / `hook_progress` /
	// `hook_response`）也转发到 stdout。
	//
	// **不带这个参数时一条都不会有**（实测 2.1.329：同一个 hook 配置，加参数能收到
	// hook_started/hook_response 各两条，不加则一条都没有——失败的那次只剩一条
	// `system/informational` 包装）。界面靠它们做两件事：把 hook 执行失败的**原因**
	// （原因只在 stderr 里）显示出来，以及在 hook 跑着的时候把计时行从「上游 Ns 没有
	// 响应」换成「hook X 正在跑」——hook 是本地进程，跑多久与上游无关。
	// 老版本不认识这个参数会直接起不来，所以要用 supportsFlag 探测。
	IncludeHookEvents bool
	// AllowBypassPermissions 允许会话在运行中切到 bypassPermissions（界面上的「跳过权限」）。
	//
	// claude 只在「启动时带着这个能力」的会话里接受 set_permission_mode
	// bypassPermissions，否则回 "session was not launched with
	// --dangerously-skip-permissions"。注意它是**能力开关**，不是模式本身：
	// 会话仍按 PermissionMode 启动，实测带它 + default 时第一轮照常弹审批，
	// 切过去之后才自动放行。
	AllowBypassPermissions bool
	// AllowedTools 是**本会话预先放行**的工具名（跳过审批面板）。内置搜索注册后
	// 用它让模型直接调 mcp__ccweb-web__web_search，不必每搜一次弹一次审批。
	AllowedTools []string
	// DisallowedTools 是**本会话禁用**的工具名。内置搜索注册后用它挡掉 claude 自带的
	// WebSearch/WebFetch：这两个在自建中转下走服务端工具，通常调不通，却会以裸名字
	// 出现在延迟工具名单里，和面板的搜索工具抢选择。
	DisallowedTools []string
}

// Args 返回传给 claude 的参数列表（不含程序名）。
//
// 关键点：`--permission-prompt-tool stdio` 必须带上，否则需要审批的工具会被
// fail-closed 静默拒绝，`can_use_tool` 控制请求永远不会出现。
func Args(o Options) []string {
	args := []string{
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
		"--permission-prompt-tool", "stdio",
	}
	if o.IncludePartialMessages {
		args = append(args, "--include-partial-messages")
	}
	if o.ForwardSubagentText {
		args = append(args, "--forward-subagent-text")
	}
	if o.IncludeHookEvents {
		args = append(args, "--include-hook-events")
	}
	if o.AllowBypassPermissions {
		args = append(args, "--allow-dangerously-skip-permissions")
	}
	if o.Model != "" {
		args = append(args, "--model", o.Model)
	}
	if o.PermissionMode != "" {
		args = append(args, "--permission-mode", o.PermissionMode)
	}
	if o.Effort != "" {
		args = append(args, "--effort", o.Effort)
	}
	// 工具规则走命令行而不是改用户的 settings.json：随会话存在、随会话消失，
	// 用户手动改过的配置不会因为注册一次内置搜索就被写走样。
	// 两个参数都很老，不需要 supportsFlag 探测。
	if len(o.AllowedTools) > 0 {
		args = append(args, "--allowedTools", strings.Join(o.AllowedTools, ","))
	}
	if len(o.DisallowedTools) > 0 {
		args = append(args, "--disallowedTools", strings.Join(o.DisallowedTools, ","))
	}
	if o.Resume != "" {
		args = append(args, "--resume", o.Resume)
		if o.Fork {
			args = append(args, "--fork-session")
		}
	}
	if o.SessionID != "" {
		args = append(args, "--session-id", o.SessionID)
	}
	for _, d := range o.AddDirs {
		if d != "" {
			args = append(args, "--add-dir", d)
		}
	}
	return args
}

// strippedEnvKeys 是从继承环境里剔除的变量。
//
//   - CLAUDECODE / CLAUDE_CODE_ENTRYPOINT：由 CLI 注入，留着可能让子进程以为自己在
//     另一个 Claude Code 会话里，从而改变启动行为。
//
// 注意：**不能**剔除 ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY —— 通过自定义中转
// 访问正是本项目的核心能力，必须原样继承。
var strippedEnvKeys = map[string]bool{
	"CLAUDECODE":             true,
	"CLAUDE_CODE_ENTRYPOINT": true,
	// HOME/PWD 由 CleanEnv 强制注入，继承值必须先剔除，否则环境里会出现两份，
	// 且按「后者生效」的规则被继承值悄悄覆盖（本地项目踩过这个坑）。
	"HOME": true,
	"PWD":  true,
	// 代理由设置页统一控制：空 = 直连，不能悄悄继承宿主机代理。
	"HTTP_PROXY":         true,
	"HTTPS_PROXY":        true,
	"ALL_PROXY":          true,
	"SOCKS_PROXY":        true,
	"NO_PROXY":           true,
	"NODE_USE_ENV_PROXY": true,
	"http_proxy":         true,
	"https_proxy":        true,
	"all_proxy":          true,
	"socks_proxy":        true,
	"no_proxy":           true,
}

// CleanEnv 构造子进程环境：剔除会干扰启动的继承变量，并强制 HOME/PWD。
//
// 环境变量重复时后者生效，所以必须先剔除再追加，不能直接 append。
func CleanEnv(inherited []string, home, cwd string) []string {
	out := make([]string, 0, len(inherited)+2)
	for _, kv := range inherited {
		key := kv
		if i := strings.IndexByte(kv, '='); i >= 0 {
			key = kv[:i]
		}
		if strippedEnvKeys[key] {
			continue
		}
		out = append(out, kv)
	}
	if home != "" {
		out = append(out, "HOME="+home)
	}
	if cwd != "" {
		out = append(out, "PWD="+cwd)
	}
	// 启动器可能没给 PATH（fnOS 的 fpk 脚本漏了 export PATH）：claude 里的
	// bash 工具、git 都会因此失效，这里兜一个默认值。
	return envpath.Ensure(out)
}
