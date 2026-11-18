package fsapi

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"testing"
)

func TestOpenDownloadRejectsDirectoryAndSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "a.bin"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.bin"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Skipf("当前环境不支持符号链接: %v", err)
	}
	r, err := OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}

	f, info, rel, err := r.OpenDownload("a.bin")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(f)
	_ = f.Close()
	if rel != "a.bin" || info.Size() != 5 || string(data) != "hello" {
		t.Fatalf("下载内容不对: rel=%q size=%d data=%q", rel, info.Size(), data)
	}

	if _, _, _, err := r.OpenDownload("dir"); !errors.Is(err, ErrNotRegular) {
		t.Fatalf("目录不该被当成文件下载: %v", err)
	}
	if _, _, _, err := r.OpenDownload("link/secret.bin"); !errors.Is(err, ErrOutside) {
		t.Fatalf("符号链接逃逸应拒绝: %v", err)
	}
}

func TestZipPacksDirectoryWithoutSymlinksOrGit(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src", "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "a.txt"), []byte("a"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "nested", "b.txt"), []byte("b"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "src", ".git", "objects"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", ".git", "objects", "x"), []byte("obj"), 0o600); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "src", "link")); err != nil {
		t.Skipf("当前环境不支持符号链接: %v", err)
	}

	r, err := OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	name, err := r.Zip(context.Background(), "src", &buf)
	if err != nil {
		t.Fatal(err)
	}
	if name != "src.zip" {
		t.Fatalf("archive name = %q", name)
	}
	reader, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, f := range reader.File {
		names = append(names, f.Name)
	}
	sort.Strings(names)
	want := []string{"src/", "src/a.txt", "src/nested/", "src/nested/b.txt"}
	if len(names) != len(want) {
		t.Fatalf("entries = %v", names)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("entries = %v, 期望 %v", names, want)
		}
	}
}

func TestZipRequiresDirectoryAndStaysInside(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("a"), 0o600); err != nil {
		t.Fatal(err)
	}
	r, err := OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if _, err := r.Zip(context.Background(), "a.txt", &buf); !errors.Is(err, ErrNotDirectory) {
		t.Fatalf("文件不该被打包: %v", err)
	}
	if _, err := r.Zip(context.Background(), "../", &buf); !errors.Is(err, ErrOutside) {
		t.Fatalf("越界目录应拒绝: %v", err)
	}
}

// 条目数超预算：必须在**写出任何字节之前**失败，否则调用方只能给出一个 200 + 半个 zip。
func TestZipRejectsTooManyEntriesBeforeWriting(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "many")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for i := 0; i <= MaxArchiveEntries; i++ {
		if err := os.WriteFile(filepath.Join(dir, "f"+strconv.Itoa(i)), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	r, err := OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if _, err := r.Zip(context.Background(), "many", &buf); !errors.Is(err, ErrArchiveTooLarge) {
		t.Fatalf("超条目预算应返回 ErrArchiveTooLarge，得到 %v", err)
	}
	if buf.Len() != 0 {
		t.Fatalf("超预算时不该写出任何字节，实际写了 %d", buf.Len())
	}
}

// 字节预算：单个大文件同样要挡住（早先是「整份复制完再判」，等于没挡）。
func TestZipRejectsTooManyBytesBeforeWriting(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "big")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// 稀疏文件：内容不重要，只要 Size 超预算，且不真的占 2 GiB 磁盘。
	f, err := os.Create(filepath.Join(dir, "huge.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(MaxArchiveBytes + 1); err != nil {
		_ = f.Close()
		t.Skipf("当前环境不支持稀疏文件: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	r, err := OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if _, err := r.Zip(context.Background(), "big", &buf); !errors.Is(err, ErrArchiveTooLarge) {
		t.Fatalf("超字节预算应返回 ErrArchiveTooLarge，得到 %v", err)
	}
	if buf.Len() != 0 {
		t.Fatalf("超预算时不该写出任何字节，实际写了 %d", buf.Len())
	}
}

// 直接打包 `.git` 不能得到一个空包：跳过规则只对子树生效。
func TestZipGitRootStillPacks(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".git", "objects"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".git", "HEAD"), []byte("ref: x"), 0o600); err != nil {
		t.Fatal(err)
	}
	r, err := OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if _, err := r.Zip(context.Background(), ".git", &buf); err != nil {
		t.Fatal(err)
	}
	reader, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, f := range reader.File {
		if f.Name == ".git/HEAD" {
			found = true
		}
	}
	if !found {
		t.Fatalf("打包 .git 时应当带上它的文件，实际条目: %v", reader.File)
	}
}
