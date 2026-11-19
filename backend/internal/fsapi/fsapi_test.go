package fsapi

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	r, err := OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"../x", "a/../../x", "/etc/passwd", "a\\..\\..\\x"} {
		if _, _, _, err := r.Resolve(rel); !errors.Is(err, ErrOutside) {
			t.Fatalf("Resolve(%q) err = %v, 期望 ErrOutside", rel, err)
		}
	}
}

func TestResolveRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Skipf("当前环境不支持符号链接: %v", err)
	}
	r, err := OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := r.Resolve("link/secret.txt"); !errors.Is(err, ErrOutside) {
		t.Fatalf("符号链接逃逸应拒绝，err = %v", err)
	}
	// 目录树里仍要能看到这一行，但不能标记成可进入的目录。
	listing, err := r.List("", false, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(listing.Entries) != 1 || listing.Entries[0].Type != "other" {
		t.Fatalf("entries = %+v", listing.Entries)
	}
}

func TestListSortsDirsFirstAndHidesDotfiles(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"b.txt", "A.txt", "sub", ".hidden"} {
		path := filepath.Join(root, name)
		if name == "sub" {
			if err := os.Mkdir(path, 0o755); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.WriteFile(path, []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	r, err := OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	listing, err := r.List("", false, 10)
	if err != nil {
		t.Fatal(err)
	}
	got := make([]string, 0, len(listing.Entries))
	for _, e := range listing.Entries {
		got = append(got, e.Type+":"+e.Name)
	}
	want := []string{"dir:sub", "file:A.txt", "file:b.txt"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("entries = %v, want %v", got, want)
	}

	// 打开「显示隐藏文件」后，.git 也要出现：仓库就在工作区里，看不见只会让人以为
	// 面板读的不是这个目录。
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	listing, err = r.List("", true, 10)
	if err != nil {
		t.Fatal(err)
	}
	got = got[:0]
	for _, e := range listing.Entries {
		got = append(got, e.Type+":"+e.Name)
	}
	want = []string{"dir:.git", "dir:sub", "file:.hidden", "file:A.txt", "file:b.txt"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("hidden entries = %v, want %v", got, want)
	}
}

func TestListTruncates(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 5; i++ {
		if err := os.WriteFile(filepath.Join(root, string(rune('a'+i))+".txt"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	r, _ := OpenRoot(root)
	listing, err := r.List("", false, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(listing.Entries) != 2 || !listing.Truncated {
		t.Fatalf("entries=%d truncated=%v", len(listing.Entries), listing.Truncated)
	}
}

func TestReadPreservesSpaceInName(t *testing.T) {
	root := t.TempDir()
	name := " leading and trailing .txt "
	if err := os.WriteFile(filepath.Join(root, name), []byte("space"), 0o600); err != nil {
		t.Fatal(err)
	}
	r, _ := OpenRoot(root)
	file, err := r.Read(name, 1024)
	if err != nil {
		t.Fatalf("Read(%q): %v", name, err)
	}
	if file.Content != "space" {
		t.Fatalf("content = %q", file.Content)
	}
}

func TestReadBinaryAndTruncated(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "bin.dat"), []byte{0x00, 0x01, 0x02}, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "text.txt"), []byte("你好世界"), 0o600); err != nil {
		t.Fatal(err)
	}
	r, _ := OpenRoot(root)

	bin, err := r.Read("bin.dat", 1024)
	if err != nil {
		t.Fatal(err)
	}
	if !bin.Binary || bin.Content != "" {
		t.Fatalf("binary = %+v", bin)
	}

	text, err := r.Read("text.txt", 1024)
	if err != nil {
		t.Fatal(err)
	}
	if text.Binary || text.Content != "你好世界" {
		t.Fatalf("text = %+v", text)
	}

	// 截断到 4 字节会把「世」切开：必须回退到完整字符。
	cut, err := r.Read("text.txt", 4)
	if err != nil {
		t.Fatal(err)
	}
	if !cut.Truncated || cut.Binary || cut.Content != "你" {
		t.Fatalf("cut = %+v", cut)
	}
}

func TestOpenRawRejectsLargeAndNonRegular(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "big.bin"), make([]byte, MaxRawBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}
	r, _ := OpenRoot(root)
	if _, _, _, err := r.OpenRaw("big.bin"); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, 期望 ErrTooLarge", err)
	}
	if _, _, _, err := r.OpenRaw("."); !errors.Is(err, ErrNotRegular) {
		t.Fatalf("目录应返回 ErrNotRegular，err = %v", err)
	}
}
