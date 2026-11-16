//go:build unix

package process

import (
	"os/exec"
	"syscall"
)

// setPgid 让子进程自成进程组。
//
// claude 用 Bash 工具起的 shell、`npm run dev`、`tail -f` 之类都会落在这个组里；
// 不设的话它们与 ccweb 同组（或另起组），关闭会话时只杀直接子进程会留下孤儿，
// 占着 CPU 与文件锁且界面上看不见。
func setPgid(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// signalGroup 向整个进程组发信号（pid 是组长）。
func signalGroup(pid int, sig syscall.Signal) error {
	if pid <= 0 {
		return nil
	}
	return syscall.Kill(-pid, sig)
}
