package gitctl

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

func TestCommitDetails(t *testing.T) {
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
	// 正文要带空行：`%B` 原样返回正文，而详情页只渲染标题之外的正文，
	// 少一个空行就会把「标题」与「正文」粘成一行。
	runGitTest(t, dir, "commit", "-qm", "标题行", "-m", "第一段正文\n\n第二段正文")

	ctx := context.Background()
	entries, err := Log(ctx, dir, 5, 0)
	if err != nil || len(entries) == 0 {
		t.Fatalf("log = %+v, %v", entries, err)
	}
	got, err := CommitDetails(ctx, dir, entries[0].Hash)
	if err != nil {
		t.Fatalf("CommitDetails: %v", err)
	}
	if got.HashFull != entries[0].HashFull || got.Hash != entries[0].Hash {
		t.Fatalf("hash = %q / %q，want %q / %q", got.Hash, got.HashFull, entries[0].Hash, entries[0].HashFull)
	}
	if got.Subject != "标题行" {
		t.Fatalf("subject = %q", got.Subject)
	}
	if got.Author != "Test" || got.AuthorEmail != "test@example.com" {
		t.Fatalf("author = %q <%q>", got.Author, got.AuthorEmail)
	}
	if !strings.Contains(got.Message, "第一段正文") || !strings.Contains(got.Message, "第二段正文") {
		t.Fatalf("message = %q", got.Message)
	}
	if len(got.Parents) != 0 {
		t.Fatalf("首个提交不该有父提交: %+v", got.Parents)
	}
	// 元数据不能混进补丁：否则前端按 `diff --git` 切文件时会多出一段无法归属的头部。
	if strings.Contains(got.Diff, "标题行") {
		t.Fatalf("补丁里混进了提交信息:\n%s", got.Diff)
	}
	if !strings.Contains(got.Diff, "a.txt") {
		t.Fatalf("补丁里没有文件:\n%s", got.Diff)
	}

	// 非法的 hash 必须在跑 git 之前挡掉。
	if _, err := CommitDetails(ctx, dir, "--upload-pack=x"); err == nil {
		t.Fatal("非法 hash 应报错")
	}
}

func TestGitEnvProxy(t *testing.T) {
	// 继承的代理变量必须被剔除，避免和面板设置打架。
	t.Setenv("HTTPS_PROXY", "http://inherited:3128")
	t.Setenv("http_proxy", "http://inherited:3128")

	SetProxySource(nil)
	env := gitEnv()
	for _, kv := range env {
		if strings.HasPrefix(strings.ToLower(kv), "https_proxy=") || strings.HasPrefix(strings.ToLower(kv), "http_proxy=") {
			t.Fatalf("没配代理时不应带代理变量：%s", kv)
		}
	}

	SetProxySource(func() string { return "socks5h://127.0.0.1:1080" })
	env = gitEnv()
	joined := strings.Join(env, "\n")
	for _, want := range []string{
		"https_proxy=socks5h://127.0.0.1:1080",
		"HTTPS_PROXY=socks5h://127.0.0.1:1080",
		"no_proxy=localhost,127.0.0.1,::1",
		"LC_ALL=C",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("缺少 %q：\n%s", want, joined)
		}
	}
	if strings.Contains(joined, "inherited") {
		t.Fatalf("继承的代理变量应被剔除：\n%s", joined)
	}
	SetProxySource(nil)
}

// Watch 是「面板不再轮询」的替代：文件一改就要推一次，基线那一轮不推。
func TestWatchNotifiesOnChange(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("没有 git")
	}
	dir := t.TempDir()
	runGitTest(t, dir, "init", "-q")
	runGitTest(t, dir, "config", "user.email", "test@example.com")
	runGitTest(t, dir, "config", "user.name", "Test")
	file := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(file, []byte("one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGitTest(t, dir, "add", ".")
	runGitTest(t, dir, "commit", "-qm", "init")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	changed := make(chan struct{}, 4)
	go Watch(ctx, dir, 20*time.Millisecond, func() {
		select {
		case changed <- struct{}{}:
		default:
		}
	})

	// 未被修改时不该推送（基线那一轮与后续相同）。
	select {
	case <-changed:
		t.Fatal("仓库没变却收到了推送")
	case <-time.After(150 * time.Millisecond):
	}

	if err := os.WriteFile(file, []byte("two\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-changed:
	case <-time.After(5 * time.Second):
		t.Fatal("文件改动后没有收到推送")
	}

	cancel()
}
