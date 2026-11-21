package gitctl

import (
	"os"
	"path/filepath"
	"testing"
)

func mkRepo(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatalf("mkdir .git: %v", err)
	}
}

func repoPaths(repos []Repo) []string {
	out := make([]string, 0, len(repos))
	for _, r := range repos {
		out = append(out, r.Path)
	}
	return out
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestFindRepos(t *testing.T) {
	root := t.TempDir()
	// 工作区根自己不是仓库；子目录里并排放着两个仓库，另有一个更深的仓库，
	// alpha 内部还有一个嵌套仓库（子模块 / 独立检出）。
	mkRepo(t, filepath.Join(root, "alpha"))
	mkRepo(t, filepath.Join(root, "beta"))
	mkRepo(t, filepath.Join(root, "group", "gamma"))
	mkRepo(t, filepath.Join(root, "alpha", "vendor", "dep"))
	// 以下都不该出现：隐藏目录、node_modules、非仓库目录。
	mkRepo(t, filepath.Join(root, ".hidden"))
	mkRepo(t, filepath.Join(root, "alpha", "node_modules", "dep"))
	mkRepo(t, filepath.Join(root, "alpha", "vendor", "dep", ".hidden"))
	if err := os.MkdirAll(filepath.Join(root, "plain"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	repos, err := FindRepos(root, 0)
	if err != nil {
		t.Fatalf("FindRepos: %v", err)
	}
	want := []string{"alpha", "alpha/vendor/dep", "beta", "group/gamma"}
	if got := repoPaths(repos); !equalStrings(got, want) {
		t.Fatalf("仓库 = %v, want %v", got, want)
	}
	if repos[0].Name != "alpha" || repos[0].Root != filepath.Join(root, "alpha") {
		t.Fatalf("首个仓库 = %+v", repos[0])
	}
	if repos[0].Nested {
		t.Fatalf("alpha 是外层仓库，不该标成嵌套: %+v", repos[0])
	}
	if !repos[1].Nested {
		t.Fatalf("alpha/vendor/dep 应标成嵌套: %+v", repos[1])
	}
	if repos[3].Nested {
		t.Fatalf("group/gamma 只是普通的深层仓库，不是嵌套仓库: %+v", repos[3])
	}
}

func TestFindReposRootItself(t *testing.T) {
	root := t.TempDir()
	mkRepo(t, root)
	mkRepo(t, filepath.Join(root, "nested"))
	mkRepo(t, filepath.Join(root, "libs", "deep", "inner"))

	repos, err := FindRepos(root, 0)
	if err != nil {
		t.Fatalf("FindRepos: %v", err)
	}
	// 根是仓库时根仓库排最前，内部嵌套仓库跟在它后面——它们各自是独立仓库，
	// 面板需要一个能切过去看它自己的改动的入口。
	want := []string{"", "libs/deep/inner", "nested"}
	if got := repoPaths(repos); !equalStrings(got, want) {
		t.Fatalf("repos = %v, want %v", got, want)
	}
	if repos[0].Name != filepath.Base(root) {
		t.Fatalf("根仓库名 = %q", repos[0].Name)
	}
	if repos[0].Nested || !repos[1].Nested || !repos[2].Nested {
		t.Fatalf("嵌套标记 = %+v", repos)
	}
}

func TestFindReposSkipsSymlinks(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	mkRepo(t, filepath.Join(outside, "secret"))
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Skipf("symlink: %v", err)
	}

	repos, err := FindRepos(root, 0)
	if err != nil {
		t.Fatalf("FindRepos: %v", err)
	}
	if len(repos) != 0 {
		t.Fatalf("软链指向的仓库不该列出: %+v", repos)
	}
}

func TestFindReposDepthAndEmpty(t *testing.T) {
	root := t.TempDir()
	mkRepo(t, filepath.Join(root, "a", "b", "c", "d")) // 超过默认深度

	repos, err := FindRepos(root, 0)
	if err != nil {
		t.Fatalf("FindRepos: %v", err)
	}
	if len(repos) != 0 {
		t.Fatalf("过深的仓库不应列出: %+v", repos)
	}

	repos, err = FindRepos(root, 5)
	if err != nil {
		t.Fatalf("FindRepos: %v", err)
	}
	if len(repos) != 1 || repos[0].Path != "a/b/c/d" || repos[0].Nested {
		t.Fatalf("加大深度后 = %+v", repos)
	}
}

func TestEnclosingRepo(t *testing.T) {
	root := t.TempDir()
	mkRepo(t, filepath.Join(root, "repo"))
	sub := filepath.Join(root, "repo", "src", "app")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	if got := EnclosingRepo(sub); got != filepath.Join(root, "repo") {
		t.Fatalf("EnclosingRepo(子目录) = %q", got)
	}
	if got := EnclosingRepo(filepath.Join(root, "repo")); got != filepath.Join(root, "repo") {
		t.Fatalf("EnclosingRepo(仓库根) = %q", got)
	}
	if got := EnclosingRepo(root); got != "" {
		t.Fatalf("EnclosingRepo(仓库外) = %q", got)
	}

	// worktree / 子模块的 .git 是文件，同样要认出来。
	wt := filepath.Join(root, "worktree")
	if err := os.MkdirAll(wt, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: /tmp/x\n"), 0o644); err != nil {
		t.Fatalf("write .git: %v", err)
	}
	if got := EnclosingRepo(wt); got != wt {
		t.Fatalf("EnclosingRepo(worktree) = %q", got)
	}
}
