package project

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListSkipsHiddenAndFiles(t *testing.T) {
	root := t.TempDir()
	for _, d := range []string{"alpha", "beta"} {
		if err := os.Mkdir(filepath.Join(root, d), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
	}
	// 隐藏目录与普通文件都不应出现在列表里
	_ = os.Mkdir(filepath.Join(root, ".hidden"), 0o755)
	_ = os.WriteFile(filepath.Join(root, "note.txt"), []byte("x"), 0o644)
	// beta 带 .git
	_ = os.Mkdir(filepath.Join(root, "beta", ".git"), 0o755)

	got, err := List(root, 0)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("条数 = %d, want 2: %v", len(got), got)
	}
	if got[0].Name != "alpha" || got[1].Name != "beta" {
		t.Fatalf("应按名称排序: %v", got)
	}
	if got[0].HasGit {
		t.Fatal("alpha 不应有 .git")
	}
	if !got[1].HasGit {
		t.Fatal("beta 应识别到 .git")
	}
}

func TestListRespectsLimit(t *testing.T) {
	root := t.TempDir()
	for _, d := range []string{"a", "b", "c"} {
		_ = os.Mkdir(filepath.Join(root, d), 0o755)
	}
	got, err := List(root, 2)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("条数 = %d, want 2", len(got))
	}
}

func TestValidateAccepteDirectory(t *testing.T) {
	dir := t.TempDir()
	abs, err := Validate(dir)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if abs != dir {
		t.Fatalf("abs = %q, want %q", abs, dir)
	}
}

func TestValidateRejects(t *testing.T) {
	file := filepath.Join(t.TempDir(), "f")
	_ = os.WriteFile(file, []byte("x"), 0o644)

	if _, err := Validate(file); err == nil {
		t.Fatal("普通文件应被拒绝")
	}
	if _, err := Validate(""); err == nil {
		t.Fatal("空路径应被拒绝")
	}
	if _, err := Validate("/definitely/not/here"); err == nil {
		t.Fatal("不存在的路径应被拒绝")
	}
}

func TestBrowseSkipsFilesAndHidden(t *testing.T) {
	root := t.TempDir()
	for _, d := range []string{"alpha", "beta", ".hidden"} {
		if err := os.Mkdir(filepath.Join(root, d), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
	}
	_ = os.WriteFile(filepath.Join(root, "note.txt"), []byte("x"), 0o644)

	got, err := Browse(root, false, 0)
	if err != nil {
		t.Fatalf("Browse: %v", err)
	}
	if got.Path != root || got.Parent != filepath.Dir(root) {
		t.Fatalf("browse = %+v", got)
	}
	if len(got.Entries) != 2 || got.Entries[0].Name != "alpha" || got.Entries[1].Name != "beta" {
		t.Fatalf("entries = %+v", got.Entries)
	}

	got, err = Browse(root, true, 0)
	if err != nil {
		t.Fatalf("Browse hidden: %v", err)
	}
	if len(got.Entries) != 3 || got.Entries[0].Name != ".hidden" {
		t.Fatalf("hidden entries = %+v", got.Entries)
	}
}

func TestMkdirCreatesSingleLevel(t *testing.T) {
	root := t.TempDir()
	got, err := Mkdir(root, "新目录 ")
	if err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	if got != filepath.Join(root, "新目录") {
		t.Fatalf("path = %q", got)
	}
	if st, err := os.Stat(got); err != nil || !st.IsDir() {
		t.Fatalf("目录未创建: %v", err)
	}
}

func TestMkdirRejectsBadNames(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"", "   ", ".", "..", "a/b", `a\b`} {
		if _, err := Mkdir(root, name); err == nil {
			t.Fatalf("名字 %q 应被拒绝", name)
		}
	}
	if _, err := Mkdir(filepath.Join(root, "nope"), "x"); err == nil {
		t.Fatal("父目录不存在应报错")
	}
	// 同名目录不能再建一次
	if _, err := Mkdir(root, "dup"); err != nil {
		t.Fatalf("首次 Mkdir: %v", err)
	}
	if _, err := Mkdir(root, "dup"); err == nil {
		t.Fatal("同名目录应报错")
	}
}

func TestCheckWritable(t *testing.T) {
	dir := t.TempDir()
	if err := CheckWritable(dir); err != nil {
		t.Fatalf("可写目录应返回 nil: %v", err)
	}
	// 探测是「真写一次」，必须自己收尾，不能在用户目录里留垃圾。
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("探测文件未清理: %v", entries)
	}

	// root 无视权限位，只读断言在那种环境下没有意义。
	if os.Geteuid() != 0 {
		ro := filepath.Join(dir, "ro")
		if err := os.Mkdir(ro, 0o555); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := CheckWritable(ro); err == nil {
			t.Fatal("只读目录应报不可写")
		}
	}

	if err := CheckWritable(filepath.Join(dir, "missing")); err == nil {
		t.Fatal("不存在的目录应报错")
	}
	file := filepath.Join(dir, "file.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := CheckWritable(file); err == nil {
		t.Fatal("普通文件应报错")
	}
}
