package process

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"testing"
	"time"
)

// groupMembers 返回当前 pgid 等于给定值的所有进程（读 /proc/<pid>/stat 的 pgrp）。
func groupMembers(t *testing.T, pgid int) []int {
	t.Helper()
	entries, err := os.ReadDir("/proc")
	if err != nil {
		t.Skipf("没有 /proc: %v", err)
	}
	var out []int
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
		if err != nil {
			continue
		}
		// 格式：pid (comm) state ppid pgrp ...；comm 里可能有空格和括号，按最后一个 ')' 切。
		idx := bytes.LastIndexByte(b, ')')
		if idx < 0 {
			continue
		}
		fields := bytes.Fields(b[idx+1:])
		if len(fields) < 3 {
			continue
		}
		if g, err := strconv.Atoi(string(fields[2])); err == nil && g == pgid {
			out = append(out, pid)
		}
	}
	return out
}

// 回归：关闭会话必须收掉整个进程组，而不只是直接子进程。
//
// 旧实现只 cmd.Process.Kill()，claude 用 Bash 工具起的 `npm run dev` / `sleep`
// 会留成孤儿，占着 CPU 与文件锁，界面上完全看不见。
func TestCloseKillsWholeProcessGroup(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("没有 sh")
	}
	if _, err := os.Stat("/proc/self/stat"); err != nil {
		t.Skip("没有 procfs")
	}

	// shell 起一个后台 sleep 并 wait：两者与 shell 同组。
	p, err := Spawn(sh, []string{"-c", "sleep 60 & echo $!; wait"}, t.TempDir(), os.Environ())
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	pgid := p.Pid()

	// 读到后台子进程的 pid，确认它真的起来了。
	sc := bufio.NewScanner(p)
	sc.Buffer(make([]byte, 0, 1024), 4096)
	if !sc.Scan() {
		_ = p.Close()
		t.Fatalf("没读到后台 pid: %v", sc.Err())
	}
	if _, err := strconv.Atoi(sc.Text()); err != nil {
		_ = p.Close()
		t.Fatalf("后台 pid 不是数字: %q", sc.Text())
	}
	if len(groupMembers(t, pgid)) == 0 {
		_ = p.Close()
		t.Skip("进程组里没有成员（环境限制），跳过")
	}

	if err := p.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if len(groupMembers(t, pgid)) == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("关闭后进程组 %d 仍存活成员: %v", pgid, groupMembers(t, pgid))
}
