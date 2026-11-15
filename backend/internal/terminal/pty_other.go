//go:build !linux

package terminal

import "fmt"

// Session 在非 Linux 平台上只是占位：内置终端依赖 Linux 的 /dev/ptmx。
// 明确返回 ErrUnsupported，前端会显示可读提示，而不是开一个没有 TTY 的假终端。
type Session struct{}

// Start 在非 Linux 平台返回 ErrUnsupported。
func Start(shell, cwd string, cols, rows uint16) (*Session, error) {
	return nil, fmt.Errorf("%w（当前系统无法创建 PTY）", ErrUnsupported)
}

// Read 不会被调用。
func (s *Session) Read(p []byte) (int, error) { return 0, ErrUnsupported }

// Write 不会被调用。
func (s *Session) Write(p []byte) (int, error) { return 0, ErrUnsupported }

// Resize 不会被调用。
func (s *Session) Resize(cols, rows uint16) error { return ErrUnsupported }

// Wait 不会被调用。
func (s *Session) Wait() error { return ErrUnsupported }

// Done 返回一个永不关闭的通道。
func (s *Session) Done() <-chan struct{} {
	ch := make(chan struct{})
	return ch
}

// ExitCode 返回 -1。
func (s *Session) ExitCode() int { return -1 }

// Pid 返回 -1。
func (s *Session) Pid() int { return -1 }

// Close 什么都不做。
func (s *Session) Close() error { return nil }
