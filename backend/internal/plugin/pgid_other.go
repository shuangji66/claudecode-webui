//go:build !unix

package plugin

import "os/exec"

// setPgid 在非 unix 平台是空操作：那里没有进程组，超时只能杀直接子进程。
func setPgid(*exec.Cmd) {}

// killGroup 在非 unix 平台是空操作（由 exec 的默认取消逻辑负责）。
func killGroup(int) {}
