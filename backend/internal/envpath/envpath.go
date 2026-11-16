// Package envpath 保证「查可执行文件」不依赖启动器有没有给 PATH。
//
// 踩过的坑：飞牛（fnOS）的 fpk 启动脚本如果没有 `export PATH="$PATH"`，
// 应用可能是被「空环境」exec 起来的——此时进程里根本没有 PATH 变量。
// Go 的 exec.LookPath 对空 PATH 直接失败（不会回落到 /bin:/usr/bin），
// 于是 git 面板（spawn `git`）和内置终端（找 bash/sh）双双不可用，
// 而 claude 会话不受影响（它用托管版本的绝对路径启动）。
package envpath

import (
	"os"
	"strings"
)

// Default 是 Linux 上最常见的可执行文件目录。
const Default = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// Effective 返回当前进程应该使用的 PATH：环境里非空就用它，否则回落到 Default。
func Effective() string {
	if p := strings.TrimSpace(os.Getenv("PATH")); p != "" {
		return p
	}
	return Default
}

// Apply 在进程 PATH 为空时补上 Default，返回是否打过补丁（启动日志用）。
//
// 补的是**本进程**的环境：之后所有 exec.LookPath 与子进程继承都会正常。
func Apply() bool {
	if strings.TrimSpace(os.Getenv("PATH")) != "" {
		return false
	}
	_ = os.Setenv("PATH", Default)
	return true
}

// Ensure 保证给定的环境切片里有非空 PATH（给子进程用）。
func Ensure(env []string) []string {
	for _, kv := range env {
		if strings.HasPrefix(kv, "PATH=") && strings.TrimSpace(kv[len("PATH="):]) != "" {
			return env
		}
	}
	return append(env, "PATH="+Effective())
}
