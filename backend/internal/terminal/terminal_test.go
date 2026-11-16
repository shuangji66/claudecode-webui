//go:build linux

package terminal

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestFindShell(t *testing.T) {
	sh, err := FindShell("")
	if err != nil {
		t.Skipf("没有可用 shell: %v", err)
	}
	if !strings.HasPrefix(sh, "/") {
		t.Fatalf("shell = %q，期望绝对路径", sh)
	}
	if _, err := FindShell("/definitely/not/a/shell"); err != nil {
		// 显式配置无效时会回落到 $SHELL / bash / sh；有回落到就仍然成功。
		if _, fallback := FindShell(""); fallback == nil {
			t.Fatalf("无效应回落到可用 shell，err = %v", err)
		}
	}
}

func TestClampSize(t *testing.T) {
	if c, r := clampSize(0, 0); c != DefaultCols || r != DefaultRows {
		t.Fatalf("clamp = %d,%d", c, r)
	}
	if c, r := clampSize(10000, 10000); c != MaxCols || r != MaxRows {
		t.Fatalf("clamp = %d,%d", c, r)
	}
}

func TestSessionEcho(t *testing.T) {
	sh, err := FindShell("")
	if err != nil {
		t.Skipf("没有可用 shell: %v", err)
	}
	dir := t.TempDir()
	s, err := Start(sh, dir, 80, 24)
	if err != nil {
		t.Skipf("无法启动 PTY（可能容器缺少 /dev/pts）: %v", err)
	}
	defer s.Close()

	if _, err := s.Write([]byte("printf 'ccweb-pty-ok\\n'\n")); err != nil {
		t.Fatalf("写入: %v", err)
	}

	out := make(chan string, 1)
	go func() {
		var b strings.Builder
		buf := make([]byte, 4096)
		for {
			n, err := s.Read(buf)
			if n > 0 {
				b.Write(buf[:n])
				if strings.Contains(b.String(), "ccweb-pty-ok") {
					out <- b.String()
					return
				}
			}
			if err != nil {
				out <- b.String()
				return
			}
		}
	}()

	select {
	case got := <-out:
		if !strings.Contains(got, "ccweb-pty-ok") {
			t.Fatalf("输出 = %q", got)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("等待 shell 输出超时")
	}

	if err := s.Resize(120, 40); err != nil {
		t.Fatalf("resize: %v", err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("cwd 被破坏: %v", err)
	}
}

func TestFindShellWithoutPath(t *testing.T) {
	// 启动器用空环境 exec 时 PATH 是空的：仍然要能找到 /bin/sh。
	t.Setenv("PATH", "")
	t.Setenv("SHELL", "")
	shell, err := FindShell("")
	if err != nil {
		t.Skipf("这台机器没有 /bin/sh 或 /usr/bin/sh: %v", err)
	}
	if !filepath.IsAbs(shell) {
		t.Fatalf("shell 应为绝对路径，得到 %q", shell)
	}
}
