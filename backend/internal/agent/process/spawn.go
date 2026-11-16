package process

import (
	"bytes"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// closeGrace 是 SIGTERM 之后等进程自己退出的时间，超时才整组 SIGKILL。
const closeGrace = 2 * time.Second

// stderrTailBytes 是保留的子进程 stderr 尾部长度，用于启动失败时给出可读原因。
const stderrTailBytes = 8 << 10

// Proc 是一个已启动的 claude 子进程，同时实现会话所需的双工 Transport。
type Proc struct {
	bin    string
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser

	stderrMu  sync.Mutex
	stderrBuf bytes.Buffer

	waitOnce sync.Once
	waitErr  error
	waited   chan struct{}
}

// Spawn 启动子进程。cwd 同时作为 cmd.Dir 与 PWD。
func Spawn(bin string, args []string, cwd string, env []string) (*Proc, error) {
	cmd := exec.Command(bin, args...)
	cmd.Dir = cwd
	cmd.Env = env
	setPgid(cmd)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("process: stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("process: stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("process: stderr pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		// cmd.Start 失败时 exec 不会替我们回收已建的管道；反复启动失败会一直漏 fd。
		_ = stdin.Close()
		_ = stdout.Close()
		_ = stderr.Close()
		return nil, fmt.Errorf("process: 启动 %s 失败: %w", bin, err)
	}

	p := &Proc{bin: bin, cmd: cmd, stdin: stdin, stdout: stdout, waited: make(chan struct{})}

	// stderr 必须持续排空，否则管道写满会阻塞子进程；只保留尾部用于报错。
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stderr.Read(buf)
			if n > 0 {
				p.appendStderr(buf[:n])
			}
			if err != nil {
				return
			}
		}
	}()

	return p, nil
}

func (p *Proc) appendStderr(b []byte) {
	p.stderrMu.Lock()
	defer p.stderrMu.Unlock()
	p.stderrBuf.Write(b)
	if p.stderrBuf.Len() > stderrTailBytes {
		trimmed := p.stderrBuf.Bytes()[p.stderrBuf.Len()-stderrTailBytes:]
		p.stderrBuf.Reset()
		p.stderrBuf.Write(trimmed)
	}
}

// StderrTail 返回子进程 stderr 的尾部文本。
func (p *Proc) StderrTail() string {
	p.stderrMu.Lock()
	defer p.stderrMu.Unlock()
	return p.stderrBuf.String()
}

// Bin 返回启动该进程的二进制路径（用于判断某个版本是否仍被会话使用）。
func (p *Proc) Bin() string { return p.bin }

// Pid 返回子进程 pid。
func (p *Proc) Pid() int { return p.cmd.Process.Pid }

// Read 实现 io.Reader（读子进程 stdout）。
func (p *Proc) Read(b []byte) (int, error) { return p.stdout.Read(b) }

// Write 实现 io.Writer（写子进程 stdin）。
func (p *Proc) Write(b []byte) (int, error) { return p.stdin.Write(b) }

// Close 关闭 stdin 并终止子进程（幂等）。
//
// 先 SIGTERM 整个进程组（让 claude 有机会写完转录尾、让子进程走正常退出），
// 2 秒内没退再 SIGKILL 整组。只杀直接子进程会把 Bash 工具起的兄弟进程留成孤儿。
func (p *Proc) Close() error {
	_ = p.stdin.Close()
	if p.cmd.Process == nil {
		_ = p.Wait()
		return nil
	}
	pid := p.cmd.Process.Pid
	_ = signalGroup(pid, syscall.SIGTERM)

	waitDone := make(chan struct{})
	go func() {
		_ = p.Wait()
		close(waitDone)
	}()
	select {
	case <-waitDone:
	case <-time.After(closeGrace):
		_ = signalGroup(pid, syscall.SIGKILL)
		<-waitDone
	}
	// 组长退出后组里可能还有忽略 SIGTERM 的孙进程；组为空时这里只是 ESRCH。
	// 这一句是「关掉会话不留后台 npm/node」的关键，别当成冗余删掉。
	_ = signalGroup(pid, syscall.SIGKILL)
	return nil
}

// Wait 等待子进程退出（幂等，可并发调用）。
func (p *Proc) Wait() error {
	p.waitOnce.Do(func() {
		p.waitErr = p.cmd.Wait()
		close(p.waited)
	})
	<-p.waited
	return p.waitErr
}
