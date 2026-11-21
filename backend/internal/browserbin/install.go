package browserbin

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha512"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"ccweb/backend/internal/netproxy"
)

// runnerSource 是随二进制分发的驱动脚本。它只有一份真源（本目录的 runner.mjs），
// 安装时释放到运行时目录，`ccweb mcp-browser` 再用 node 启动它。
//
//go:embed runner.mjs
var runnerSource []byte

// 下载上限：playwright 包两个加起来约 6MB，给 64MB 足够；内核由 playwright 自己的
// CLI 下载，不经过这里。
//
// 是变量而不是常量：测试要把它调小来钉住「超过上限就停」，否则得先造 64MB 的响应体。
var maxPackageBytes int64 = 64 << 20

// installTimeout 是整条安装链路的上限（下载包 + 两个内核）。
//
// 国内直连官方 CDN 时 Chromium 一百多兆，慢的时候要十几分钟；给到 40 分钟
// 是为了不让「网慢」变成「装到一半失败」，超时仍然有上限。
const installTimeout = 40 * time.Minute

// StartInstall 启动一次安装。同一时刻只允许一个任务。
//
// source 为空表示沿用当前选择。这里只做校验与登记，真正的下载在后台跑，界面轮询 Status。
func (m *Manager) StartInstall(source string) error {
	m.mu.Lock()
	if m.job != nil && m.job.running {
		m.mu.Unlock()
		return ErrBusy
	}
	if source != "" {
		if _, ok := registries[source]; !ok {
			m.mu.Unlock()
			return ErrBadSource
		}
		m.source = source
	}
	if _, err := m.NodePath(); err != nil {
		m.mu.Unlock()
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), installTimeout)
	job := &installJob{phase: PhaseDownloading, running: true, cancel: cancel}
	m.job = job
	job.note = "准备下载"
	src := m.source
	m.mu.Unlock()

	go m.runInstall(ctx, job, src)
	return nil
}

// Cancel 取消进行中的安装（幂等）。
func (m *Manager) Cancel() error {
	m.mu.Lock()
	job := m.job
	m.mu.Unlock()
	if job == nil || !job.running || job.cancel == nil {
		return nil
	}
	job.cancel()
	return nil
}

// Remove 删除整个运行时目录。正在安装时拒绝。
//
// 注意：已经连着的会话里可能还有 node/浏览器在读这些文件。Linux 上删掉已打开的文件
// 不会让它们立刻崩，但下一次要读新文件就会失败——所以界面上的文案是「重启会话后生效」。
func (m *Manager) Remove() error {
	m.mu.Lock()
	busy := m.job != nil && m.job.running
	m.mu.Unlock()
	if busy {
		return ErrBusy
	}
	if err := os.RemoveAll(filepath.Join(m.dir, "playwright")); err != nil {
		return fmt.Errorf("browserbin: 删除运行时: %w", err)
	}
	return nil
}

func (m *Manager) runInstall(ctx context.Context, job *installJob, source string) {
	// 成功路径也要收掉 40 分钟的超时定时器（否则它会一直挂到点）。
	if job.cancel != nil {
		defer job.cancel()
	}
	err := m.install(ctx, job, source)

	m.mu.Lock()
	job.running = false
	switch {
	case err == nil:
		job.phase, job.note, job.err = PhaseDone, "已安装", ""
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		job.phase, job.err = PhaseCancelled, ""
		job.note = "已取消"
	default:
		job.phase, job.err = PhaseError, err.Error()
		job.note = ""
	}
	m.mu.Unlock()

	// 取消/失败时清掉半成品，避免下一次安装被残缺的 node_modules 误导。
	if err != nil {
		_ = os.RemoveAll(filepath.Join(m.dir, "playwright", ".tmp"))
	}
}

func (m *Manager) install(ctx context.Context, job *installJob, source string) error {
	reg := registries[source]
	if reg == "" {
		return ErrBadSource
	}

	tmp := filepath.Join(m.dir, "playwright", ".tmp")
	if err := os.RemoveAll(tmp); err != nil {
		return fmt.Errorf("browserbin: 清理临时目录: %w", err)
	}
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return fmt.Errorf("browserbin: 创建临时目录: %w", err)
	}
	defer os.RemoveAll(tmp)

	if err := os.MkdirAll(m.nodeModulesDir(), 0o755); err != nil {
		return fmt.Errorf("browserbin: 创建 node_modules: %w", err)
	}

	for _, name := range []string{"playwright", "playwright-core"} {
		url := fmt.Sprintf("%s/%s/-/%s-%s.tgz", reg, name, name, PlaywrightVersion)
		tgz := filepath.Join(tmp, name+".tgz")
		// 先取源上的 dist.integrity 再下载：包解出来是 node 直接 require 的代码，
		// 「能下载」不等于「可信」（三个国内源都是第三方镜像）。
		integrity, err := m.packageIntegrity(ctx, reg, name, PlaywrightVersion)
		if err != nil {
			return err
		}
		m.setPhase(job, PhaseDownloading, "正在下载 "+name+" "+PlaywrightVersion)
		if err := m.download(ctx, job, url, tgz, integrity); err != nil {
			return err
		}
		m.setPhase(job, PhaseExtracting, "正在解包 "+name)
		dst := filepath.Join(m.nodeModulesDir(), name)
		if err := os.RemoveAll(dst); err != nil {
			return fmt.Errorf("browserbin: 清理旧包: %w", err)
		}
		if err := extractTGZ(tgz, dst); err != nil {
			return err
		}
		_ = os.Remove(tgz)
	}

	// runner 最后写：它存在 + 内核就绪才算 Ready，先写会让状态出现「装好了但跑不了」的窗口。
	if err := os.WriteFile(m.RunnerPath(), runnerSource, 0o644); err != nil {
		return fmt.Errorf("browserbin: 写入 runner: %w", err)
	}

	m.setPhase(job, PhaseInstalling, "正在下载浏览器内核")
	if err := m.installKernels(ctx, job, source); err != nil {
		return err
	}
	if !m.Ready() {
		return errors.New("browserbin: 安装结束但内核目录不完整，可重试或检查磁盘空间")
	}
	// 装完自检：把「文件在、但起不来」的内核标出来（内核依赖系统库的符号版本）。
	m.selfTest(ctx)
	return nil
}

// installKernels 跑 playwright 自己的 CLI 装内核。
//
// 为什么调它的 CLI 而不是自己拼下载 URL：内核压缩包的结构、完整性校验、
// 平台分支都由 playwright 的 browsers.json 决定，自己拼迟早和它漂移。
func (m *Manager) installKernels(ctx context.Context, job *installJob, source string) error {
	node, err := m.NodePath()
	if err != nil {
		return err
	}
	cli := filepath.Join(m.nodeModulesDir(), "playwright", "cli.js")
	if st, err := os.Stat(cli); err != nil || st.IsDir() {
		return errors.New("browserbin: playwright 包不完整（缺 cli.js）")
	}

	host := officialDownloadHost
	if source == SourceNpmmirror {
		host = mirrorDownloadHost
	}
	env := append(os.Environ(),
		"PLAYWRIGHT_BROWSERS_PATH="+m.browsersDir(),
		"PLAYWRIGHT_DOWNLOAD_HOST="+host,
		"PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
		// 慢网下别因为单次连接超时失败。
		"PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=120000",
	)
	env = append(env, netproxy.Env(proxySource())...)

	names := make([]string, 0, len(Kernels))
	for _, k := range Kernels {
		name := k.Install
		if name == "" {
			name = k.ID
		}
		names = append(names, name)
	}
	args := append([]string{cli, "install"}, names...)

	return m.runStreaming(ctx, job, node, args, env)
}

// runStreaming 跑一个子命令并把输出逐行喂给进度（内核下载的唯一可见进度来源）。
//
// 独立进程组：playwright 的 CLI 会 spawn 解压子进程，取消时必须整组杀，
// 否则取消之后后台还在写内核目录，下一次安装又读到半成品。
func (m *Manager) runStreaming(ctx context.Context, job *installJob, name string, args, env []string) error {
	cmd := exec.Command(name, args...)
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("browserbin: 接管道: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("browserbin: 接管道: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("browserbin: 启动 playwright CLI: %w", err)
	}

	var wg sync.WaitGroup
	scan := func(r io.Reader) {
		defer wg.Done()
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 0, 8<<10), 256<<10)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" {
				continue
			}
			m.setNote(job, truncateLine(line, 140))
		}
	}
	wg.Add(2)
	go scan(stdout)
	go scan(stderr)

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	select {
	case <-ctx.Done():
		killGroup(cmd)
		<-done
		wg.Wait()
		return ctx.Err()
	case err := <-done:
		wg.Wait()
		if err != nil {
			return fmt.Errorf("browserbin: 内核安装失败: %w", err)
		}
		return nil
	}
}

func killGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	pid, err := syscall.Getpgid(cmd.Process.Pid)
	if err != nil {
		_ = cmd.Process.Kill()
		return
	}
	_ = syscall.Kill(-pid, syscall.SIGKILL)
}

// packageIntegrity 取 npm 包某个版本的 dist.integrity（`sha512-<base64>`）。
//
// 与 claudebin 同一条口径（见 claudebin/install.go）：**拿不到摘要就拒绝安装**。
// 浏览器运行时不一样的地方是源头更多——除了官方 registry，还有三个国内镜像，
// 它们都是第三方；解出来的包由 node 直接执行，没有校验就等于装上来路不明的代码。
func (m *Manager) packageIntegrity(ctx context.Context, registry, pkg, version string) (string, error) {
	metaURL := fmt.Sprintf("%s/%s/%s", strings.TrimRight(registry, "/"), pkg, version)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, metaURL, nil)
	if err != nil {
		return "", fmt.Errorf("browserbin: 构造元数据请求: %w", err)
	}
	resp, err := m.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("browserbin: 读取 %s 元数据: %w", pkg, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("browserbin: 读取 %s 元数据返回 HTTP %d", pkg, resp.StatusCode)
	}
	var meta struct {
		Dist struct {
			Integrity string `json:"integrity"`
		} `json:"dist"`
	}
	// 元数据只有几 KB，但不要相信对端给的长度：上限 1 MiB 足够。
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&meta); err != nil {
		return "", fmt.Errorf("browserbin: 解析 %s 元数据: %w", pkg, err)
	}
	if !strings.HasPrefix(meta.Dist.Integrity, "sha512-") {
		return "", fmt.Errorf("%w（%s %s）", ErrUnsigned, pkg, version)
	}
	return meta.Dist.Integrity, nil
}

// download 把 url 拉成文件，进度写进 job，并按 integrity 校验 sha512。
//
// 校验失败时删掉文件：留一份内容不对的 tgz 只会让下一次安装看起来更奇怪。
func (m *Manager) download(ctx context.Context, job *installJob, url, dst, integrity string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("browserbin: 构造下载请求: %w", err)
	}
	resp, err := m.client.Do(req)
	if err != nil {
		return fmt.Errorf("browserbin: 下载 %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("browserbin: 下载 %s 返回 HTTP %d", url, resp.StatusCode)
	}
	// 长度已知时先挡一次：别等到写完 4 GiB 才发现对端给的不是包。
	if resp.ContentLength > maxPackageBytes {
		return fmt.Errorf("browserbin: 包体积异常（%d 字节）: %s", resp.ContentLength, url)
	}

	f, err := os.Create(dst)
	if err != nil {
		return fmt.Errorf("browserbin: 创建文件: %w", err)
	}
	defer f.Close()

	if resp.ContentLength > 0 {
		m.setTotal(job, resp.ContentLength)
	}

	// Content-Length 可以是假的（chunked 时也没有），所以读的时候再挡一次。
	hash := sha512.New()
	body := io.LimitReader(resp.Body, maxPackageBytes+1)
	buf := make([]byte, 64<<10)
	var written int64
	for {
		n, rerr := body.Read(buf)
		if n > 0 {
			written += int64(n)
			if written > maxPackageBytes {
				return fmt.Errorf("browserbin: 下载超过上限（%d MB）: %s", maxPackageBytes>>20, url)
			}
			if _, werr := f.Write(buf[:n]); werr != nil {
				return fmt.Errorf("browserbin: 写入文件: %w", werr)
			}
			_, _ = hash.Write(buf[:n]) // hash.Hash 的 Write 不会失败
			m.addProgress(job, int64(n))
		}
		if errors.Is(rerr, io.EOF) {
			break
		}
		if rerr != nil {
			return fmt.Errorf("browserbin: 读取响应: %w", rerr)
		}
	}

	got := "sha512-" + base64.StdEncoding.EncodeToString(hash.Sum(nil))
	if got != integrity {
		_ = os.Remove(dst)
		return fmt.Errorf("browserbin: 完整性校验失败（期望 %s，实际 %s）；%s 的内容与源上的摘要不一致，可能是镜像被换包", integrity, got, url)
	}
	return nil
}

// extractTGZ 把 npm 包解到 dst（去掉顶层 package/ 前缀）。
//
// npm 包是可信来源，但仍然拦住 `..` 与绝对路径：一条写坏了的 tar 头可以把文件
// 落到数据目录外面去。
func extractTGZ(file, dst string) error {
	f, err := os.Open(file)
	if err != nil {
		return fmt.Errorf("browserbin: 打开压缩包: %w", err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("browserbin: 解压（不是有效 gzip）: %w", err)
	}
	defer gz.Close()

	if err := os.MkdirAll(dst, 0o755); err != nil {
		return fmt.Errorf("browserbin: 创建包目录: %w", err)
	}

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("browserbin: 解析 tar: %w", err)
		}
		name := path.Clean(strings.TrimPrefix(hdr.Name, "package/"))
		if name == "." || name == "" || name == "package" {
			continue
		}
		if strings.HasPrefix(name, "..") || strings.HasPrefix(name, "/") {
			return fmt.Errorf("browserbin: 压缩包内路径非法: %q", hdr.Name)
		}
		target := filepath.Join(dst, filepath.FromSlash(name))

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return fmt.Errorf("browserbin: 创建目录: %w", err)
			}
		case tar.TypeReg:
			if hdr.Size > maxPackageBytes {
				return fmt.Errorf("browserbin: 包内文件过大: %s", hdr.Name)
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return fmt.Errorf("browserbin: 创建目录: %w", err)
			}
			mode := os.FileMode(0o644)
			if hdr.Mode&0o111 != 0 {
				mode = 0o755
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
			if err != nil {
				return fmt.Errorf("browserbin: 写入文件: %w", err)
			}
			if _, err := io.Copy(out, tr); err != nil {
				out.Close()
				return fmt.Errorf("browserbin: 解包文件: %w", err)
			}
			if err := out.Close(); err != nil {
				return fmt.Errorf("browserbin: 关闭文件: %w", err)
			}
		default:
			// 符号链接 / 硬链接一律忽略：playwright 包不需要它们。
			continue
		}
	}
	return nil
}

func (m *Manager) setPhase(job *installJob, phase, note string) {
	if job == nil {
		return
	}
	m.mu.Lock()
	job.phase = phase
	if note != "" {
		job.note = note
	}
	m.mu.Unlock()
}

func (m *Manager) setNote(job *installJob, note string) {
	if job == nil {
		return
	}
	m.mu.Lock()
	job.note = note
	m.mu.Unlock()
}

func (m *Manager) setTotal(job *installJob, total int64) {
	if job == nil {
		return
	}
	m.mu.Lock()
	job.total = total
	job.progress = 0
	m.mu.Unlock()
}

func (m *Manager) addProgress(job *installJob, n int64) {
	if job == nil {
		return
	}
	m.mu.Lock()
	job.progress += n
	m.mu.Unlock()
}

// truncateLine 按 rune 截断一行输出（playwright 的进度行带制表符与色块，别切坏 UTF-8）。
func truncateLine(s string, limit int) string {
	r := []rune(s)
	if len(r) <= limit {
		return s
	}
	return string(r[:limit]) + "…"
}

/* ------------------------------------------------------------------ 自检 */

// selfTestFile 是自检结果的落盘位置（跟运行时同目录，删除运行时一并清掉）。
func (m *Manager) selfTestFile() string {
	return filepath.Join(m.runtimeDir(), "selftest.json")
}

type persistedCheck struct {
	OK      bool   `json:"ok"`
	Problem string `json:"problem"`
}

type persistedChecks struct {
	Kernels map[string]persistedCheck `json:"kernels"`
}

// loadChecks 读上次的自检结果（进程重启后不必每次都重新启动浏览器探测）。
func (m *Manager) loadChecks() {
	b, err := os.ReadFile(m.selfTestFile())
	if err != nil {
		return
	}
	var pc persistedChecks
	if err := json.Unmarshal(b, &pc); err != nil {
		return
	}
	checks := make(map[string]kernelCheck, len(pc.Kernels))
	for id, c := range pc.Kernels {
		checks[id] = kernelCheck{ok: c.OK, problem: c.Problem}
	}
	m.mu.Lock()
	m.checks = checks
	m.mu.Unlock()
}

func (m *Manager) saveChecks() {
	m.mu.Lock()
	pc := persistedChecks{Kernels: map[string]persistedCheck{}}
	for id, c := range m.checks {
		pc.Kernels[id] = persistedCheck{OK: c.ok, Problem: c.problem}
	}
	m.mu.Unlock()
	b, err := json.MarshalIndent(pc, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(m.selfTestFile(), b, 0o644)
}

// selfTest 对每个已安装的内核跑一次真实的 launch 探测。
//
// 为什么必须真启动一次：`firefox --version` / 文件校验都会成功，但 launch 失败——
// 内核的 libxul 依赖系统库的符号版本（实测 Firefox 155 要 NSS_3.126、119 要 NSS_3.80，
// 而 Debian 12 的 libnss3 只导出到 NSS_3.79）。只查文件在不在的话，界面会写
// 「已安装」，模型第一次调用才炸。
// 结论落盘：每次状态查询都启动两个浏览器是不可接受的。
func (m *Manager) selfTest(ctx context.Context) {
	node, err := m.NodePath()
	if err != nil {
		return
	}
	checks := make(map[string]kernelCheck, len(Kernels))
	for _, k := range Kernels {
		if !m.KernelInstalled(k) {
			continue
		}
		script := fmt.Sprintf(
			// 探测必须走完 launch → newContext → newPage：只 launch 的话，
			// 受限环境里内核会「启动成功、newPage 挂死/关闭」（实测），
			// 界面就会把一个用不了的内核显示成可用。
			`const pw=require('playwright');pw.%s.launch({headless:true%s}).then(async b=>{try{const c=await b.newContext();const p=await c.newPage();await p.goto('about:blank')}finally{await b.close().catch(()=>{})};process.exit(0)}).catch(e=>{console.error(String(e&&e.message||e));process.exit(1)})`,
			k.ID, chromiumSelfTestArgs(k.ID),
		)
		cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		cmd := exec.CommandContext(cctx, node, "-e", script)
		cmd.Dir = m.nodeModulesDir()
		cmd.Env = m.browserEnv()
		out, runErr := cmd.CombinedOutput()
		cancel()
		if runErr == nil {
			checks[k.ID] = kernelCheck{ok: true}
			continue
		}
		checks[k.ID] = kernelCheck{ok: false, problem: summarizeSelfTest(string(out))}
	}
	m.mu.Lock()
	m.checks = checks
	m.mu.Unlock()
	m.saveChecks()
}

// chromiumSelfTestArgs 给 chromium 的探测加容器里常用的两个开关。
func chromiumSelfTestArgs(id string) string {
	if id != "chromium" {
		return ""
	}
	return `,args:['--no-sandbox','--disable-dev-shm-usage']`
}

// summarizeSelfTest 把 playwright 的启动错误压成一行人话。
//
// 最常见的两类：缺系统库（libnss3 版本太旧）与可执行文件缺失。原文很长，取
// 第一行错误 + 命中的符号版本提示，够用户判断「要不要换 Chromium」。
func summarizeSelfTest(raw string) string {
	lines := strings.Split(strings.TrimSpace(raw), "\n")
	picked := make([]string, 0, 3)
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.Contains(line, "not found") || strings.Contains(line, "NSS_") ||
			strings.Contains(line, "missing dependencies") || strings.Contains(line, "Failed to launch") {
			picked = append(picked, line)
		}
	}
	if len(picked) == 0 {
		for _, line := range lines {
			if line = strings.TrimSpace(line); line != "" {
				picked = append(picked, line)
				break
			}
		}
	}
	if len(picked) == 0 {
		return "启动失败（超时或没有输出）"
	}
	return truncateLine(strings.Join(picked, "；"), 240)
}
