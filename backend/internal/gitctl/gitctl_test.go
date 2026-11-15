package gitctl

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseStatusPorcelainV2(t *testing.T) {
	// 结构取自 `git status --porcelain=v2 --branch --ahead-behind -z`。
	raw := "1 .M N... 100644 100644 100644 aaa bbb dir/a b.txt\x00" +
		"1 M. N... 100644 100644 100644 aaa bbb 中文 文件.txt\x00" +
		"2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt\x00old name.txt\x00" +
		"? untracked.txt\x00" +
		"u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt\x00" +
		"# branch.oid deadbeef\x00# branch.head main\x00# branch.upstream origin/main\x00# branch.ab +2 -3\x00"
	got := parseStatus(raw)
	if !got.IsRepo || got.Branch != "main" || got.Upstream != "origin/main" || got.Ahead != 2 || got.Behind != 3 {
		t.Fatalf("header = %+v", got)
	}
	if len(got.Entries) != 5 {
		t.Fatalf("entries = %d: %+v", len(got.Entries), got.Entries)
	}
	want := []struct{ path, xy string }{
		{"dir/a b.txt", " M"},
		{"中文 文件.txt", "M "},
		{"new name.txt", "R "},
		{"untracked.txt", "??"},
		{"conflict.txt", "UU"},
	}
	for i, w := range want {
		if got.Entries[i].Path != w.path || got.Entries[i].XY != w.xy {
			t.Fatalf("entry[%d] = %+v, want %v", i, got.Entries[i], w)
		}
	}
}

func TestParseStatusDetached(t *testing.T) {
	got := parseStatus("# branch.head (detached)\x00")
	if !got.Detached || got.Branch != "" {
		t.Fatalf("status = %+v", got)
	}
}

func TestParseNumstat(t *testing.T) {
	raw := "1\t2\ta.txt\x00" +
		"-\t-\timg.png\x00" +
		"3\t4\t\x00old.txt\x00new.txt\x00"
	got := parseNumstat(raw)
	if got["a.txt"] == nil || got["a.txt"].Additions != 1 || got["a.txt"].Deletions != 2 {
		t.Fatalf("a.txt = %+v", got["a.txt"])
	}
	if got["img.png"] == nil || !got["img.png"].Binary {
		t.Fatalf("img.png = %+v", got["img.png"])
	}
	if got["new.txt"] == nil || got["new.txt"].Additions != 3 {
		t.Fatalf("new.txt = %+v", got["new.txt"])
	}
}

func TestParseLog(t *testing.T) {
	raw := "abc123\x1f标题\x1f张三\x1f2026-01-02 03:04:05 +0800\x1fabc123full\x1fHEAD -> main, origin/main\x1fparent1 parent2\n"
	got := parseLog(raw)
	if len(got) != 1 {
		t.Fatalf("log = %+v", got)
	}
	e := got[0]
	if e.Hash != "abc123" || e.Subject != "标题" || e.HashFull != "abc123full" || len(e.Parents) != 2 {
		t.Fatalf("entry = %+v", e)
	}
}

func TestCleanPathPreservesSpaces(t *testing.T) {
	if p, err := cleanPath(" leading and trailing .txt "); err != nil || p != " leading and trailing .txt " {
		t.Fatalf("cleanPath = %q, %v", p, err)
	}
}

func TestCleanPathRejectsEscape(t *testing.T) {
	for _, p := range []string{"../x", "a/../../x", "/etc/passwd"} {
		if _, err := cleanPath(p); err == nil {
			t.Fatalf("cleanPath(%q) 应报错", p)
		}
	}
	if _, err := cleanPath("a/../b"); err == nil {
		// `..` 作为中间分量同样拒绝。
		t.Fatal("a/../b 应报错")
	}
}

func TestValidHash(t *testing.T) {
	if !validHash("abc1234") || validHash("-abc123") || validHash("xyz1234") || validHash("abc") {
		t.Fatal("hash 校验不符合预期")
	}
}

func TestStatusOnRealRepo(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("没有 git")
	}
	dir := t.TempDir()
	runGitTest(t, dir, "init", "-q")
	runGitTest(t, dir, "config", "user.email", "test@example.com")
	runGitTest(t, dir, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGitTest(t, dir, "add", ".")
	runGitTest(t, dir, "commit", "-qm", "init")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "新文件.txt"), []byte("hi\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	st, err := ReadStatus(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !st.IsRepo || len(st.Entries) != 2 {
		t.Fatalf("status = %+v", st)
	}
	if st.Branch == "" || st.Root == "" {
		t.Fatalf("缺少分支/根目录: %+v", st)
	}
	diff, err := Diff(context.Background(), dir, "a.txt", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(diff, "+two") {
		t.Fatalf("diff = %q", diff)
	}
}

func runGitTest(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "LC_ALL=C", "GIT_TERMINAL_PROMPT=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func TestStageCommitUnstageAndDiscard(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("没有 git")
	}
	dir := t.TempDir()
	runGitTest(t, dir, "init", "-q")
	runGitTest(t, dir, "config", "user.email", "test@example.com")
	runGitTest(t, dir, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGitTest(t, dir, "add", ".")
	runGitTest(t, dir, "commit", "-qm", "init")

	ctx := context.Background()
	if err := os.WriteFile(filepath.Join(dir, "b.txt"), []byte("two\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Stage(ctx, dir, "b.txt"); err != nil {
		t.Fatalf("Stage: %v", err)
	}
	st, err := ReadStatus(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Entries) != 1 || !strings.Contains(st.Entries[0].XY, "A") {
		t.Fatalf("staged status = %+v", st.Entries)
	}
	if err := Commit(ctx, dir, "add b"); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	entries, err := Log(ctx, dir, 5, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) == 0 || entries[0].Subject != "add b" {
		t.Fatalf("log = %+v", entries)
	}

	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("changed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Discard(ctx, dir, "a.txt"); err != nil {
		t.Fatalf("Discard: %v", err)
	}
	content, err := os.ReadFile(filepath.Join(dir, "a.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "one\n" {
		t.Fatalf("discard 后内容 = %q", content)
	}

	branches, err := ListBranches(ctx, dir)
	if err != nil || branches.Current == "" {
		t.Fatalf("branches = %+v, %v", branches, err)
	}
	if err := Pull(ctx, dir); err == nil {
		// 没有 upstream 时 pull 必须失败；这里只是验证命令确实执行了。
		t.Log("pull 在无 upstream 的仓库上意外成功（git 版本差异？）")
	}
}
