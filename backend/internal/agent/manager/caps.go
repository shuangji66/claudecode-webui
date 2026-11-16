package manager

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// supportsFlag 探测 claude 二进制是否认识某个命令行参数（按二进制路径 + 参数缓存）。
//
// 为什么需要：面板可以切换 claude 版本，而 --forward-subagent-text 只有较新版本才有；
// 给旧版本传未知参数会让进程直接起不来，表现成「会话启动失败」，很难看出原因。
// 探测成本是一次 `claude --help`（几毫秒到几百毫秒），每个版本只做一次。
func (m *Manager) supportsFlag(bin, flag string) bool {
	key := bin + "\x00" + flag
	m.capMu.Lock()
	if v, ok := m.caps[key]; ok {
		m.capMu.Unlock()
		return v
	}
	m.capMu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "--help").CombinedOutput()
	ok := err == nil && strings.Contains(string(out), flag)

	m.capMu.Lock()
	m.caps[key] = ok
	m.capMu.Unlock()
	return ok
}
