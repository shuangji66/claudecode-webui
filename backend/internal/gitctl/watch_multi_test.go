package gitctl

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func initWatchRepo(t *testing.T, dir string) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("没有 git")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "LC_ALL=C", "GIT_TERMINAL_PROMPT=0")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q")
	run("config", "user.email", "t@example.com")
	run("config", "user.name", "T")
	file := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(file, []byte("one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-qm", "init")
	return file
}

// 一次 WatchSet 盯两个仓库：改动各推各的，互不影响（分栏两栏各看一个仓库就是它）。
func TestWatchSetTwoReposIndependently(t *testing.T) {
	root := t.TempDir()
	fileA := initWatchRepo(t, filepath.Join(root, "a"))
	fileB := initWatchRepo(t, filepath.Join(root, "b"))
	repoA, repoB := filepath.Dir(fileA), filepath.Dir(fileB)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	notify := make(chan string, 4)
	go WatchSet(ctx, func() []string { return []string{repoA, repoB} }, 20*time.Millisecond, func(cwd string) {
		select {
		case notify <- cwd:
		default:
		}
	})
	// 等两轮基线（第一轮只建立基线）。
	time.Sleep(500 * time.Millisecond)

	if err := os.WriteFile(fileB, []byte("two\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case cwd := <-notify:
		if cwd != repoB {
			t.Fatalf("推送的仓库 = %q，want %q", cwd, repoB)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("B 的改动没有推送")
	}
	if err := os.WriteFile(fileA, []byte("two\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case cwd := <-notify:
		if cwd != repoA {
			t.Fatalf("推送的仓库 = %q，want %q", cwd, repoA)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("A 的改动没有推送")
	}
}

// 读失败（目录暂时不是仓库 / git 抖动）时不能把基线丢掉：恢复后必须补推一次，
// 否则「失败那一瞬间发生的改动」永远推不出去。
func TestWatchSetPushesAfterReadFailure(t *testing.T) {
	root := t.TempDir()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("没有 git")
	}
	// 先建一个空目录（不是仓库：ReadStatus 会失败）。
	dir := filepath.Join(root, "repo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	notify := make(chan string, 4)
	go WatchSet(ctx, func() []string { return []string{dir} }, 20*time.Millisecond, func(cwd string) {
		select {
		case notify <- cwd:
		default:
		}
	})
	time.Sleep(150 * time.Millisecond) // 失败轮次

	// 变成真仓库：恢复后要推一次（哪怕此前没有基线）。
	initWatchRepo(t, dir)
	select {
	case <-notify:
	case <-time.After(3 * time.Second):
		t.Fatal("读失败恢复后应补推一次")
	}
}
