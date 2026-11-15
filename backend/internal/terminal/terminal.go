// Package terminal 提供内置 bash 终端所需的 PTY 会话。
//
// 这里刻意不引入 node-pty / creack-pty 之类的第三方包：项目当前是零依赖，
// Linux 上打开 /dev/ptmx + ioctl 就能拿到一对主从设备，代码量并不比引依赖多。
// 非 Linux 平台单独给出明确的「不支持」错误，而不是假装能开一个没有 TTY 的 shell
// （没有 TTY 时 bash 不是交互模式，Ctrl-C、vim、top 全都不工作）。
package terminal

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ErrUnsupported 表示当前平台没有实现 PTY。
var ErrUnsupported = errors.New("terminal: 当前平台不支持内置终端")

// DefaultCols / DefaultRows 是前端未上报尺寸时的初始窗口。
const (
	DefaultCols = 80
	DefaultRows = 24
	MaxCols     = 400
	MaxRows     = 200
)

// FindShell 选择内置终端使用的 shell。
//
// 优先级：显式配置 > $SHELL > bash > sh。只接受绝对路径或 PATH 中可找到的
// 可执行文件，避免把请求里的任意字符串交给 exec。
func FindShell(preferred string) (string, error) {
	candidates := make([]string, 0, 4)
	if p := strings.TrimSpace(preferred); p != "" {
		candidates = append(candidates, p)
	}
	candidates = append(candidates, os.Getenv("SHELL"), "bash", "sh")
	for _, c := range candidates {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		if !strings.ContainsRune(c, filepath.Separator) {
			if p, err := exec.LookPath(c); err == nil {
				return p, nil
			}
			continue
		}
		if st, err := os.Stat(c); err == nil && st.Mode().IsRegular() && st.Mode()&0o111 != 0 {
			return c, nil
		}
	}
	return "", errors.New("terminal: 找不到可用的 shell（尝试 $SHELL / bash / sh）")
}

// clampSize 把前端上报的终端尺寸收进合理范围。
func clampSize(cols, rows uint16) (uint16, uint16) {
	if cols < 2 {
		cols = DefaultCols
	}
	if rows < 1 {
		rows = DefaultRows
	}
	if cols > MaxCols {
		cols = MaxCols
	}
	if rows > MaxRows {
		rows = MaxRows
	}
	return cols, rows
}
