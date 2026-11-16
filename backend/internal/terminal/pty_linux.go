//go:build linux

package terminal

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// Linux ioctl 常量（asm-generic/ioctls.h）。
const (
	ioctlTIOCGPTN   = 0x80045430
	ioctlTIOCSPTLCK = 0x40045431
	ioctlTIOCSWINSZ = 0x5414
)

type winsize struct {
	Row    uint16
	Col    uint16
	Xpixel uint16
	Ypixel uint16
}

// Session 是一个运行中的 PTY shell。
//
// 主设备（master）由本进程持有；从设备在子进程里是 fd 0/1/2。
// Close 会向 shell 所在会话发 SIGHUP，必要时升级为 SIGKILL，确保子进程
// 不会因为前端关页而变成孤儿。
type Session struct {
	master *os.File
	cmd    *exec.Cmd

	done     chan struct{}
	waitErr  error
	closeOne sync.Once
}

// Start 在 cwd 打开一个带 PTY 的交互 shell。
func Start(shell, cwd string, cols, rows uint16) (*Session, error) {
	cols, rows = clampSize(cols, rows)

	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return nil, fmt.Errorf("terminal: 打开 /dev/ptmx: %w", err)
	}
	// 解锁从设备并取编号；两步 ioctl 是 Linux 伪终端的标准握手。
	var unlock int32
	if err := ioctl(master.Fd(), ioctlTIOCSPTLCK, unsafe.Pointer(&unlock)); err != nil {
		_ = master.Close()
		return nil, fmt.Errorf("terminal: 解锁 PTY: %w", err)
	}
	var ptyNo uint32
	if err := ioctl(master.Fd(), ioctlTIOCGPTN, unsafe.Pointer(&ptyNo)); err != nil {
		_ = master.Close()
		return nil, fmt.Errorf("terminal: 读取 PTY 编号: %w", err)
	}
	slavePath := "/dev/pts/" + strconv.FormatUint(uint64(ptyNo), 10)
	slave, err := os.OpenFile(slavePath, os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		_ = master.Close()
		return nil, fmt.Errorf("terminal: 打开 %s: %w", slavePath, err)
	}
	if err := resize(master, cols, rows); err != nil {
		_ = slave.Close()
		_ = master.Close()
		return nil, err
	}

	cmd := exec.Command(shell)
	cmd.Dir = cwd
	cmd.Env = shellEnv(cwd)
	cmd.Stdin = slave
	cmd.Stdout = slave
	cmd.Stderr = slave
	// Ctty 是「子进程里的 fd 编号」：stdin 已被分配到 0，从设备就是控制终端。
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}

	if err := cmd.Start(); err != nil {
		_ = slave.Close()
		_ = master.Close()
		return nil, fmt.Errorf("terminal: 启动 %s: %w", shell, err)
	}
	// 父子各持一份从设备；父进程必须立刻关掉，否则子进程退出后 master 读不到 EIO。
	_ = slave.Close()

	s := &Session{master: master, cmd: cmd, done: make(chan struct{})}
	go func() {
		s.waitErr = cmd.Wait()
		close(s.done)
	}()
	return s, nil
}

// Read 读取终端输出（原始字节，含 ANSI 转义序列）。
func (s *Session) Read(p []byte) (int, error) { return s.master.Read(p) }

// Write 把用户输入写进 PTY。
func (s *Session) Write(p []byte) (int, error) { return s.master.Write(p) }

// Resize 更新 PTY 窗口尺寸。
func (s *Session) Resize(cols, rows uint16) error {
	cols, rows = clampSize(cols, rows)
	return resize(s.master, cols, rows)
}

// Wait 等待 shell 退出并返回退出状态。
func (s *Session) Wait() error {
	<-s.done
	return s.waitErr
}

// Done 在 shell 退出后关闭，便于读循环与 Wait 解耦。
func (s *Session) Done() <-chan struct{} { return s.done }

// ExitCode 返回退出码；尚未退出时返回 -1。
func (s *Session) ExitCode() int {
	select {
	case <-s.done:
		if s.waitErr == nil {
			return 0
		}
		var exitErr *exec.ExitError
		if ok := asExitError(s.waitErr, &exitErr); ok {
			return exitErr.ExitCode()
		}
		return -1
	default:
		return -1
	}
}

// Pid 返回 shell 的进程号。
func (s *Session) Pid() int {
	if s.cmd.Process == nil {
		return -1
	}
	return s.cmd.Process.Pid
}

// Close 结束 shell（幂等）。先 SIGHUP 让交互式 shell 走正常退出流程，
// 2 秒内没退再 SIGKILL 整个进程组。
func (s *Session) Close() error {
	s.closeOne.Do(func() {
		// Wait 已经回收进程时，PID 可能被系统复用；此时只关主设备，绝不能发信号。
		select {
		case <-s.done:
			_ = s.master.Close()
			return
		default:
		}
		if s.cmd.Process != nil {
			pid := s.cmd.Process.Pid
			_ = syscall.Kill(-pid, syscall.SIGHUP)
			_ = s.master.Close()
			select {
			case <-s.done:
				// shell 自己退了，但交互式 bash 的作业控制会为每个 job 建独立进程组：
				// `npm run dev &` 这类后台作业既不在 shell 的 pgrp 里、也不是前台组，
				// 上面那两次信号都碰不到它们。按会话回扫一遍收尾。
				killSession(pid, syscall.SIGKILL)
			case <-time.After(2 * time.Second):
				_ = syscall.Kill(-pid, syscall.SIGKILL)
				killSession(pid, syscall.SIGKILL)
				<-s.done
			}
			return
		}
		_ = s.master.Close()
	})
	return nil
}

func resize(f *os.File, cols, rows uint16) error {
	ws := winsize{Row: rows, Col: cols}
	if err := ioctl(f.Fd(), ioctlTIOCSWINSZ, unsafe.Pointer(&ws)); err != nil {
		return fmt.Errorf("terminal: 设置窗口尺寸: %w", err)
	}
	return nil
}

func ioctl(fd uintptr, req uintptr, arg unsafe.Pointer) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, req, uintptr(arg))
	if errno != 0 {
		return errno
	}
	return nil
}

// shellEnv 复制当前环境，但固定 PWD/TERM/COLORTERM。
// 终端是给用户直接用的，保留操作者的环境（PATH、代理、语言等）；只删掉
// 会让 shell 误判目录/终端能力的旧值。
func shellEnv(cwd string) []string {
	src := os.Environ()
	out := make([]string, 0, len(src)+3)
	for _, kv := range src {
		switch {
		case strings.HasPrefix(kv, "PWD="), strings.HasPrefix(kv, "OLDPWD="),
			strings.HasPrefix(kv, "TERM="), strings.HasPrefix(kv, "COLORTERM="):
			continue
		}
		out = append(out, kv)
	}
	return append(out, "PWD="+cwd, "TERM=xterm-256color", "COLORTERM=truecolor")
}

func asExitError(err error, target **exec.ExitError) bool {
	for err != nil {
		if e, ok := err.(*exec.ExitError); ok {
			*target = e
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

// killSession 向「会话 id 等于 sid」的所有进程发信号。
//
// Setsid 让 shell 成为会话首进程（sid == pid），它派生的一切都留在该会话里；
// 只按进程组杀会漏掉 bash 作业控制给后台 job 另建的组。
func killSession(sid int, sig syscall.Signal) {
	if sid <= 0 {
		return
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return
	}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == sid {
			continue
		}
		b, err := os.ReadFile("/proc/" + e.Name() + "/stat")
		if err != nil {
			continue
		}
		// 格式：pid (comm) state ppid pgrp session ...；comm 可能含空格与括号。
		idx := strings.LastIndexByte(string(b), ')')
		if idx < 0 {
			continue
		}
		fields := strings.Fields(string(b[idx+1:]))
		if len(fields) < 4 {
			continue
		}
		if got, err := strconv.Atoi(fields[3]); err == nil && got == sid {
			_ = syscall.Kill(pid, sig)
		}
	}
}
