package fsapi

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func searchPaths(t *testing.T, r *Root, query string, hidden bool, limit int) []string {
	t.Helper()
	listing, err := r.Search(context.Background(), query, hidden, limit)
	if err != nil {
		t.Fatalf("Search(%q) 失败: %v", query, err)
	}
	out := make([]string, 0, len(listing.Entries))
	for _, entry := range listing.Entries {
		out = append(out, entry.Path)
	}
	return out
}

func TestSearchMatchesNameAndPath(t *testing.T) {
	r, err := OpenRoot(seedCompleteRoot(t))
	if err != nil {
		t.Fatal(err)
	}

	// 名字子串、大小写不敏感。
	got := searchPaths(t, r, "MAIN", false, 0)
	want := map[string]bool{"src/main.go": true, "src/nested/deep_main.go": true}
	if len(got) != len(want) {
		t.Fatalf("搜 MAIN = %v", got)
	}
	for _, path := range got {
		if !want[path] {
			t.Fatalf("搜 MAIN 出现意外结果: %v", got)
		}
	}
	// 名字完全命中的排在前缀/包含之前。
	if got[0] != "src/main.go" {
		t.Fatalf("完全命中应排第一: %v", got)
	}

	// 带路径片段的查询按相对路径匹配：目录自己与它下面的文件都算命中，
	// 目录排在前面（点一下就能在树里打开它）。
	if paths := searchPaths(t, r, "src/nested", false, 0); len(paths) != 2 || paths[0] != "src/nested" || paths[1] != "src/nested/deep_main.go" {
		t.Fatalf("搜路径片段 = %v", paths)
	}
	// 目录本身也是候选（点一下可以在树里打开它）。
	if paths := searchPaths(t, r, "nested", false, 0); len(paths) == 0 || paths[0] != "src/nested" {
		t.Fatalf("目录命中应排在文件前: %v", paths)
	}
}

func TestSearchSkipsExcludedHiddenAndSymlinks(t *testing.T) {
	root := seedCompleteRoot(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "needle.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Skipf("symlink: %v", err)
	}

	r, err := OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	// node_modules / dist / .env 默认都不参与；软链不跟随。
	for _, path := range searchPaths(t, r, "pkg", false, 0) {
		if path != "" {
			t.Fatalf("node_modules 不该出现在结果里: %v", path)
		}
	}
	if paths := searchPaths(t, r, "bundle", false, 0); len(paths) != 0 {
		t.Fatalf("dist 不该出现在结果里: %v", paths)
	}
	if paths := searchPaths(t, r, "needle", false, 0); len(paths) != 0 {
		t.Fatalf("软链指向的外部文件不该出现: %v", paths)
	}

	// 打开「显示隐藏文件」后 .env 可以搜到（.git / 依赖目录仍然跳过）。
	if paths := searchPaths(t, r, "env", true, 0); len(paths) != 1 || paths[0] != ".env" {
		t.Fatalf("显示隐藏文件后 = %v", paths)
	}
}

func TestSearchTruncatesAndRanks(t *testing.T) {
	root := t.TempDir()
	for _, dir := range []string{"a", "b", "c"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// 同名文件放在不同目录：结果按路径短的优先。
	for _, name := range []string{"a/hit.txt", "b/hit.txt", "c/deep/hit.txt", "c/other.txt"} {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(root, name)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	r, err := OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}

	paths := searchPaths(t, r, "hit", false, 2)
	if len(paths) != 2 || paths[0] != "a/hit.txt" || paths[1] != "b/hit.txt" {
		t.Fatalf("limit+排序 = %v", paths)
	}
	listing, err := r.Search(context.Background(), "hit", false, 2)
	if err != nil {
		t.Fatal(err)
	}
	if !listing.Truncated {
		t.Fatalf("超过 limit 应标记 truncated")
	}
}

func TestSearchEmptyQueryAndCancel(t *testing.T) {
	r, err := OpenRoot(seedCompleteRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	listing, err := r.Search(context.Background(), "   ", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(listing.Entries) != 0 || listing.Entries == nil {
		t.Fatalf("空查询应返回空数组而不是 nil: %+v", listing.Entries)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	listing, err = r.Search(ctx, "main", false, 0)
	if err != nil {
		t.Fatalf("取消的搜索不该报错: %v", err)
	}
	if len(listing.Entries) != 0 || !listing.Truncated {
		t.Fatalf("取消后应立刻停下并标记截断: %+v", listing)
	}
}
