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

func TestFindRepos(t *testing.T) {
	root := t.TempDir()
	// 工作区根自己不是仓库；子目录里并排放着两个仓库，另有一个更深的仓库。
	mkRepo(t, filepath.Join(root, "alpha"))
	mkRepo(t, filepath.Join(root, "beta"))
	mkRepo(t, filepath.Join(root, "group", "gamma"))
	// 以下都不该出现：隐藏目录、node_modules、非仓库目录。
	mkRepo(t, filepath.Join(root, ".hidden"))
	mkRepo(t, filepath.Join(root, "alpha", "node_modules", "dep"))
	mkRepo(t, filepath.Join(root, "alpha", "sub")) // 仓库内部不再下钻
	if err := os.MkdirAll(filepath.Join(root, "plain"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	repos, err := FindRepos(root, 0)
	if err != nil {
		t.Fatalf("FindRepos: %v", err)
	}
	got := make([]string, 0, len(repos))
	for _, r := range repos {
		got = append(got, r.Path)
	}
	want := []string{"alpha", "beta", "group/gamma"}
	if len(got) != len(want) {
		t.Fatalf("仓库 = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("仓库 = %v, want %v", got, want)
		}
	}
	if repos[0].Name != "alpha" || repos[0].Root != filepath.Join(root, "alpha") {
		t.Fatalf("首个仓库 = %+v", repos[0])
	}
}

func TestFindReposRootItself(t *testing.T) {
	root := t.TempDir()
	mkRepo(t, root)
	mkRepo(t, filepath.Join(root, "nested"))

	repos, err := FindRepos(root, 0)
	if err != nil {
		t.Fatalf("FindRepos: %v", err)
	}
	// 根是仓库时只报它自己：面板视角就是根仓库，不再把嵌套仓库并排列出。
	if len(repos) != 1 || repos[0].Path != "" || repos[0].Root != root {
		t.Fatalf("repos = %+v", repos)
	}
	if repos[0].Name != filepath.Base(root) {
		t.Fatalf("根仓库名 = %q", repos[0].Name)
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
	if len(repos) != 1 || repos[0].Path != "a/b/c/d" {
		t.Fatalf("加大深度后 = %+v", repos)
	}
}
