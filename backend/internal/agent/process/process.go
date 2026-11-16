// Package process 负责定位 claude 可执行文件、拼装命令行参数、净化子进程环境。
//
// 该包不启动进程，只产出「要启动什么、带什么参数、给什么环境」，便于单测。
package process

import (
	"errors"
	"fmt"
	"os"
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
	// SessionID 非空则强制使用该 session id（必须是 UUID）。
	SessionID string
	// AddDirs 追加可访问目录。
	AddDirs []string
	// IncludePartialMessages 打开逐 token 流式（stream_event）。
	IncludePartialMessages bool
}

// Discover 校验显式给出的 claude 路径。
//
// 这里**不再**回退 PATH 或程序同目录：claude 由 internal/claudebin 按版本下载到
// 数据目录并显式选择，回退 PATH 会让"到底跑的是哪个版本"不可控（NAS 上经常同时
// 存在 npm 全局装的、镜像装的、手工放的几份）。explicit 为空说明调用方没有走这条
// 兜底路径——调用方应当先解析托管版本，再来这里。
func Discover(explicit string) (string, error) {
	if explicit == "" {
		return "", errors.New("process: 没有指定 claude 路径")
	}
	return check(explicit)
}

func check(p string) (string, error) {
	st, err := os.Stat(p)
	if err != nil {
		return "", fmt.Errorf("process: %s: %w", p, err)
	}
	if st.IsDir() {
		return "", fmt.Errorf("process: %s 是目录", p)
	}
	return p, nil
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
	if o.Model != "" {
		args = append(args, "--model", o.Model)
	}
	if o.PermissionMode != "" {
		args = append(args, "--permission-mode", o.PermissionMode)
	}
	if o.Effort != "" {
		args = append(args, "--effort", o.Effort)
	}
	if o.Resume != "" {
		args = append(args, "--resume", o.Resume)
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
	return out
}
