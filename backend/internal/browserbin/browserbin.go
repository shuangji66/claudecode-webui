// Package browserbin 管理内置浏览器 MCP 所用的 playwright 运行时与浏览器内核。
//
// 为什么由本应用托管、而不是让用户自己 `npm i playwright`：
//   - 项目只部署一个 ccweb 二进制，用户机器上没有稳定的 playwright 包；
//   - 内核版本必须可解释：出问题时界面要能说出「跑的是 Chromium 153」，
//     而不是「N 个月前后人装的那一版」。
//
// 目录布局（都在 CCWEB_BROWSER_DIR 下，可以被用户直接删掉重装）：
//
//	<root>/playwright/<版本>/node_modules/playwright/
//	<root>/playwright/<版本>/node_modules/playwright-core/
//	<root>/playwright/<版本>/runner.mjs
//	<root>/playwright/<版本>/browsers/chromium-<build>/
//
// 固定版本：升级只改下面三个常量，`browsers/<build>` 由 playwright 自己的
// browsers.json 决定（1.63.0 → chromium 1243）。不跟随 latest：
// 「今天能跑」与「三个月后还能跑同一份页面」是两件事。
//
// **为什么只有 Chromium**：playwright 的 Firefox 是打过补丁的 build，链接系统
// libnss3/libdbus-glib，而 NAS 上的 Debian 12 两条都不满足（实测 2026-11）：
// Firefox 155 要 NSS_3.126、Firefox 119 要 NSS_3.80，系统的 libnss3 3.87.1 最高只导出
// NSS_3.79；119 还额外缺 libdbus-glib-1.so.2。要过 NSS 这关得退到 Firefox ~117
// （playwright 1.38），那会把 Chromium 从 153 一起拉到 117——为一个跑不动的内核
// 牺牲主内核不值。`Kernels` 仍是切片：以后内核能满足时加一行就行。
package browserbin

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"ccweb/backend/internal/envpath"
	"ccweb/backend/internal/netproxy"
)

// PlaywrightVersion 是固定的 playwright 包版本，同时决定下面两个内核的 build 号。
const PlaywrightVersion = "1.63.0"

// RunnerName 是随包释放到运行时目录里的驱动脚本名（go:embed，见 install.go）。
const RunnerName = "runner.mjs"

// Kernel 是一个可下载的浏览器内核。
//
// Version 是浏览器自身的版本号（界面展示用），Build 是 playwright 缓存目录的后缀。
// Install 是 `playwright install` 认的名字，Dir 是缓存目录前缀——两者不总是同形
// （`chromium-headless-shell` 落盘成 `chromium_headless_shell-<build>`）。
type Kernel struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Version string `json:"version"`
	Build   string `json:"build"`
	// Install 是传给 playwright CLI 的浏览器名。
	Install string `json:"-"`
	// Dir 是 `<browsers>/<Dir>-<Build>` 的目录前缀。
	Dir string `json:"-"`
}

// Kernels 是支持的内核清单，顺序即界面展示顺序。第一个是默认内核。
//
// 现在是单元素切片而不是「一个常量」：下载、自检、状态、界面都按列表走，
// 以后要加回 Firefox（或换成别的内核）只改这张表。
//
// 装的是 **headless shell** 而不是完整 Chromium：本功能只跑 `headless: true`
// （无头浏览器是它的前提，工具里没有有头模式），而 playwright 在 headless 下用的
// 就是 headless shell。两者解压后分别是 261MB 与 393MB，装完整版那份永远用不到。
// ffmpeg 是 playwright 安装流程的固定产物（只有录制视频用得到），留着不动——
// 它只有 5MB，删了反而让「运行时目录为什么少一块」变成需要解释的事。
var Kernels = []Kernel{
	{
		ID:      "chromium",
		Label:   "Chromium 无头内核",
		Version: "153.0.8010.12",
		Build:   "1243",
		Install: "chromium-headless-shell",
		Dir:     "chromium_headless_shell",
	},
}

// 安装任务的阶段。前端按字符串映射文案，不要改成数字。
const (
	PhaseDownloading = "downloading"
	PhaseExtracting  = "extracting"
	PhaseInstalling  = "installing"
	PhaseDone        = "done"
	PhaseError       = "error"
	PhaseCancelled   = "cancelled"
)

// 支持的 npm 源标识。与 claudebin 同一套名字与顺序（设置页共用一套文案），
// 但不共享变量：浏览器运行时可以单独换源，两者一起漂移没有好处。
const (
	SourceNpmmirror = "npmmirror"
	SourceTencent   = "tencent"
	SourceHuawei    = "huawei"
	SourceOfficial  = "official"
)

// Sources 是允许选择的 npm 源，顺序即设置页展示顺序。
var Sources = []string{SourceNpmmirror, SourceTencent, SourceHuawei, SourceOfficial}

var registries = map[string]string{
	SourceNpmmirror: "https://registry.npmmirror.com",
	SourceTencent:   "https://mirrors.cloud.tencent.com/npm",
	SourceHuawei:    "https://repo.huaweicloud.com/repository/npm",
	SourceOfficial:  "https://registry.npmjs.org",
}

// 内核二进制的下载镜像。playwright 的 CLI 认 PLAYWRIGHT_DOWNLOAD_HOST；
// 官方 CDN 在国内常常很慢，npmmirror 有对应的二进制镜像。
const officialDownloadHost = "https://cdn.playwright.dev"

// mirrorDownloadHost 是 npmmirror 的 playwright 二进制镜像。
const mirrorDownloadHost = "https://cdn.npmmirror.com/binaries/playwright"

var (
	// ErrBusy 表示已有安装任务在跑：同一时刻只允许一个，避免抢带宽与写坏目录。
	ErrBusy = errors.New("browserbin: 已有安装任务在进行")
	// ErrNoNode 表示找不到 node 运行时。
	ErrNoNode = errors.New("browserbin: 找不到 node 运行时")
	// ErrBadSource 表示不认识的 npm 源。
	ErrBadSource = errors.New("browserbin: 未知的下载源")
	// ErrUnsigned 表示源没有提供包的完整性摘要。与 claudebin 同一条口径：
	// 拿不到 dist.integrity 就不装——npm 包解出来要被 node 直接执行。
	ErrUnsigned = errors.New("browserbin: npm 源没有提供 dist.integrity，拒绝安装未校验的包")
)

// KernelStatus 是单个内核的安装状态。
//
// Installed 只说明文件在磁盘上；Available 说明它在这台机器上真的能启动
// （内核依赖系统库的符号版本，装得上不等于跑得起来）。
type KernelStatus struct {
	Kernel
	Installed bool   `json:"installed"`
	Available bool   `json:"available"`
	Problem   string `json:"problem,omitempty"`
}

// Status 是给界面的完整快照。
type Status struct {
	// Root 是运行时根目录（用户可以据此手工清理）。
	Root string `json:"root"`
	// Playwright 是固定的包版本。
	Playwright string `json:"playwright"`
	// Installed 为 true 表示 runner 与全部内核都就绪。
	Installed bool `json:"installed"`
	// NodePath / NodeVersion 是解析到的 node（空表示没找到）。
	NodePath    string `json:"node_path"`
	NodeVersion string `json:"node_version"`
	// Kernels 逐个内核的安装状态。
	Kernels []KernelStatus `json:"kernels"`
	// Phase 是安装任务阶段；空闲时为 done（已装）或 ""（未装）。
	Phase string `json:"phase"`
	// Progress / Total 是下载字节数；Total 为 0 表示长度未知。
	Progress int64 `json:"progress"`
	Total    int64 `json:"total"`
	// Note 是当前动作（「正在下载 Chromium 153」之类），给进度条上方那行字用。
	Note string `json:"note"`
	// Error 是上一次失败的原因。
	Error string `json:"error"`
	// Source 是当前选择的 npm 源。
	Source string `json:"source"`
	// Running 表示安装任务正在进行。
	Running bool `json:"running"`
	// Testing 表示正在跑启动自检（结论还没出来）。界面用它区分
	// 「还没测」与「测过、起不来」——两者的可用性判断不同。
	Testing bool `json:"testing"`
}

// Manager 管理一份托管运行时。并发安全。
type Manager struct {
	dir    string
	source string

	client *http.Client

	mu  sync.Mutex
	job *installJob
	// checks 是自检结果（内核 → 能不能启动），来自安装后的一次真实 launch 探测。
	checks map[string]kernelCheck
	// testing 保证同一时刻只跑一次自检（GET 状态时按需触发）。
	testing atomic.Bool
	// selfTested 记「本进程已经试过一次自检」：结论写不进盘（目录不可写、selftest.json
	// 被删）时 Status 不能再每轮询都去真启动一次浏览器。
	selfTested atomic.Bool
	// nodeOnce/nodeVersion 缓存 `node -v`：状态接口被前端 1.5s 轮询一次，
	// 每次 spawn 一个 node 只为读版本号不值得。
	nodeOnce    sync.Once
	nodeVersion string
}

// kernelCheck 是一个内核的自检结论。
type kernelCheck struct {
	ok      bool
	problem string
}

type installJob struct {
	phase    string
	note     string
	progress int64
	total    int64
	err      string
	running  bool
	cancel   func()
}

// SetProxySource 接上「当前代理」的取值函数（与 claudebin 同一个理由：
// 设置里配的代理不会自动进入 http.ProxyFromEnvironment）。
func SetProxySource(fn func() string) { proxySource = fn }

var proxySource = func() string { return "" }

// Open 打开（必要时创建）运行时根目录。
func Open(dir string) (*Manager, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, errors.New("browserbin: 运行时目录为空")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("browserbin: 创建运行时目录: %w", err)
	}
	m := &Manager{
		dir:    dir,
		source: SourceNpmmirror,
	}
	m.loadChecks()
	// 代理回调每次现读设置：用户可能在安装过程中改代理。
	//
	// 各项超时都要有上限：整条安装链路虽然有 installTimeout（40 分钟）兜着，但那是
	// 「下载慢」的预算，不是「对端接了连接却不吐字节」的预算——后者靠 ResponseHeaderTimeout。
	m.client = &http.Client{
		Transport: &http.Transport{
			Proxy: func(req *http.Request) (*url.URL, error) {
				return netproxy.Func(proxySource())(req)
			},
			ResponseHeaderTimeout: 30 * time.Second,
			TLSHandshakeTimeout:   15 * time.Second,
			IdleConnTimeout:       60 * time.Second,
		},
	}
	return m, nil
}

// Dir 返回运行时根目录。
func (m *Manager) Dir() string { return m.dir }

// runtimeDir 是固定版本运行时的目录。
func (m *Manager) runtimeDir() string {
	return filepath.Join(m.dir, "playwright", PlaywrightVersion)
}

func (m *Manager) nodeModulesDir() string {
	return filepath.Join(m.runtimeDir(), "node_modules")
}

func (m *Manager) browsersDir() string {
	return filepath.Join(m.runtimeDir(), "browsers")
}

// RunnerPath 返回释放到磁盘上的 runner 脚本路径。
func (m *Manager) RunnerPath() string {
	return filepath.Join(m.runtimeDir(), RunnerName)
}

// NodePath 解析 node 可执行文件。
//
// mcp-browser 是 claude 的子进程，环境来自 process.CleanEnv（只补 PATH 兜底，
// 不含启动器额外注入的目录）。这里先按 envpath 的规则确认 PATH，再找 node；
// 找不到就是真的没有——界面上的安装按钮会直接报错，而不是下载完才失败。
//
// **只查 PATH，不写死任何落点**：飞牛把依赖应用（nodejs_v24 等）的 bin 目录注入
// 到 PATH 里，靠的就是这一份；写死 `/var/apps/nodejs_vNN/...` 既是多余的第二套
// 判定，也会在升级到 nodejs_v26 之后失效（那时旧路径不存在，界面报「找不到 node」，
// 而环境里明明有一个能用的）。同理不列 `/usr/bin/node` 之类：它们本来就在默认
// PATH 里，列出来只是把「PATH 里没有」这件事说成「有」。
func (m *Manager) NodePath() (string, error) {
	envpath.Apply()
	if p, err := exec.LookPath("node"); err == nil {
		return p, nil
	}
	return "", ErrNoNode
}

// NodeVersion 返回 `node -v` 的输出（解析失败时为空）。
//
// 结果缓存一次：Status 是前端 1.5s 轮询一次的接口，而 node 二进制在一次运行里不会换。
func (m *Manager) NodeVersion() string {
	m.nodeOnce.Do(func() {
		node, err := m.NodePath()
		if err != nil {
			return
		}
		out, err := exec.Command(node, "-v").Output()
		if err != nil {
			return
		}
		m.nodeVersion = strings.TrimSpace(string(out))
	})
	return m.nodeVersion
}

// KernelInstalled 报告某个内核的目录是否已经就位。
func (m *Manager) KernelInstalled(k Kernel) bool {
	dir := k.Dir
	if dir == "" {
		dir = k.ID
	}
	st, err := os.Stat(filepath.Join(m.browsersDir(), dir+"-"+k.Build))
	return err == nil && st.IsDir()
}

// Ready 报告运行时是否完整（runner 脚本 + 全部内核）。
func (m *Manager) Ready() bool {
	if st, err := os.Stat(m.RunnerPath()); err != nil || st.IsDir() {
		return false
	}
	for _, k := range Kernels {
		if !m.KernelInstalled(k) {
			return false
		}
	}
	return true
}

// Runner 返回启动驱动程序所需的命令、参数与环境。
//
// 内核与 headless 由每条命令的参数决定（同一个会话里不该中途换内核，
// 那件事由 runner 自己拒绝），启动参数因此只有脚本路径。
//
// 环境里带 PLAYWRIGHT_BROWSERS_PATH：不写的话 playwright 会去 ~/.cache/ms-playwright
// 找，而那既不是我们装的版本，也可能属于别的用户（权限不足）。
func (m *Manager) Runner() (string, []string, []string, error) {
	node, err := m.NodePath()
	if err != nil {
		return "", nil, nil, err
	}
	if !m.Ready() {
		return "", nil, nil, ErrNotInstalled
	}
	args := []string{m.RunnerPath()}
	return node, args, m.browserEnv(), nil
}

// browserEnv 是浏览器进程需要的环境。
//
// HOME 必须换成运行时目录下的可写目录：浏览器会在 HOME 下建 profile 相关文件
// （Firefox 拿到不可写 HOME 时只报一句 "Could not find profile folder"，实测），
// 而 claude 的 HOME 恰好可能是只读挂载或属于别人的。同时也不该让浏览器把
// ~/.mozilla、~/.cache 写进 claude 的状态目录。
func (m *Manager) browserEnv() []string {
	home := filepath.Join(m.runtimeDir(), "home")
	tmp := filepath.Join(m.runtimeDir(), "tmp")
	_ = os.MkdirAll(home, 0o755)
	_ = os.MkdirAll(tmp, 0o755)
	env := append(os.Environ(),
		"PLAYWRIGHT_BROWSERS_PATH="+m.browsersDir(),
		// 运行时是我们自己装的，别让 playwright 再去检查/下载内核。
		"PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
		"HOME="+home,
		"TMPDIR="+tmp,
	)
	return envpath.Ensure(env)
}

// ErrNotInstalled 表示运行时还没装。
var ErrNotInstalled = errors.New("browserbin: 浏览器运行时未安装")

// Status 返回当前快照。
func (m *Manager) Status() Status {
	node, _ := m.NodePath()
	st := Status{
		Root:       m.dir,
		Playwright: PlaywrightVersion,
		NodePath:   node,
		Kernels:    make([]KernelStatus, 0, len(Kernels)),
	}
	if node != "" {
		st.NodeVersion = m.NodeVersion()
	}
	m.mu.Lock()
	checks := m.checks
	m.mu.Unlock()
	for _, k := range Kernels {
		ks := KernelStatus{Kernel: k, Installed: m.KernelInstalled(k)}
		if ks.Installed {
			if chk, ok := checks[k.ID]; ok {
				ks.Available = chk.ok
				ks.Problem = chk.problem
			} else {
				// 还没有自检结论（安装刚结束、或 selftest.json 被删了）：不谎称坏。
				// 真起不来时 runner 会直接报错，那条错误比这里猜的准。
				ks.Available = true
			}
		}
		st.Kernels = append(st.Kernels, ks)
	}
	st.Installed = m.Ready()
	if !st.Installed {
		st.Phase = ""
	} else {
		st.Phase = PhaseDone
	}

	m.mu.Lock()
	var snap installJob
	hasJob := m.job != nil
	if hasJob {
		snap = *m.job
	}
	st.Source = m.source
	m.mu.Unlock()

	if st.Installed && len(checks) == 0 && !m.selfTested.Load() && m.testing.CompareAndSwap(false, true) {
		// 装好但还没有自检结论（安装刚结束、或结论文件被删）：后台补一次。
		// 不在这里同步跑——状态接口要保持毫秒级。
		go func() {
			defer m.testing.Store(false)
			defer m.selfTested.Store(true)
			m.selfTest(context.Background())
		}()
	}
	st.Testing = m.testing.Load()
	if hasJob {
		st.Running = snap.running
		if snap.phase != "" {
			st.Phase = snap.phase
		}
		st.Note = snap.note
		st.Progress = snap.progress
		st.Total = snap.total
		st.Error = snap.err
	}
	return st
}

// SetSource 切换 npm 源（只影响下一次安装）。
func (m *Manager) SetSource(source string) error {
	if _, ok := registries[source]; !ok {
		return ErrBadSource
	}
	m.mu.Lock()
	m.source = source
	m.mu.Unlock()
	return nil
}
