package workspace

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenSeedsDefaultDirectoryOnce(t *testing.T) {
	dir := t.TempDir()
	seed := filepath.Join(dir, "projects")
	if err := os.Mkdir(seed, 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "workspaces.json")

	s, err := Open(file, seed)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	items := s.List()
	if len(items) != 1 || items[0].Path != seed {
		t.Fatalf("List = %+v", items)
	}
	if !items[0].Exists {
		t.Fatal("种子目录应存在")
	}
	if s.Current() != seed {
		t.Fatalf("Current = %q", s.Current())
	}

	// 删掉后重开：文件已存在，不能把用户显式删除的目录又补回来。
	if err := s.Remove(seed); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	s2, err := Open(file, seed)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if got := s2.List(); len(got) != 0 {
		t.Fatalf("重开后不应重新种子: %+v", got)
	}
	if s2.Current() != "" {
		t.Fatalf("Current = %q", s2.Current())
	}
}

func TestAddSetCurrentRemove(t *testing.T) {
	root := t.TempDir()
	a := filepath.Join(root, "a")
	b := filepath.Join(root, "b")
	for _, p := range []string{a, b} {
		if err := os.Mkdir(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	file := filepath.Join(root, "ws.json")
	s, err := Open(file, "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	e, err := s.Add(a)
	if err != nil {
		t.Fatalf("Add(a): %v", err)
	}
	if e.Path != a || e.Name != "a" || !e.Exists {
		t.Fatalf("entry = %+v", e)
	}
	if s.Current() != a {
		t.Fatalf("Current = %q", s.Current())
	}

	if _, err := s.Add(b); err != nil {
		t.Fatalf("Add(b): %v", err)
	}
	if err := s.SetCurrent(a); err != nil {
		t.Fatalf("SetCurrent: %v", err)
	}
	if s.Current() != a {
		t.Fatalf("Current = %q", s.Current())
	}

	if err := s.Remove(a); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if s.Current() != b {
		t.Fatalf("移除当前目录后应切到剩余目录，Current = %q", s.Current())
	}
	if err := s.Remove(a); err != ErrNotFound {
		t.Fatalf("重复移除 err = %v", err)
	}

	// 路径持久化后仍可读。
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var f storedFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Workspaces) != 1 || f.Workspaces[0].Path != b || f.Current != b {
		t.Fatalf("stored = %+v", f)
	}
}

func TestAddRejectsMissingAndRoot(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "ws.json"), "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Add(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Fatal("不存在的目录应报错")
	}
	if _, err := s.Add("/"); err == nil {
		t.Fatal("根目录不应被授权")
	}
}

func TestAllowsDirectoryAndChildrenOnly(t *testing.T) {
	root := t.TempDir()
	allowed := filepath.Join(root, "allowed")
	other := filepath.Join(root, "other")
	for _, p := range []string{allowed, other, filepath.Join(allowed, "sub")} {
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	s, err := Open(filepath.Join(root, "ws.json"), allowed)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		path string
		want bool
	}{
		{allowed, true},
		{filepath.Join(allowed, "sub"), true},
		{other, false},
		{filepath.Join(root, "allowedx"), false},
		{"relative/path", false},
	}
	for _, c := range cases {
		if got := s.Allows(c.path); got != c.want {
			t.Fatalf("Allows(%q) = %v, want %v", c.path, got, c.want)
		}
	}
}

func TestTouchUpdatesCurrentAndLastUsed(t *testing.T) {
	root := t.TempDir()
	a := filepath.Join(root, "a")
	b := filepath.Join(root, "b")
	for _, p := range []string{a, b} {
		if err := os.Mkdir(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	s, err := Open(filepath.Join(root, "ws.json"), a)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Add(b); err != nil {
		t.Fatal(err)
	}
	if s.Current() != b {
		t.Fatalf("Current = %q", s.Current())
	}
	s.Touch(a)
	if s.Current() != a {
		t.Fatalf("Touch 后 Current = %q", s.Current())
	}
}

func TestMissingDirectoryKeptButMarked(t *testing.T) {
	root := t.TempDir()
	a := filepath.Join(root, "a")
	if err := os.Mkdir(a, 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "ws.json")
	s, err := Open(file, a)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(a); err != nil {
		t.Fatal(err)
	}
	items := s.List()
	if len(items) != 1 || items[0].Exists {
		t.Fatalf("List = %+v", items)
	}
}

func TestTouchPrefersLongestWorkspace(t *testing.T) {
	root := t.TempDir()
	parent := filepath.Join(root, "work")
	child := filepath.Join(parent, "proj")
	if err := os.MkdirAll(child, 0o755); err != nil {
		t.Fatal(err)
	}
	s, err := Open(filepath.Join(root, "ws.json"), parent)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Add(child); err != nil {
		t.Fatal(err)
	}
	if s.Current() != child {
		t.Fatalf("Add 后 Current = %q", s.Current())
	}
	s.Touch(child)
	if s.Current() != child {
		t.Fatalf("Touch 子目录后 Current = %q, want %q", s.Current(), child)
	}
}

func TestAutoStartPathFallsBackToExisting(t *testing.T) {
	root := t.TempDir()
	parent := filepath.Join(root, "work")
	child := filepath.Join(parent, "proj")
	if err := os.MkdirAll(child, 0o755); err != nil {
		t.Fatal(err)
	}
	s, err := Open(filepath.Join(root, "ws.json"), parent)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Add(child); err != nil {
		t.Fatal(err)
	}
	if got := s.AutoStartPath(); got != child {
		t.Fatalf("AutoStartPath = %q, want %q", got, child)
	}
	if err := os.Remove(child); err != nil {
		t.Fatal(err)
	}
	if got := s.AutoStartPath(); got != parent {
		t.Fatalf("当前目录消失后应退回父目录，实际 %q", got)
	}
}

func TestRenameOnlyChangesDisplayName(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "proj")
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatal(err)
	}
	s, err := Open(filepath.Join(dir, "workspaces.json"), path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	entry, err := s.Rename(path, "  我的项目  ")
	if err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if entry.Name != "我的项目" || entry.Path != path {
		t.Fatalf("entry = %+v", entry)
	}
	// 磁盘上的目录名不变
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("原目录不应被移动: %v", err)
	}

	// 重新打开仍然是新名字（已落盘）
	reopened, err := Open(filepath.Join(dir, "workspaces.json"), path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if items := reopened.List(); len(items) != 1 || items[0].Name != "我的项目" {
		t.Fatalf("reopen list = %+v", items)
	}

	// 空名字回落成目录名
	if entry, err = reopened.Rename(path, "   "); err != nil {
		t.Fatalf("Rename empty: %v", err)
	}
	if entry.Name != "proj" {
		t.Fatalf("空名字应回落为目录名，得到 %q", entry.Name)
	}

	if _, err := reopened.Rename(filepath.Join(dir, "other"), "x"); err == nil {
		t.Fatal("不在列表里的目录应返回 ErrNotFound")
	}
}

// 授权项本身可能是软链（/data/ws -> /vol1/ws），而网关传进来的是解析后的真实路径。
// 只比字符串会把这种合法情形判成越界，所以两边都要按真实路径比。
func TestAllowsResolvesSymlinkedWorkspace(t *testing.T) {
	base := t.TempDir()
	real := filepath.Join(base, "real")
	if err := os.MkdirAll(filepath.Join(real, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("无法创建符号链接: %v", err)
	}
	s, err := Open(filepath.Join(base, "ws.json"), link)
	if err != nil {
		t.Fatal(err)
	}
	if !s.Allows(filepath.Join(real, "sub")) {
		t.Fatal("软链工作区的真实路径子目录应被允许")
	}
	if s.Allows(filepath.Join(base, "other")) {
		t.Fatal("工作区外目录不应被允许")
	}
}

func TestContainingPicksDeepestWorkspace(t *testing.T) {
	root := t.TempDir()
	parent := filepath.Join(root, "work")
	child := filepath.Join(parent, "proj")
	deep := filepath.Join(child, "src")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	s, err := Open(filepath.Join(root, "ws.json"), parent)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Add(child); err != nil {
		t.Fatal(err)
	}

	cases := []struct{ path, want string }{
		{parent, parent},
		{child, child},
		{deep, child}, // 嵌套工作区取最内层
		{filepath.Join(root, "other"), ""},
		{"relative/path", ""},
	}
	for _, c := range cases {
		if got := s.Containing(c.path); got != c.want {
			t.Fatalf("Containing(%q) = %q, want %q", c.path, got, c.want)
		}
	}
}

func TestContainingResolvesSymlinkedWorkspace(t *testing.T) {
	root := t.TempDir()
	real := filepath.Join(root, "real")
	if err := os.MkdirAll(filepath.Join(real, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlink: %v", err)
	}
	s, err := Open(filepath.Join(root, "ws.json"), link)
	if err != nil {
		t.Fatal(err)
	}
	// cwd 是网关解析符号链接后的真实路径，必须能匹配到以软链登记的工作区。
	if got := s.Containing(filepath.Join(real, "sub")); got != real {
		t.Fatalf("Containing(真实子目录) = %q, want %q", got, real)
	}
}
