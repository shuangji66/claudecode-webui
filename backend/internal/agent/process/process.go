// Package process 负责定位 claude 可执行文件、拼装命令行参数、净化子进程环境。
//
// 该包不启动进程，只产出「要启动什么、带什么参数、给什么环境」，便于单测。
package process

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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

// Discover 依次在显式路径、PATH、可执行文件同目录中查找 claude。
//
// 部署约定：ccweb 二进制与 claude 二进制放在同一目录，且 claude 已在 PATH 中。
// 因此三个来源都要试，任一命中即可。
func Discover(explicit, exePath string) (string, error) {
	if explicit != "" {
		return check(explicit)
	}
	if p, err := exec.LookPath("claude"); err == nil {
		return p, nil
	}
	if exePath != "" {
		cand := filepath.Join(filepath.Dir(exePath), "claude")
		if p, err := check(cand); err == nil {
			return p, nil
		}
	}
	return "", errors.New("process: 找不到 claude 可执行文件（已尝试 CCWEB_CLAUDE_BIN、PATH、程序同目录）")
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
