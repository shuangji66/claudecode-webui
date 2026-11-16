package claudebin

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// writeFakeVersion 在版本目录里手工放一个已安装版本，模拟升级前的老数据。
func writeFakeVersion(t *testing.T, versionsDir, version string) {
	t.Helper()
	dir := filepath.Join(versionsDir, version)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建版本目录: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "claude"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("写二进制: %v", err)
	}
}

func TestBinPathWithoutInstall(t *testing.T) {
	m, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, err := m.BinPath(); !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("BinPath 应返回 ErrNotInstalled，实际 %v", err)
	}
	st := m.Status()
	if st.Installed == nil {
		t.Fatal("Installed 不能是 nil：前端会直接 .map")
	}
	if st.Active != "" {
		t.Fatalf("空目录不应有生效版本，实际 %q", st.Active)
	}
}

func TestOpenPicksHighestInstalledVersion(t *testing.T) {
	dir := t.TempDir()
	writeFakeVersion(t, dir, "2.1.100")
	writeFakeVersion(t, dir, "2.1.325")

	m, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if got := m.Active(); got != "2.1.325" {
		t.Fatalf("生效版本应为最高的 2.1.325，实际 %q", got)
	}
	p, err := m.BinPath()
	if err != nil {
		t.Fatalf("BinPath: %v", err)
	}
	if want := filepath.Join(dir, "2.1.325", "claude"); p != want {
		t.Fatalf("BinPath=%q，期望 %q", p, want)
	}
}

func TestSetActivePersistsAndValidates(t *testing.T) {
	dir := t.TempDir()
	writeFakeVersion(t, dir, "2.1.100")
	writeFakeVersion(t, dir, "2.1.325")

	m, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := m.SetActive("v2.1.100"); err != nil {
		t.Fatalf("SetActive: %v", err)
	}
	if err := m.SetActive("9.9.9"); err == nil {
		t.Fatal("未安装的版本应被拒绝")
	}
	// 重启后仍然生效：切换结果必须落盘。
	m2, err := Open(dir)
	if err != nil {
		t.Fatalf("重新 Open: %v", err)
	}
	if got := m2.Active(); got != "2.1.100" {
		t.Fatalf("重启后生效版本应为 2.1.100，实际 %q", got)
	}
}

func TestSetSourcePersists(t *testing.T) {
	dir := t.TempDir()
	m, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := m.SetSource(SourceOfficial); err != nil {
		t.Fatalf("SetSource: %v", err)
	}
	if err := m.SetSource("taobao"); err == nil {
		t.Fatal("未知源应被拒绝")
	}
	m2, err := Open(dir)
	if err != nil {
		t.Fatalf("重新 Open: %v", err)
	}
	if got := m2.Status().Source; got != SourceOfficial {
		t.Fatalf("重启后源应为 %s，实际 %s", SourceOfficial, got)
	}
}

func TestStartInstallRejectsBadVersion(t *testing.T) {
	m, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	for _, v := range []string{"../etc/passwd", "2.1", ""} {
		if err := m.StartInstall(v, ""); err == nil {
			t.Fatalf("版本号 %q 应被拒绝", v)
		}
	}
}

func TestDeleteInactiveVersion(t *testing.T) {
	dir := t.TempDir()
	writeFakeVersion(t, dir, "2.1.325")
	writeFakeVersion(t, dir, "2.1.324")
	m, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if got := m.Active(); got != "2.1.325" {
		t.Fatalf("初始生效版本 = %q", got)
	}

	if err := m.Delete("2.1.324"); err != nil {
		t.Fatalf("删除未使用版本: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "2.1.324")); !os.IsNotExist(err) {
		t.Fatalf("版本目录应已删除: %v", err)
	}
	if err := m.Delete("2.1.325"); !errors.Is(err, ErrActive) {
		t.Fatalf("生效版本应拒绝删除，实际 %v", err)
	}
	if err := m.Delete("9.9.9"); err == nil {
		t.Fatal("未安装版本应报错")
	}
	if err := m.Delete("../2.1.324"); err == nil {
		t.Fatal("路径穿越应被拒绝")
	}
}
