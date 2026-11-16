//go:build !unix

package process

import (
	"os/exec"
	"syscall"
)

// setPgid 在非 unix 平台是空操作：这里没有进程组，只能杀直接子进程。
func setPgid(*exec.Cmd) {}

// signalGroup 在非 unix 平台是空操作（Proc.Close 会退回 Process.Kill）。
func signalGroup(int, syscall.Signal) error { return nil }
