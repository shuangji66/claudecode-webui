package fsapi

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// seedCompleteRoot 造一棵小工作区：两层源码 + 依赖/构建目录 + 隐藏文件。
func seedCompleteRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	dirs := []string{"src", "src/nested", "docs", "node_modules/pkg", "dist"}
	for _, dir := range dirs {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		"README.md":               "# hi",
		"src/main.go":             "package main",
		"src/compare.ts":          "export {}",
		"src/nested/deep_main.go": "package nested",
		"docs/guide.md":           "guide",
		"node_modules/pkg/x.js":   "module.exports = {}",
		"dist/bundle.js":          "bundle",
		".env":                    "SECRET=1",
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func completePaths(t *testing.T, r *Root, query string, limit int) []string {
	t.Helper()
	listing, err := r.Complete(context.Background(), query, limit)
	if err != nil {
		t.Fatalf("Complete(%q) 失败: %v", query, err)
	}
	out := make([]string, 0, len(listing.Entries))
	for _, entry := range listing.Entries {
		out = append(out, entry.Path)
	}
	return out
}

func TestCompleteInDirFiltersAndSorts(t *testing.T) {
	r, err := OpenRoot(seedCompleteRoot(t))
	if err != nil {
		t.Fatal(err)
	}

	// 目录模式：`src/ma` 只列 src 这一层，前缀命中的排前面。
	paths := completePaths(t, r, "src/ma", 20)
	if len(paths) == 0 || paths[0] != "src/main.go" {
		t.Fatalf("src/ma 的候选 = %v，期望首条 src/main.go", paths)
	}
	for _, path := range paths {
		if path != "src/main.go" && path != "src/compare.ts" {
			t.Fatalf("src/ma 混进了别的目录: %v", paths)
		}
	}

	// 空查询列根目录：目录在前，文件在后。
	paths = completePaths(t, r, "", 20)
	if len(paths) < 3 || paths[0] != "docs" || paths[1] != "src" {
		t.Fatalf("根目录候选 = %v，期望目录优先", paths)
	}
}

func TestCompleteWorkspaceFuzzyRanksByName(t *testing.T) {
	r, err := OpenRoot(seedCompleteRoot(t))
	if err != nil {
		t.Fatal(err)
	}

	paths := completePaths(t, r, "main", 20)
	if len(paths) == 0 || paths[0] != "src/main.go" {
		t.Fatalf("main 的候选 = %v，期望首条 src/main.go", paths)
	}

	// 只出现在路径里的片段也要能命中（src/nested）。
	paths = completePaths(t, r, "nested", 20)
	if len(paths) == 0 || paths[0] != "src/nested" {
		t.Fatalf("nested 的候选 = %v，期望首条 src/nested", paths)
	}
}

func TestCompleteSkipsExcludedDirs(t *testing.T) {
	r, err := OpenRoot(seedCompleteRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"x", "bundle", "node_modules", "pkg"} {
		if paths := completePaths(t, r, query, 20); len(paths) != 0 {
			t.Fatalf("%q 不该给出依赖/构建目录里的候选: %v", query, paths)
		}
	}
	// 目录模式同样不列。
	if paths := completePaths(t, r, "node_modules/", 20); len(paths) != 0 {
		t.Fatalf("node_modules/ 不该列内容: %v", paths)
	}
}

func TestCompleteNeverEscapesWorkspace(t *testing.T) {
	root := seedCompleteRoot(t)
	r, err := OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"../", "../../etc", "src/../../etc", "/etc/pas"} {
		for _, path := range completePaths(t, r, query, 20) {
			if filepath.IsAbs(filepath.FromSlash(path)) || len(path) > 2 && path[:2] == ".." {
				t.Fatalf("Complete(%q) 越界: %v", query, path)
			}
		}
	}
}

func TestCompleteHidesDotfilesUnlessQueried(t *testing.T) {
	r, err := OpenRoot(seedCompleteRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range completePaths(t, r, "", 50) {
		if path == ".env" {
			t.Fatal("空查询不该列出隐藏文件")
		}
	}
	if paths := completePaths(t, r, ".en", 20); len(paths) != 1 || paths[0] != ".env" {
		t.Fatalf(".en 的候选 = %v，期望 .env", paths)
	}
}

func TestCompleteRespectsLimit(t *testing.T) {
	r, err := OpenRoot(seedCompleteRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	if paths := completePaths(t, r, "", 2); len(paths) != 2 {
		t.Fatalf("limit=2 时返回 %d 条", len(paths))
	}
	// 越界/非法 limit 回落到默认值，而不是 0 条。
	if paths := completePaths(t, r, "", -5); len(paths) == 0 {
		t.Fatal("非法 limit 应回落到默认值")
	}
}

func TestCompleteSkipsSymlinks(t *testing.T) {
	root := seedCompleteRoot(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret-main.go"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "linkdir")); err != nil {
		t.Skipf("当前环境不支持符号链接: %v", err)
	}
	r, err := OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range completePaths(t, r, "secret", 20) {
		if path == "linkdir/secret-main.go" || path == "linkdir" {
			t.Fatalf("符号链接不该进入候选: %v", path)
		}
	}
}

// 目录里条目多于 List 的截断上限时，过滤必须发生在截断之前：否则排在后面的文件
// 永远补不出来（工作区模式的模糊搜索能搜到同一个文件，两种视图就对不上了）。
func TestCompleteInDirFiltersBeforeTruncation(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "many")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < DefaultEntries+20; i++ {
		name := filepath.Join(dir, "a"+strconv.Itoa(i)+".txt")
		if err := os.WriteFile(name, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// 名字排在最后（a… 之后）的目标文件。
	if err := os.WriteFile(filepath.Join(dir, "zebra.go"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	r, err := OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	paths := completePaths(t, r, "many/zeb", 20)
	if len(paths) != 1 || paths[0] != "many/zebra.go" {
		t.Fatalf("大目录里末尾文件的补全 = %v，期望 many/zebra.go", paths)
	}
}

// 空结果的 Path 也要规整：`a//` 与 `a/` 都该是 `a`，前端拿它当面包屑。
func TestCompleteCleansEmptyPath(t *testing.T) {
	r, err := OpenRoot(seedCompleteRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"src//nope", "src/nope/"} {
		listing, err := r.Complete(context.Background(), query, 20)
		if err != nil {
			t.Fatalf("Complete(%q) 失败: %v", query, err)
		}
		if strings.HasSuffix(listing.Path, "/") {
			t.Fatalf("Complete(%q) 的 Path = %q，不该以 / 结尾", query, listing.Path)
		}
	}
}

func TestCompleteNeverReturnsNilEntries(t *testing.T) {
	r, err := OpenRoot(seedCompleteRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	// 目录不存在、越界、以及有命中这三种情况，Entries 都必须是空数组而不是 nil：
	// nil 在 JSON 里是 null，前端 `entries.filter` 会直接抛 TypeError。
	for _, query := range []string{"nope/deeper/", "../../etc", "README"} {
		listing, err := r.Complete(context.Background(), query, 20)
		if err != nil {
			t.Fatalf("Complete(%q) 失败: %v", query, err)
		}
		if listing.Entries == nil {
			t.Fatalf("Complete(%q) 的 Entries 是 nil", query)
		}
	}
}
