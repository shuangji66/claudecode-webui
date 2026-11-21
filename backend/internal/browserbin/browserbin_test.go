package browserbin

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha512"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 固定版本是产品承诺：升级内核必须是一次显式的改动，而不是跟着 npm 漂移。
// 这三个值还与界面文案、文档里的写法绑定，改一处要一起改。
func TestPinnedVersions(t *testing.T) {
	if PlaywrightVersion != "1.63.0" {
		t.Fatalf("PlaywrightVersion = %q，升级时请同步 README/AGENTS 与界面文案", PlaywrightVersion)
	}
	want := map[string]string{"chromium": "1243"}
	if len(Kernels) != len(want) {
		t.Fatalf("Kernels = %+v", Kernels)
	}
	for _, k := range Kernels {
		if want[k.ID] != k.Build {
			t.Fatalf("%s build = %q，want %q", k.ID, k.Build, want[k.ID])
		}
		if k.Label == "" || k.Version == "" {
			t.Fatalf("内核缺展示信息: %+v", k)
		}
		// Install/Dir 是安装与「装没装」判定的两个名字，缺一个就会装到别处或永远判未装。
		if k.Install == "" || k.Dir == "" {
			t.Fatalf("内核缺 Install/Dir: %+v", k)
		}
	}
	for _, k := range Kernels {
		if k.ID != "chromium" {
			t.Fatalf("当前只应注册 chromium，实际还有 %q", k.ID)
		}
	}
}

// 空目录的状态：全未装、Ready=false，且不能因为「目录不存在」就报错。
func TestStatusOnEmptyDir(t *testing.T) {
	dir := t.TempDir()
	m, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	st := m.Status()
	if st.Installed {
		t.Fatal("空目录不该是已安装")
	}
	if st.Playwright != PlaywrightVersion {
		t.Fatalf("playwright = %q", st.Playwright)
	}
	if len(st.Kernels) != len(Kernels) {
		t.Fatalf("kernels = %+v", st.Kernels)
	}
	for _, k := range st.Kernels {
		if k.Installed {
			t.Fatalf("%s 不该是已安装", k.ID)
		}
	}
	if st.Running {
		t.Fatal("没有安装任务时 Running 必须是 false")
	}
	if m.Ready() {
		t.Fatal("空目录 Ready 必须是 false")
	}
}

// Ready 要求 runner 脚本与全部内核目录都就位：只写 runner 会让状态出现
// 「装好了但一调用就失败」的窗口。
func TestReadyRequiresRunnerAndAllKernels(t *testing.T) {
	dir := t.TempDir()
	m, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := os.MkdirAll(m.nodeModulesDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(m.RunnerPath(), []byte("// runner"), 0o644); err != nil {
		t.Fatal(err)
	}
	if m.Ready() {
		t.Fatal("只有 runner、没有内核时不能算就绪")
	}
	for _, k := range Kernels {
		if err := os.MkdirAll(filepath.Join(m.browsersDir(), k.Dir+"-"+k.Build), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if !m.Ready() {
		t.Fatal("runner + 全部内核就位后应就绪")
	}
}

// 未知源必须拒绝（否则安装会用一个空 registry 拼出坏 URL）。
func TestSetSourceRejectsUnknown(t *testing.T) {
	m, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := m.SetSource("sourceforge"); !errors.Is(err, ErrBadSource) {
		t.Fatalf("err = %v", err)
	}
	if err := m.SetSource(SourceOfficial); err != nil {
		t.Fatalf("SetSource(official): %v", err)
	}
	if got := m.Status().Source; got != SourceOfficial {
		t.Fatalf("Source = %q", got)
	}
}

// 内核目录按 `<id>-<build>` 判定：playwright 自己的缓存布局就是这个形状，
// 认别的名字会在升级 build 号后误判成「已安装」。
func TestKernelInstalledUsesBuildSuffix(t *testing.T) {
	m, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	k := Kernels[0]
	if m.KernelInstalled(k) {
		t.Fatal("空目录不该已安装")
	}
	if err := os.MkdirAll(filepath.Join(m.browsersDir(), k.Dir), 0o755); err != nil {
		t.Fatal(err)
	}
	if m.KernelInstalled(k) {
		t.Fatalf("只建 %s（没有 build 后缀）不能算安装", k.Dir)
	}
	if err := os.MkdirAll(filepath.Join(m.browsersDir(), k.Dir+"-"+k.Build), 0o755); err != nil {
		t.Fatal(err)
	}
	if !m.KernelInstalled(k) {
		t.Fatal("建了 <dir>-<build> 应算已安装")
	}
}

// npm 包是可信来源，但仍然要拦住 `..` 与绝对路径：一条写坏的 tar 头能把文件
// 落到数据目录外面。这里用一个正常包 + 一个恶意包分别验证。
func TestExtractTGZ(t *testing.T) {
	dir := t.TempDir()
	normal := filepath.Join(dir, "ok.tgz")
	writeTGZ(t, normal, map[string]string{
		"package/package.json":       `{"name":"playwright"}`,
		"package/lib/cli/program.js": "module.exports = {}",
	})
	dst := filepath.Join(dir, "out")
	if err := extractTGZ(normal, dst); err != nil {
		t.Fatalf("extractTGZ: %v", err)
	}
	if b, err := os.ReadFile(filepath.Join(dst, "package.json")); err != nil || !strings.Contains(string(b), "playwright") {
		t.Fatalf("package.json = %q / %v", b, err)
	}
	if _, err := os.Stat(filepath.Join(dst, "lib", "cli", "program.js")); err != nil {
		t.Fatalf("嵌套文件没解出来: %v", err)
	}

	evil := filepath.Join(dir, "evil.tgz")
	writeTGZ(t, evil, map[string]string{"package/../../escape.txt": "boom"})
	if err := extractTGZ(evil, filepath.Join(dir, "out2")); err == nil {
		t.Fatal("路径穿越必须报错")
	}
	if _, err := os.Stat(filepath.Join(dir, "..", "escape.txt")); err == nil {
		t.Fatal("文件被写到目标目录外面了")
	}
}

// writeTGZ 造一个 npm 包形状的 tar.gz（顶层 package/）。
func writeTGZ(t *testing.T, file string, entries map[string]string) {
	t.Helper()
	f, err := os.Create(file)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	for name, body := range entries {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

// 自检结果要能落盘再读回：进程重启后不必重新启动两个浏览器探测。
func TestChecksPersist(t *testing.T) {
	dir := t.TempDir()
	m, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := os.MkdirAll(m.runtimeDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, k := range Kernels {
		if err := os.MkdirAll(filepath.Join(m.browsersDir(), k.Dir+"-"+k.Build), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	m.mu.Lock()
	m.checks = map[string]kernelCheck{
		"chromium": {ok: false, problem: "缺 NSS_3.126"},
	}
	m.mu.Unlock()
	m.saveChecks()

	again, err := Open(dir)
	if err != nil {
		t.Fatalf("重新 Open: %v", err)
	}
	st := again.Status()
	byID := map[string]KernelStatus{}
	for _, k := range st.Kernels {
		byID[k.ID] = k
	}
	if byID["chromium"].Available || byID["chromium"].Problem != "缺 NSS_3.126" {
		t.Fatalf("chromium = %+v", byID["chromium"])
	}
}

// 同一时刻只允许一个安装任务：两个并发安装会抢同一个目录，写出来的 node_modules
// 和内核互相覆盖，最后谁都跑不起来。
func TestStartInstallRejectsWhenBusy(t *testing.T) {
	m, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	m.mu.Lock()
	m.job = &installJob{running: true}
	m.mu.Unlock()
	if err := m.StartInstall(""); !errors.Is(err, ErrBusy) {
		t.Fatalf("并发安装应返回 ErrBusy，实际 %v", err)
	}
}

// 未知源在启动安装前就被挡掉（否则会拿空 registry 拼出坏 URL 再失败）。
func TestStartInstallRejectsUnknownSource(t *testing.T) {
	m, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := m.StartInstall("some-mirror"); !errors.Is(err, ErrBadSource) {
		t.Fatalf("未知源应返回 ErrBadSource，实际 %v", err)
	}
}

// 删除运行时后必须立刻回到「未安装」：界面据此显示安装按钮，工具据此回安装指引。
// 只删目录不清内存结论的话，selftest.json 的旧结论会跟着状态一起被读出来。
func TestRemoveDropsRuntime(t *testing.T) {
	m, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := os.MkdirAll(m.nodeModulesDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(m.RunnerPath(), []byte("// runner"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, k := range Kernels {
		if err := os.MkdirAll(filepath.Join(m.browsersDir(), k.Dir+"-"+k.Build), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if !m.Ready() {
		t.Fatal("准备阶段应就绪")
	}
	if err := m.Remove(); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if m.Ready() {
		t.Fatal("删除后不该就绪")
	}
	if st := m.Status(); st.Installed {
		t.Fatalf("删除后 Status.Installed 应为 false: %+v", st)
	}
	if _, _, _, err := m.Runner(); !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("删除后 Runner 应返回 ErrNotInstalled，实际 %v", err)
	}
}

// 正在安装时不许删（会把临时目录连同正在写的包一起删掉）。
func TestRemoveRejectsWhileInstalling(t *testing.T) {
	m, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	m.mu.Lock()
	m.job = &installJob{running: true}
	m.mu.Unlock()
	if err := m.Remove(); !errors.Is(err, ErrBusy) {
		t.Fatalf("安装中删除应返回 ErrBusy，实际 %v", err)
	}
}

// 空闲时安装任务的快照（phase/进度/错误）要如实反映，界面靠它画进度条。
func TestStatusReportsJob(t *testing.T) {
	m, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	m.mu.Lock()
	m.job = &installJob{phase: PhaseInstalling, note: "正在下载内核", progress: 10, total: 100, running: true}
	m.mu.Unlock()
	st := m.Status()
	if !st.Running || st.Phase != PhaseInstalling || st.Note != "正在下载内核" || st.Progress != 10 || st.Total != 100 {
		t.Fatalf("Status = %+v", st)
	}
	m.Cancel() // 没有 cancel 函数时是幂等的
	if err := m.Cancel(); err != nil {
		t.Fatalf("Cancel 应幂等: %v", err)
	}
}

// 下载必须按源上的 dist.integrity 校验：包解出来是 node 直接执行的代码，
// 三个国内源又都是第三方镜像，「能下载」不等于「可信」。
func TestDownloadVerifiesIntegrity(t *testing.T) {
	body := []byte("fake playwright tarball")
	sum := sha512.Sum512(body)
	good := "sha512-" + base64.StdEncoding.EncodeToString(sum[:])

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)

	m, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	job := &installJob{phase: PhaseDownloading, running: true}

	dst := filepath.Join(t.TempDir(), "pkg.tgz")
	if err := m.download(context.Background(), job, srv.URL, dst, good); err != nil {
		t.Fatalf("摘要一致时应成功: %v", err)
	}
	if b, err := os.ReadFile(dst); err != nil || !bytes.Equal(b, body) {
		t.Fatalf("下载内容不符: %q / %v", b, err)
	}

	// 摘要不符：报错，并且不留下内容不对的包（下一次安装不该读到它）。
	bad := filepath.Join(t.TempDir(), "bad.tgz")
	wrong := "sha512-" + base64.StdEncoding.EncodeToString(make([]byte, sha512.Size))
	if err := m.download(context.Background(), job, srv.URL, bad, wrong); err == nil {
		t.Fatal("摘要不符必须报错")
	}
	if _, err := os.Stat(bad); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("校验失败时应删掉半成品，stat err = %v", err)
	}
}

// 源没有提供 integrity 时拒绝安装，而不是「没有校验就装」。
func TestPackageIntegrityRequiresDigest(t *testing.T) {
	m, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	cases := []struct {
		name string
		body string
		code int
	}{
		{"缺 integrity", `{"dist":{}}`, http.StatusOK},
		{"integrity 不是 sha512", `{"dist":{"integrity":"sha1-abc"}}`, http.StatusOK},
		{"元数据 404", ``, http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.code)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer srv.Close()
			if _, err := m.packageIntegrity(context.Background(), srv.URL, "playwright", PlaywrightVersion); err == nil {
				t.Fatal("应报错")
			} else if tc.code == http.StatusOK && !errors.Is(err, ErrUnsigned) {
				t.Fatalf("应返回 ErrUnsigned，实际 %v", err)
			}
		})
	}

	// 正常路径：读到摘要就原样返回。
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"dist":{"integrity":"sha512-abc"}}`)
	}))
	defer srv.Close()
	got, err := m.packageIntegrity(context.Background(), srv.URL, "playwright", PlaywrightVersion)
	if err != nil || got != "sha512-abc" {
		t.Fatalf("packageIntegrity = %q / %v", got, err)
	}
}

// 对端不带 Content-Length（chunked）且超过上限时也必须停：上限不能只信头。
func TestDownloadCapsSize(t *testing.T) {
	old := maxPackageBytes
	maxPackageBytes = 16
	t.Cleanup(func() { maxPackageBytes = old })

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Flush 一次让响应变成 chunked：否则 net/http 会补上 Content-Length，
		// 测到的就是「头部就挡住」那条路径，而不是读循环里的累计上限。
		w.(http.Flusher).Flush()
		_, _ = w.Write(bytes.Repeat([]byte("x"), 64))
	}))
	t.Cleanup(srv.Close)

	m, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	err = m.download(context.Background(), &installJob{}, srv.URL, filepath.Join(t.TempDir(), "big.tgz"), "sha512-x")
	if err == nil || !strings.Contains(err.Error(), "上限") {
		t.Fatalf("超过上限应报错，实际 %v", err)
	}
}
