// Package claudebin 负责 claude 二进制的版本化下载、校验与切换。
//
// 为什么不内置：应用本身不再随包分发 claude，也不回退 PATH —— 否则不同 NAS
// 上的 CLI 版本不可控，排查问题时连"跑的是哪个版本"都说不清。改成从 npm
// 平台包按版本下载，按版本号隔离存放在
//
//	CCWEB_DATA_DIR/claude/versions/<version>/claude
//
// 「当前生效版本」持久化在同目录的 state.json。切换只影响此后
// 新建的会话：已在运行的 claude 进程已经把二进制载入内存，不会也不需要热替换。
//
// 数据来源（设置页可切，默认国内镜像）：
//   - npmmirror：https://registry.npmmirror.com（国内实测 ~11 MB/s）
//   - official ：https://registry.npmjs.org
//
// 两个源发布的是同一个平台包，dist.integrity（sha512）逐字节一致；下载完成后按
// integrity 校验再解包，镜像被换包会直接失败，不会把来路不明的二进制装上去。
package claudebin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// 支持的 npm 源标识。字符串直接落盘，改名会让老配置失效。
const (
	SourceNpmmirror = "npmmirror"
	SourceOfficial  = "official"
)

// Sources 是允许选择的源，顺序即设置页展示顺序。
var Sources = []string{SourceNpmmirror, SourceOfficial}

// defaultRegistries 只在 Open 时拷贝到实例上，测试可以逐实例替换。
var defaultRegistries = map[string]string{
	SourceNpmmirror: "https://registry.npmmirror.com",
	SourceOfficial:  "https://registry.npmjs.org",
}

// 安装任务的阶段。前端按字符串映射文案，不要改成数字。
const (
	PhaseDownloading = "downloading"
	PhaseExtracting  = "extracting"
	PhaseVerifying   = "verifying"
	PhaseDone        = "done"
	PhaseError       = "error"
)

var (
	// ErrNotInstalled 表示还没有可用的托管版本。
	ErrNotInstalled = errors.New("claudebin: 未安装 claude")
	// ErrBusy 表示已有安装任务在跑：同一时刻只允许一个，避免抢带宽与写目录。
	ErrBusy = errors.New("claudebin: 已有安装任务在进行")
	// ErrInstalled 表示该版本已经装好。
	ErrInstalled = errors.New("claudebin: 该版本已安装")
)

// Version 是已安装的一个版本。
type Version struct {
	Version     string    `json:"version"`
	Path        string    `json:"path"`
	Size        int64     `json:"size"`
	InstalledAt time.Time `json:"installed_at"`
}

// Job 是一次安装任务的状态快照；前端轮询 /api/claude/status 拿它画进度条。
type Job struct {
	Version    string    `json:"version"`
	Source     string    `json:"source"`
	Phase      string    `json:"phase"`
	Downloaded int64     `json:"downloaded"`
	Total      int64     `json:"total"`
	Error      string    `json:"error,omitempty"`
	StartedAt  time.Time `json:"started_at"`
	FinishedAt time.Time `json:"finished_at,omitzero"`
}

// Status 是「部署」页与启动检查共用的状态。
type Status struct {
	// Platform 是本机对应的 npm 平台包后缀（linux-x64 / linux-arm64 / ...-musl）。
	Platform  string    `json:"platform"`
	Dir       string    `json:"dir"`
	Installed []Version `json:"installed"`
	Active    string    `json:"active"`
	Source    string    `json:"source"`
	// Latest 是最近一次检查得到的 registry 最新版本，空表示还没查过。
	Latest string `json:"latest"`
	// UpdateAvailable 表示最新版本高于当前生效版本。
	UpdateAvailable bool `json:"update_available"`
	// Job 为空表示没有正在跑或最近跑过的任务。
	Job *Job `json:"job"`
}

// CheckResult 是「检查更新」的返回：最新版本 + 可安装的近期版本列表。
type CheckResult struct {
	Source   string   `json:"source"`
	Latest   string   `json:"latest"`
	Versions []string `json:"versions"`
}

// state 是 versions.json 的内容。只存引用与偏好，版本目录本身是事实来源。
type state struct {
	Active        string    `json:"active"`
	Source        string    `json:"source"`
	Latest        string    `json:"latest,omitempty"`
	LatestChecked time.Time `json:"latest_checked,omitzero"`
}

// Manager 管理版本目录与安装任务；并发安全。
type Manager struct {
	root       string
	statePath  string
	platform   string
	client     *http.Client
	registries map[string]string

	mu      sync.Mutex
	st      state
	job     *Job
	cancel  context.CancelFunc
	avail   []string
	availAt time.Time
}

// Open 准备版本目录并读取持久化状态。
//
// dir 是版本目录本身（默认 CCWEB_DATA_DIR/claude/versions）。状态文件放在同一目录下
// 的 state.json：整个托管安装可以整体搬家，不会有一半配置落在别处。
func Open(dir string) (*Manager, error) {
	m := &Manager{
		root:      dir,
		statePath: filepath.Join(dir, "state.json"),
		platform:  Platform(),
		client: &http.Client{Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 15 * time.Second}).DialContext,
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: 30 * time.Second,
			IdleConnTimeout:       90 * time.Second,
		}},
		registries: map[string]string{},
	}
	for k, v := range defaultRegistries {
		m.registries[k] = v
	}
	if err := os.MkdirAll(m.root, 0o755); err != nil {
		return nil, fmt.Errorf("claudebin: 创建版本目录: %w", err)
	}
	m.load()

	// Active 指向一个已不存在的目录（手动删了 / 迁移过）时，回落到已装版本里
	// 最高的那个：否则界面会卡在"已安装但没有生效版本"的怪状态。
	installed := m.Installed()
	if m.st.Active != "" && !hasVersion(installed, m.st.Active) {
		m.st.Active = ""
	}
	if m.st.Active == "" && len(installed) > 0 {
		m.st.Active = installed[0].Version
	}
	m.persist()
	return m, nil
}

// load 读状态文件；损坏或缺失都退回默认值，不阻塞启动。
func (m *Manager) load() {
	st := state{Source: SourceNpmmirror}
	if b, err := os.ReadFile(m.statePath); err == nil {
		var got state
		if json.Unmarshal(b, &got) == nil {
			st = got
		}
	}
	if !validSource(st.Source) {
		st.Source = SourceNpmmirror
	}
	m.st = st
}

// persist 原子写回状态；失败只在调用方关心（通常是日志），没有返回值给前端。
func (m *Manager) persist() error {
	m.mu.Lock()
	st := m.st
	m.mu.Unlock()

	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return fmt.Errorf("claudebin: 序列化状态: %w", err)
	}
	tmp := m.statePath + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return fmt.Errorf("claudebin: 写状态: %w", err)
	}
	if err := os.Rename(tmp, m.statePath); err != nil {
		return fmt.Errorf("claudebin: 替换状态: %w", err)
	}
	return nil
}

// BinPath 返回当前生效版本的二进制路径；没有安装时返回 ErrNotInstalled。
//
// 每次建会话都重新解析（而不是启动时缓存一次），这样在设置页切换版本后
// 下一条新会话立刻用新版本。
func (m *Manager) BinPath() (string, error) {
	m.mu.Lock()
	active := m.st.Active
	m.mu.Unlock()
	if active == "" {
		return "", ErrNotInstalled
	}
	p := filepath.Join(m.root, active, "claude")
	st, err := os.Stat(p)
	if err != nil || st.IsDir() || st.Mode()&0o111 == 0 {
		return "", ErrNotInstalled
	}
	return p, nil
}

// Active 返回当前生效版本号（可能为空）。
func (m *Manager) Active() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.st.Active
}

// Installed 列出已安装版本，按版本号倒序。
func (m *Manager) Installed() []Version {
	entries, err := os.ReadDir(m.root)
	if err != nil {
		return []Version{}
	}
	out := make([]Version, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() || !validVersion(e.Name()) {
			continue
		}
		p := filepath.Join(m.root, e.Name(), "claude")
		st, err := os.Stat(p)
		if err != nil || st.IsDir() {
			continue
		}
		v := Version{Version: e.Name(), Path: p, Size: st.Size()}
		if info, err := e.Info(); err == nil {
			v.InstalledAt = info.ModTime()
		}
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return Compare(out[i].Version, out[j].Version) > 0 })
	return out
}

// Status 返回当前状态快照；切片与 Job 都是副本，调用方可以随意序列化。
func (m *Manager) Status() Status {
	installed := m.Installed()

	m.mu.Lock()
	active, source, latest := m.st.Active, m.st.Source, m.st.Latest
	job := cloneJob(m.job)
	m.mu.Unlock()

	if active != "" && !hasVersion(installed, active) {
		active = ""
	}
	update := active != "" && latest != "" && Compare(latest, active) > 0
	return Status{
		Platform:        m.platform,
		Dir:             m.root,
		Installed:       installed,
		Active:          active,
		Source:          source,
		Latest:          latest,
		UpdateAvailable: update,
		Job:             job,
	}
}

// SetActive 切换生效版本；只接受已安装的版本号。
func (m *Manager) SetActive(version string) error {
	version = trimVersion(version)
	if !hasVersion(m.Installed(), version) {
		return fmt.Errorf("claudebin: 版本 %s 未安装", version)
	}
	m.mu.Lock()
	m.st.Active = version
	m.mu.Unlock()
	return m.persist()
}

// SetSource 记住下载源偏好（只影响后续安装）。
func (m *Manager) SetSource(source string) error {
	if !validSource(source) {
		return fmt.Errorf("claudebin: 未知的下载源 %q", source)
	}
	m.mu.Lock()
	m.st.Source = source
	m.mu.Unlock()
	return m.persist()
}

// Check 查询 registry 的最新版本与近期版本列表（带 5 分钟内存缓存）。
func (m *Manager) Check(ctx context.Context) (CheckResult, error) {
	m.mu.Lock()
	source := m.st.Source
	cached := append([]string(nil), m.avail...)
	at := m.availAt
	m.mu.Unlock()

	if len(cached) > 0 && time.Since(at) < checkCacheTTL {
		return CheckResult{Source: source, Latest: cached[0], Versions: cached}, nil
	}

	versions, latest, err := m.fetchVersions(ctx, source)
	if err != nil {
		return CheckResult{}, err
	}
	m.mu.Lock()
	m.avail = versions
	m.availAt = time.Now()
	m.st.Latest = latest
	m.st.LatestChecked = time.Now()
	m.mu.Unlock()
	_ = m.persist()
	return CheckResult{Source: source, Latest: latest, Versions: versions}, nil
}

// StartInstall 启动一个后台安装任务并立刻返回；进度通过 Status 轮询。
func (m *Manager) StartInstall(version, source string) error {
	version = trimVersion(version)
	if !validVersion(version) {
		return fmt.Errorf("claudebin: 非法的版本号 %q", version)
	}
	if source == "" {
		m.mu.Lock()
		source = m.st.Source
		m.mu.Unlock()
	}
	if !validSource(source) {
		return fmt.Errorf("claudebin: 未知的下载源 %q", source)
	}
	if hasVersion(m.Installed(), version) {
		return ErrInstalled
	}

	m.mu.Lock()
	if m.job != nil && !isFinal(m.job.Phase) {
		m.mu.Unlock()
		return ErrBusy
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.job = &Job{
		Version:   version,
		Source:    source,
		Phase:     PhaseDownloading,
		StartedAt: time.Now(),
	}
	m.mu.Unlock()

	go m.run(ctx, version, source)
	return nil
}

// run 执行安装并把结果写回 job；失败不 panic，全部落在 job.Error 里。
func (m *Manager) run(ctx context.Context, version, source string) {
	m.mu.Lock()
	prevActive := m.st.Active
	m.mu.Unlock()

	err := m.install(ctx, version, source)

	m.mu.Lock()
	if m.job == nil {
		m.job = &Job{Version: version, Source: source}
	}
	m.job.FinishedAt = time.Now()
	m.cancel = nil
	if err != nil {
		m.job.Phase = PhaseError
		m.job.Error = err.Error()
	} else {
		m.job.Phase = PhaseDone
		m.job.Downloaded = m.job.Total
		// 只有原本没有生效版本时才自动启用。装一个旧版本用于回滚对比是常见操作，
		// 静默把当前版本降级会让正在用的机器莫名其妙换版本。
		if prevActive == "" {
			m.st.Active = version
		}
	}
	m.mu.Unlock()

	if err == nil {
		_ = m.persist()
		// 装完顺手刷新可用列表，下次 Check 不会仍停在旧缓存。
		m.mu.Lock()
		m.avail = nil
		m.mu.Unlock()
	}
}

// setPhase 推进阶段；下载阶段保留已下载字节数。
func (m *Manager) setPhase(phase string) {
	m.mu.Lock()
	if m.job != nil {
		m.job.Phase = phase
	}
	m.mu.Unlock()
}

func (m *Manager) setProgress(total int64) {
	m.mu.Lock()
	if m.job != nil && total > 0 {
		m.job.Total = total
	}
	m.mu.Unlock()
}

func (m *Manager) addProgress(n int64) {
	m.mu.Lock()
	if m.job != nil {
		m.job.Downloaded += n
	}
	m.mu.Unlock()
}

func cloneJob(j *Job) *Job {
	if j == nil {
		return nil
	}
	cp := *j
	return &cp
}

func isFinal(phase string) bool {
	return phase == PhaseDone || phase == PhaseError
}

func hasVersion(list []Version, version string) bool {
	for _, v := range list {
		if v.Version == version {
			return true
		}
	}
	return false
}

func validSource(s string) bool {
	for _, v := range Sources {
		if v == s {
			return true
		}
	}
	return false
}

func trimVersion(v string) string {
	// 前端可能把 "v2.1.325" 传上来；只在开头有 v 时去掉。
	if len(v) > 1 && v[0] == 'v' {
		return v[1:]
	}
	return v
}
