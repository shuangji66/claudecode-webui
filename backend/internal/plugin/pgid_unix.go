//go:build unix

package plugin

import (
	"os/exec"
	"syscall"
)

// setPgid 让子进程自成进程组。
//
// `claude plugin install` 会再 spawn git；只杀直接子进程的话，超时后 git 仍在
// clone，而它的管道还挂在 claude 的 stdout 上——`cmd.Run()` 会一直等到 git 结束，
// 超时形同虚设（实测：脚本里睡 5 秒，2 秒超时却等了 5 秒）。
func setPgid(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// killGroup 向整个进程组发 SIGKILL（pid 是组长）。
func killGroup(pid int) {
	if pid > 0 {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
	}
}
