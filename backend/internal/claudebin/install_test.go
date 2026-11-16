package claudebin

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// fakeTgz 造一个只有一个可执行条目的平台包；条目内容是回显版本号的脚本，
// 这样 verifyBinary 会真的把它跑起来，覆盖"装完不能运行"的失败路径。
func fakeTgz(t *testing.T, version string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	script := []byte("#!/bin/sh\necho \"" + version + " (Claude Code)\"\n")
	hdr := &tar.Header{Name: "package/claude", Mode: 0o755, Size: int64(len(script)), Typeflag: tar.TypeReg}
	if err := tw.WriteHeader(hdr); err != nil {
		t.Fatalf("写 tar 头: %v", err)
	}
	if _, err := tw.Write(script); err != nil {
		t.Fatalf("写 tar 内容: %v", err)
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("关闭 tar: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("关闭 gzip: %v", err)
	}
	return buf.Bytes()
}

func integrityOf(b []byte) string {
	sum := sha512.Sum512(b)
	return "sha512-" + base64.StdEncoding.EncodeToString(sum[:])
}

// fakeRegistry 起一个最小 npm registry：单版本 manifest + 平台包 + packument。
func fakeRegistry(t *testing.T, version string, tgz []byte, integrity string) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	mux := http.NewServeMux()
	mux.HandleFunc("/@anthropic-ai/claude-code-linux-x64/"+version, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"name":    "@anthropic-ai/claude-code-linux-x64",
			"version": version,
			"dist": map[string]any{
				"tarball":   srv.URL + "/pkg.tgz",
				"integrity": integrity,
				"size":      len(tgz),
			},
		})
	})
	mux.HandleFunc("/pkg.tgz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(tgz)))
		_, _ = w.Write(tgz)
	})
	mux.HandleFunc("/@anthropic-ai/claude-code", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"dist-tags": map[string]string{"latest": version, "stable": "2.1.311"},
			"versions": map[string]any{
				"2.1.311": map[string]any{},
				version:   map[string]any{},
			},
		})
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func waitJob(t *testing.T, m *Manager) *Job {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if st := m.Status(); st.Job != nil && isFinal(st.Job.Phase) {
			return st.Job
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("安装任务超时未结束")
	return nil
}

func TestInstallFromRegistry(t *testing.T) {
	const version = "2.1.325"
	tgz := fakeTgz(t, version)
	srv := fakeRegistry(t, version, tgz, integrityOf(tgz))

	dir := t.TempDir()
	m, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	m.platform = "linux-x64"
	m.registries[SourceNpmmirror] = srv.URL

	if err := m.StartInstall(version, ""); err != nil {
		t.Fatalf("StartInstall: %v", err)
	}
	job := waitJob(t, m)
	if job.Phase != PhaseDone {
		t.Fatalf("安装失败: phase=%s err=%s", job.Phase, job.Error)
	}
	if job.Downloaded != int64(len(tgz)) {
		t.Fatalf("已下载字节数 %d，期望 %d", job.Downloaded, len(tgz))
	}

	bin := filepath.Join(dir, version, "claude")
	if st, err := os.Stat(bin); err != nil || st.Mode()&0o111 == 0 {
		t.Fatalf("二进制未落盘或不可执行: %v", err)
	}
	if got := m.Active(); got != version {
		t.Fatalf("安装后应自动生效，实际生效版本 %q", got)
	}
	if p, err := m.BinPath(); err != nil || p != bin {
		t.Fatalf("BinPath=%q err=%v，期望 %q", p, err, bin)
	}
	// 临时目录必须清干净，否则每次升级都会在版本目录里留垃圾。
	entries, err := os.ReadDir(filepath.Dir(bin))
	if err != nil {
		t.Fatalf("读版本目录: %v", err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			t.Fatalf("残留临时文件: %s", e.Name())
		}
	}
}

func TestInstallRejectsTamperedTarball(t *testing.T) {
	const version = "2.1.325"
	tgz := fakeTgz(t, version)
	srv := fakeRegistry(t, version, tgz, "sha512-AAAA")

	m, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	m.platform = "linux-x64"
	m.registries[SourceNpmmirror] = srv.URL

	if err := m.StartInstall(version, ""); err != nil {
		t.Fatalf("StartInstall: %v", err)
	}
	job := waitJob(t, m)
	if job.Phase != PhaseError || !strings.Contains(job.Error, "完整性校验失败") {
		t.Fatalf("应因 integrity 不匹配失败，实际 phase=%s err=%s", job.Phase, job.Error)
	}
	if m.Active() != "" {
		t.Fatalf("失败时不应切换生效版本，实际 %q", m.Active())
	}
	if got := m.Installed(); len(got) != 0 {
		t.Fatalf("失败时不应留下版本目录，实际 %+v", got)
	}
}

// 装旧版本用于回滚对比时不能把当前生效版本静默降级。
func TestInstallKeepsExistingActiveVersion(t *testing.T) {
	dir := t.TempDir()
	writeFakeVersion(t, dir, "2.1.325")

	m, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if got := m.Active(); got != "2.1.325" {
		t.Fatalf("初始生效版本应为 2.1.325，实际 %q", got)
	}

	const older = "2.1.311"
	tgz := fakeTgz(t, older)
	srv := fakeRegistry(t, older, tgz, integrityOf(tgz))
	m.platform = "linux-x64"
	m.registries[SourceNpmmirror] = srv.URL

	if err := m.StartInstall(older, ""); err != nil {
		t.Fatalf("StartInstall: %v", err)
	}
	if job := waitJob(t, m); job.Phase != PhaseDone {
		t.Fatalf("安装失败: %s", job.Error)
	}
	if got := m.Active(); got != "2.1.325" {
		t.Fatalf("已生效版本不应被新装的旧版本顶掉，实际 %q", got)
	}
	if len(m.Installed()) != 2 {
		t.Fatalf("应有两个版本，实际 %d", len(m.Installed()))
	}
}

func TestInstallRejectsDuplicateVersion(t *testing.T) {
	dir := t.TempDir()
	writeFakeVersion(t, dir, "2.1.325")
	m, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := m.StartInstall("2.1.325", ""); err == nil {
		t.Fatal("已安装的版本应返回错误")
	}
}

func TestCheckReturnsLatestFirst(t *testing.T) {
	const version = "2.1.325"
	tgz := fakeTgz(t, version)
	srv := fakeRegistry(t, version, tgz, integrityOf(tgz))

	m, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	m.registries[SourceNpmmirror] = srv.URL

	got, err := m.Check(t.Context())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if got.Latest != version {
		t.Fatalf("latest=%q，期望 %q", got.Latest, version)
	}
	if len(got.Versions) < 2 || got.Versions[0] != version {
		t.Fatalf("版本列表应以最新版开头，实际 %v", got.Versions)
	}
	if st := m.Status(); st.Latest != version {
		t.Fatalf("Status 应带上缓存的最新版本，实际 %+v", st)
	}
}
