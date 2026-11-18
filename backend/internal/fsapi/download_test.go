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
