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

func TestWatchTwoReposIndependently(t *testing.T) {
	root := t.TempDir()
	fileA := initWatchRepo(t, filepath.Join(root, "a"))
	fileB := initWatchRepo(t, filepath.Join(root, "b"))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	notifyA := make(chan struct{}, 1)
	notifyB := make(chan struct{}, 1)
	go Watch(ctx, filepath.Dir(fileA), 20*time.Millisecond, func() { notifyA <- struct{}{} })
	go Watch(ctx, filepath.Dir(fileB), 20*time.Millisecond, func() { notifyB <- struct{}{} })
	time.Sleep(600 * time.Millisecond)

	if err := os.WriteFile(fileB, []byte("two\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-notifyB:
	case <-time.After(3 * time.Second):
		t.Fatal("B 的改动没有推送")
	}
	if err := os.WriteFile(fileA, []byte("two\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-notifyA:
	case <-time.After(3 * time.Second):
		t.Fatal("A 的改动没有推送")
	}
}
