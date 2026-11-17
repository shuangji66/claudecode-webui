// Package plugin 通过 `claude plugin` 子命令管理 claude 的插件与 marketplace。
//
// 为什么走 CLI 而不是像 MCP 那样改文件：插件状态的真相分散在 CLI 自己维护的几份
// 文件里（.claude/settings.json 的 enabledPlugins / extraKnownMarketplaces、
// .claude/plugins/installed_plugins.json、known_marketplaces.json，后者现在带
// version: 2），格式随 claude 版本变。手写这些文件等于把版本耦合搬进本项目。
// 而 `claude plugin` 自带非交互接口：--json 输出机器可读结果、-y 跳过确认，
// spawn 一次就有结论（实测 2.1.325，无 TTY 可用）。
//
// 与 `claude mcp add` 的区别值得记一笔：那个是纯交互式命令、没有 JSON 输出，
// 所以 MCP 只能改文件；插件这条链路反过来，CLI 才是唯一真源。
//
// 这个包只负责「拼参数、跑子进程、解析一行 JSON」，不认识 HTTP，也不判断目录
// 是否授权（由网关校验 cwd，project 作用域才用到）。
package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"ccweb/backend/internal/agent/process"
	"ccweb/backend/internal/netproxy"
)

// 超时。marketplace 的克隆/刷新在 CLI 内部就有 120s 上限，这里再留点余量：
// 网络慢时等太久只会让用户以为面板卡了，不如到点报超时。
const (
	timeoutRead      = 30 * time.Second
	timeoutAvailable = 130 * time.Second
	timeoutMutate    = 150 * time.Second
)

// Scope 是插件的作用域。local 有同 user 的语义但没有独立的界面入口，
// 仍然放行：用户可能用 CLI 装过，面板不能因此拒绝操作。
const (
	ScopeUser    = "user"
	ScopeProject = "project"
	ScopeLocal   = "local"
)

var (
	// ErrNotInstalled 表示当前没有生效的 claude 版本（设置 → 部署里装一个）。
	ErrNotInstalled = errors.New("plugin: 没有生效的 claude 版本")
	// ErrBadPluginID 表示 plugin 标识不是 `<名字>@<市场>` 的形状。
	ErrBadPluginID = errors.New("plugin: 插件标识必须是 名字@市场")
	// ErrBadScope 表示作用域不在 user/project/local 之内。
	ErrBadScope = errors.New("plugin: 未知的作用域")
	// ErrBadSource 表示 marketplace 来源既不是 http(s) 地址、也不是家目录里的路径。
	ErrBadSource = errors.New("plugin: marketplace 来源必须是 owner/repo、http(s) 地址或绝对路径")
)

// pluginIDRE / nameRE 都只允许 claude 认的字符：它们会拼进命令行与目录名。
// 拒绝首字符是 `-`（否则会被当成参数）也顺带挡住了这类注入。
var (
	pluginIDRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$`)
	nameRE     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
)

var (
	proxyMu  sync.RWMutex
	proxyNow = func() string { return "" }
)

// SetProxySource 接上「当前代理」的取值函数。
//
// 插件的下载走 CLI 内部的 git：不接这一层，用户「配了代理却装不上插件」。
// 实测无代理时 `marketplace add https://github.com/…` 会 GnuTLS 失败、白等 90 秒；
// 接上代理后同一个仓库 6.7 秒完成 sparse clone。子命令是独立进程，
// 不会继承主进程里那套 http.ProxyFromEnvironment，必须显式注入环境变量。
func SetProxySource(f func() string) {
	proxyMu.Lock()
	defer proxyMu.Unlock()
	if f == nil {
		proxyNow = func() string { return "" }
		return
	}
	proxyNow = f
}

func currentProxy() string {
	proxyMu.RLock()
	defer proxyMu.RUnlock()
	return proxyNow()
}

// Manager 是 `claude plugin` 的调用入口。
type Manager struct {
	// bin 返回当前生效的 claude 二进制（装配层接 claudebin 的 BinPath）。
	bin func() (string, error)
	// home 是 claude 子进程的 HOME（CCWEB_CLAUDE_HOME）：插件状态与 marketplace
	// 缓存都落在这里。**不是宿主机的 HOME**——写错位置会「装上了但会话里没有」。
	home string
	// dir 是可选的 cwd：project 作用域靠它决定写哪个工作区的 .claude/settings.json。
	// 空表示在 home 里跑（user/local 作用域不需要工作区）。
	dir string
	// mu 只串行化**会改状态**的调用：CLI 会读改写 settings.json 与 .claude.json，
	// 两个并发安装会互相覆盖。读调用不参与（否则一次 150s 的安装会把列表接口堵住），
	// 代价是安装进行中 `list` 可能读到半截缓存——由前端「有任务在跑就不刷新列表」规避。
	mu *sync.Mutex
	// caps 按二进制路径缓存「这套 claude 有没有 plugin 子命令」的探测结果。
	caps *capStore
}

// capStore 是共享的能力探测缓存（WithDir 出来的副本要看到同一份）。
type capStore struct {
	mu      sync.Mutex
	entries map[string]capEntry
}

type capEntry struct {
	supported bool
	reason    string
}

// New 构造 Manager。bin 允许返回错误（未安装 claude 时），报错要留给具体操作。
func New(bin func() (string, error), home string) *Manager {
	return &Manager{
		bin:  bin,
		home: home,
		mu:   &sync.Mutex{},
		caps: &capStore{entries: make(map[string]capEntry)},
	}
}

// WithDir 返回一个「在 dir 里执行」的副本，其余状态（HOME、锁、能力缓存）共享。
//
// project 作用域的安装要跑在工作区里：CLI 靠 cwd 决定写哪个 .claude/settings.json。
// 用副本而不是改字段，是因为 Manager 会被多个请求并发使用。
func (m *Manager) WithDir(dir string) *Manager {
	if dir == "" || dir == m.dir {
		return m
	}
	cp := *m
	cp.dir = dir
	return &cp
}

// Home 返回插件状态所在的 claude HOME（界面用来展示「装到哪」）。
func (m *Manager) Home() string { return m.home }

// workdir 是子进程的 cwd：project 作用域给工作区，其余在 HOME 里跑。
func (m *Manager) workdir() string {
	if m.dir != "" {
		return m.dir
	}
	return m.home
}

// Plugin 是 `plugin list --json` 的一条。
type Plugin struct {
	ID          string          `json:"id"`
	Version     string          `json:"version"`
	Scope       string          `json:"scope"`
	Enabled     bool            `json:"enabled"`
	InstallPath string          `json:"installPath"`
	ProjectPath string          `json:"projectPath"`
	InstalledAt string          `json:"installedAt"`
	LastUpdated string          `json:"lastUpdated"`
	MCPServers  json.RawMessage `json:"mcpServers"`
}

// Entry 是 marketplace 里一个可安装的插件（`--available` 的 available[]）。
type Entry struct {
	PluginID    string          `json:"pluginId"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Marketplace string          `json:"marketplaceName"`
	Source      json.RawMessage `json:"source"`
}

// Marketplace 是 `plugin marketplace list --json` 的一条。
type Marketplace struct {
	Name            string `json:"name"`
	Source          string `json:"source"`
	Path            string `json:"path"`
	InstallLocation string `json:"installLocation"`
}

// Result 是变更类命令的返回：CLI 的 --json 是**一行**对象，字段按命令不同。
type Result struct {
	Command       string        `json:"command"`
	Outcome       string        `json:"outcome"`
	Plugin        string        `json:"plugin"`
	PluginID      string        `json:"pluginId"`
	Scope         string        `json:"scope"`
	Marketplace   string        `json:"marketplace"`
	Message       string        `json:"message"`
	FailureCode   string        `json:"failureCode"`
	UpdateOutcome string        `json:"updateOutcome"`
	OldVersion    string        `json:"oldVersion"`
	NewVersion    string        `json:"newVersion"`
	KeptData      bool          `json:"keptData"`
	ShownCommand  *ShownCommand `json:"shownCommand"`
}

// OK 报告这次调用是否成功（outcome 是 CLI 自己的结论，不是退出码）。
func (r Result) OK() bool { return r.Outcome == "ok" }

// ShownCommand 是 marketplace 声明的、需要人看一眼的命令（command-source 安装）。
//
// 只有这类插件 CLI 才会要求确认：面板必须把它展示出来，再把它的 sha256 通过
// --accept-command 传回去；不能拿一个笼统的「全部同意」把它盖过去。
type ShownCommand struct {
	Command string `json:"command"`
	SHA256  string `json:"sha256"`
}

// Details 是 `plugin details` 的组件清单（只对**已安装**的插件有效）。
type Details struct {
	// Text 是 CLI 的原始输出：格式随版本漂移，界面按等宽文本展示，不去猜结构。
	Text       string `json:"text"`
	Skills     int    `json:"skills"`
	Agents     int    `json:"agents"`
	Hooks      int    `json:"hooks"`
	MCPServers int    `json:"mcp_servers"`
}

// Inspect 是「装之前/装之后这个插件会往会话里塞什么」的轻量结论。
//
// `plugin details` 只认已安装的插件，所以安装前只能看清单文件本身：
// plugin.json 里的 hooks / mcpServers 两段，以及 hooks/ 与 .mcp.json 的存在性。
// 找不到目录就返回空结果（不报错）——这不是关键路径，不该拖累安装流程。
type Inspect struct {
	Found      bool   `json:"found"`
	Dir        string `json:"dir"`
	Hooks      bool   `json:"hooks"`
	MCPServers bool   `json:"mcp_servers"`
	Commands   int    `json:"commands"`
	Skills     int    `json:"skills"`
}

// CLIError 是 CLI 明确报错时的结构化错误：message 给人看，code 给机器判断。
type CLIError struct {
	Command string
	Message string
	Code    string
	// Detail 是 stderr 尾部：命令不存在、make 失败这类原因只在这里。
	Detail string
}

func (e *CLIError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	if e.Detail != "" {
		return e.Detail
	}
	return "plugin: " + e.Command + " 失败"
}

// Support 报告这套 claude 是否支持 `plugin` 子命令（按二进制路径缓存一次）。
//
// 面板可以切版本，旧版本不认这个子命令时整页应当置灰并说清原因，
// 而不是给用户一个「点了没反应」的按钮。
func (m *Manager) Support(ctx context.Context) (bool, string) {
	bin, err := m.bin()
	if err != nil || bin == "" {
		return false, "没有生效的 claude 版本：请先在「设置 → 部署」里安装并切换"
	}
	m.caps.mu.Lock()
	if e, ok := m.caps.entries[bin]; ok {
		m.caps.mu.Unlock()
		return e.supported, e.reason
	}
	m.caps.mu.Unlock()

	out, err := m.run(ctx, timeoutRead, "list", "--json")
	if err == nil {
		m.cacheCap(bin, true, "")
		return true, ""
	}
	// 判断标准是「CLI 有没有按协议回答」而不是退出码：命令跑了但自己报错
	// （状态文件坏了、权限不对）说明这个子命令存在，应当把真实原因显示出来；
	// 只有连 JSON 都给不出来（unknown command / 二进制跑不起来）才算不支持。
	//
	// **失败结果不进缓存**：`plugin list` 会在别的 CLI 进程写状态文件时偶发失败，
	// 把这种一次性的失败记成「这套版本不支持插件」，整页就永远置灰了（实测踩到过）。
	// 与 manager.supportsFlag 同一条规矩：只缓存成功。
	var anyJSON any
	if unmarshalPayload(out, &anyJSON) == nil {
		reason := err.Error()
		m.cacheCap(bin, true, reason)
		return true, reason
	}
	return false, err.Error()
}

func (m *Manager) cacheCap(bin string, ok bool, reason string) {
	m.caps.mu.Lock()
	defer m.caps.mu.Unlock()
	m.caps.entries[bin] = capEntry{supported: ok, reason: reason}
}

// List 列出已安装的插件（含停用的）。
func (m *Manager) List(ctx context.Context) ([]Plugin, error) {
	out, err := m.run(ctx, timeoutRead, "list", "--json")
	if err != nil {
		return nil, err
	}
	var list []Plugin
	if err := unmarshalPayload(out, &list); err != nil {
		return nil, fmt.Errorf("plugin: 解析插件列表: %w", err)
	}
	if list == nil {
		list = []Plugin{}
	}
	return list, nil
}

// Available 列出「已安装 + 各 marketplace 里可安装」的插件。
//
// 这一步可能需要刷新 marketplace 目录（联网），因此超时给得比 list 长。
func (m *Manager) Available(ctx context.Context) ([]Plugin, []Entry, error) {
	out, err := m.run(ctx, timeoutAvailable, "list", "--available", "--json")
	if err != nil {
		return nil, nil, err
	}
	var payload struct {
		Installed []Plugin `json:"installed"`
		Available []Entry  `json:"available"`
	}
	if err := unmarshalPayload(out, &payload); err != nil {
		return nil, nil, fmt.Errorf("plugin: 解析可用插件: %w", err)
	}
	if payload.Installed == nil {
		payload.Installed = []Plugin{}
	}
	if payload.Available == nil {
		payload.Available = []Entry{}
	}
	return payload.Installed, payload.Available, nil
}

// Marketplaces 列出已注册的 marketplace。
func (m *Manager) Marketplaces(ctx context.Context) ([]Marketplace, error) {
	out, err := m.run(ctx, timeoutRead, "marketplace", "list", "--json")
	if err != nil {
		return nil, err
	}
	var list []Marketplace
	if err := unmarshalPayload(out, &list); err != nil {
		return nil, fmt.Errorf("plugin: 解析 marketplace 列表: %w", err)
	}
	if list == nil {
		list = []Marketplace{}
	}
	return list, nil
}

// Details 读已安装插件的组件清单与 token 成本（CLI 的原始文本 + 几个计数）。
func (m *Manager) Details(ctx context.Context, id string) (Details, error) {
	if !pluginIDRE.MatchString(id) {
		return Details{}, ErrBadPluginID
	}
	out, err := m.run(ctx, timeoutRead, "details", id)
	if err != nil {
		return Details{}, err
	}
	d := Details{Text: strings.TrimSpace(string(out))}
	d.Skills = countComponent(d.Text, "Skills")
	d.Agents = countComponent(d.Text, "Agents")
	d.Hooks = countComponent(d.Text, "Hooks")
	d.MCPServers = countComponent(d.Text, "MCP servers")
	return d, nil
}

// countComponent 从 details 的 "Skills (2)  greet, hi" 这种行里取计数。
func countComponent(text, label string) int {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, label+" (") {
			continue
		}
		rest := strings.TrimPrefix(line, label+" (")
		end := strings.IndexByte(rest, ')')
		if end <= 0 {
			return 0
		}
		n := 0
		for _, r := range rest[:end] {
			if r < '0' || r > '9' {
				return 0
			}
			n = n*10 + int(r-'0')
		}
		return n
	}
	return 0
}

// Install 安装插件。id 可以是 `名字@市场`，也可以只给名字（配合 marketplace）；
// marketplace 非空时即使没注册过也会先注册（CLI 的行为，等同于界面上「粘一个仓库」）。
func (m *Manager) Install(ctx context.Context, id, marketplace, scope, acceptCommand string) (Result, error) {
	if scope == "" {
		scope = ScopeUser
	}
	if !validScope(scope) {
		return Result{}, ErrBadScope
	}
	// 带 marketplace 时 id 只是插件名（市场由 --marketplace 指定）；不带时必须已经是
	// `名字@市场`。两种形状都要先过白名单：id 会原样拼进命令行。
	if marketplace != "" {
		if !nameRE.MatchString(id) {
			return Result{}, ErrBadPluginID
		}
	} else if !pluginIDRE.MatchString(id) {
		return Result{}, ErrBadPluginID
	}
	args := []string{"install", id, "-s", scope, "-y", "--json"}
	if marketplace != "" {
		src, err := NormalizeSource(marketplace)
		if err != nil {
			return Result{}, err
		}
		args = append(args, "--marketplace", src)
	}
	if acceptCommand != "" {
		args = append(args, "--accept-command", acceptCommand)
	}
	return m.mutate(ctx, "install", args...)
}

// Enable / Disable 切换启用状态。停用是不删配置、也不删数据。
func (m *Manager) Enable(ctx context.Context, id, scope string) (Result, error) {
	return m.byID(ctx, "enable", id, scope, "-s")
}

// Disable 停用一个已启用的插件。
func (m *Manager) Disable(ctx context.Context, id, scope string) (Result, error) {
	return m.byID(ctx, "disable", id, scope, "-s")
}

// Update 更新到最新版本（CLI 明确说需要重启才生效）。
func (m *Manager) Update(ctx context.Context, id, scope string) (Result, error) {
	return m.byID(ctx, "update", id, scope, "-s")
}

// Uninstall 卸载。keepData 保留插件自己的数据目录（~/.claude/plugins/data/<id>）。
func (m *Manager) Uninstall(ctx context.Context, id, scope string, keepData bool) (Result, error) {
	if scope == "" {
		scope = ScopeUser
	}
	if !validScope(scope) {
		return Result{}, ErrBadScope
	}
	if !pluginIDRE.MatchString(id) {
		return Result{}, ErrBadPluginID
	}
	args := []string{"uninstall", id, "-s", scope, "-y", "--json"}
	if keepData {
		args = append(args, "--keep-data")
	}
	return m.mutate(ctx, "uninstall", args...)
}

func (m *Manager) byID(ctx context.Context, cmd, id, scope, scopeFlag string) (Result, error) {
	if scope == "" {
		scope = ScopeUser
	}
	if !validScope(scope) {
		return Result{}, ErrBadScope
	}
	if !pluginIDRE.MatchString(id) {
		return Result{}, ErrBadPluginID
	}
	return m.mutate(ctx, cmd, cmd, id, scopeFlag, scope, "--json")
}

// AddMarketplace 注册一个 marketplace；source 会先归一化（owner/repo → https）。
func (m *Manager) AddMarketplace(ctx context.Context, source string) (Result, error) {
	src, err := NormalizeSource(source)
	if err != nil {
		return Result{}, err
	}
	return m.mutate(ctx, "marketplace-add", "marketplace", "add", src, "--json")
}

// UpdateMarketplace 更新一个（name 为空则全部）marketplace 的目录缓存。
func (m *Manager) UpdateMarketplace(ctx context.Context, name string) (Result, error) {
	args := []string{"marketplace", "update", "--json"}
	if name != "" {
		if !nameRE.MatchString(name) {
			return Result{}, fmt.Errorf("%w: %q", ErrBadSource, name)
		}
		args = append(args, name)
	}
	return m.mutate(ctx, "marketplace-update", args...)
}

// RemoveMarketplace 移除 marketplace（已装的插件不受影响，只是不再能浏览/更新）。
func (m *Manager) RemoveMarketplace(ctx context.Context, name string) (Result, error) {
	if !nameRE.MatchString(name) {
		return Result{}, fmt.Errorf("%w: %q", ErrBadSource, name)
	}
	return m.mutate(ctx, "marketplace-remove", "marketplace", "remove", name, "--json")
}

// Inspect 尽力描述一个插件会往会话里塞什么（见 Inspect 的说明）。
func (m *Manager) Inspect(ctx context.Context, id string) Inspect {
	if !pluginIDRE.MatchString(id) {
		return Inspect{}
	}
	dir := m.pluginDir(ctx, id)
	if dir == "" {
		return Inspect{}
	}
	out := Inspect{Found: true, Dir: dir}
	// plugin.json 里可以直接声明 hooks / mcpServers（CLI 的 details 认这两段）。
	var manifest struct {
		Hooks      json.RawMessage `json:"hooks"`
		MCPServers json.RawMessage `json:"mcpServers"`
	}
	if b, err := os.ReadFile(filepath.Join(dir, ".claude-plugin", "plugin.json")); err == nil {
		_ = json.Unmarshal(b, &manifest)
	}
	out.Hooks = hasDecl(manifest.Hooks) || dirExists(filepath.Join(dir, "hooks"))
	out.MCPServers = hasDecl(manifest.MCPServers) || fileExists(filepath.Join(dir, ".mcp.json")) ||
		fileExists(filepath.Join(dir, "mcp.json"))
	out.Commands = countFiles(filepath.Join(dir, "commands"), ".md")
	out.Skills = countSkillDirs(filepath.Join(dir, "skills"))
	return out
}

// hasDecl 判断一段 JSON 声明是否「有内容」：null / 空对象都算没有。
func hasDecl(raw json.RawMessage) bool {
	s := strings.TrimSpace(string(raw))
	return s != "" && s != "null" && s != "{}" && s != "[]"
}

func dirExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func countFiles(dir, ext string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ext) {
			n++
		}
	}
	return n
}

func countSkillDirs(dir string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if e.IsDir() {
			n++
		}
	}
	return n
}

// pluginDir 找到插件目录：已安装的用 installPath，否则按 marketplace 的缓存目录
// 拼出 source。找不到返回空串（调用方按「信息不足」处理，不当错误）。
func (m *Manager) pluginDir(ctx context.Context, id string) string {
	name, market, _ := strings.Cut(id, "@")
	if installed, err := m.List(ctx); err == nil {
		for _, p := range installed {
			if p.ID == id && p.InstallPath != "" {
				return p.InstallPath
			}
		}
	}
	mks, err := m.Marketplaces(ctx)
	if err != nil {
		return ""
	}
	var root string
	for _, mk := range mks {
		if mk.Name == market {
			root = mk.InstallLocation
			if root == "" {
				root = mk.Path
			}
		}
	}
	if root == "" {
		return ""
	}
	if _, entries, err := m.Available(ctx); err == nil {
		for _, e := range entries {
			if e.PluginID != id {
				continue
			}
			var src string
			if err := json.Unmarshal(e.Source, &src); err != nil || src == "" {
				break
			}
			// source 是相对 marketplace 根目录的路径；`.` 表示根本身。
			if !filepath.IsAbs(src) {
				src = filepath.Join(root, src)
			}
			src = filepath.Clean(src)
			// 只允许落在 marketplace 目录内：清单是外部数据，不能让它把读路径带出去。
			if rel, err := filepath.Rel(root, src); err != nil || strings.HasPrefix(rel, "..") {
				return ""
			}
			if dirExists(src) {
				return src
			}
			// 有些 marketplace 的 source 是目录名而不是相对路径（git sparse 检出的
			// plugins/<名字>），再试一次常见布局。
			alt := filepath.Join(root, "plugins", name)
			if dirExists(alt) {
				return alt
			}
			return ""
		}
	}
	return ""
}

// NormalizeSource 归一化 marketplace 来源。
//
// 关键坑：裸 `owner/repo` 在 CLI 里会按 **SSH** 处理（git@github.com:…），
// 而 claude 的 HOME 里通常没有 known_hosts，实测直接
// `Host key verification failed`。面板统一补成 https，省掉这条死路；
// 想用 SSH 的人仍然可以直接粘完整地址（含 git@ 形式会被拒，请用 https）。
func NormalizeSource(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", ErrBadSource
	}
	switch {
	case strings.HasPrefix(s, "http://"), strings.HasPrefix(s, "https://"):
		return s, nil
	case strings.HasPrefix(s, "/"):
		return filepath.Clean(s), nil
	case strings.Contains(s, "://"), strings.HasPrefix(s, "git@"):
		return "", fmt.Errorf("%w: 只支持 https 地址，SSH 形式请改写成 https://…", ErrBadSource)
	}
	// owner/repo（可带 .git）：补成 GitHub 的 https 地址。
	parts := strings.Split(s, "/")
	if len(parts) == 2 && nameRE.MatchString(parts[0]) && nameRE.MatchString(strings.TrimSuffix(parts[1], ".git")) {
		return "https://github.com/" + strings.TrimSuffix(s, "/"), nil
	}
	return "", ErrBadSource
}

func validScope(scope string) bool {
	switch scope {
	case ScopeUser, ScopeProject, ScopeLocal:
		return true
	}
	return false
}

// mutate 执行一个会改状态的命令：持锁、解析一行 JSON、把失败翻译成 CLIError。
func (m *Manager) mutate(ctx context.Context, kind string, args ...string) (Result, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out, err := m.run(ctx, timeoutMutate, args...)
	var res Result
	if perr := unmarshalPayload(out, &res); perr != nil {
		if err != nil {
			return Result{}, err
		}
		return Result{}, fmt.Errorf("plugin: 解析 %s 结果: %w", kind, perr)
	}
	if res.Command == "" {
		res.Command = kind
	}
	if err != nil {
		return res, err
	}
	if !res.OK() {
		return res, &CLIError{Command: kind, Message: res.Message, Code: res.FailureCode}
	}
	return res, nil
}

// run 执行 `claude plugin <args…>`。
//
// 返回值：stdout（可能是多行 JSON 或一行 JSON）与错误。
// 退出码非 0 时优先用 stdout 里的 JSON 造 CLIError（那里有可读原因与 failureCode），
// 解析不出来才退回 stderr——「命令不存在 / 克隆失败」这类原因只在 stderr 里。
func (m *Manager) run(ctx context.Context, timeout time.Duration, args ...string) ([]byte, error) {
	bin, err := m.bin()
	if err != nil || bin == "" {
		if err == nil {
			err = ErrNotInstalled
		}
		return nil, fmt.Errorf("%w（请去「设置 → 部署」安装）", err)
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, bin, append([]string{"plugin"}, args...)...)
	cmd.Dir = m.workdir()
	cmd.Env = m.env()
	// 超时要连整条进程树一起收掉：CLI 内部会 spawn git，只杀 claude 的话
	// git 还占着管道，cmd.Run() 仍会等到它自然结束（见 pgid_unix.go）。
	setPgid(cmd)
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			killGroup(cmd.Process.Pid)
		}
		return cmd.Process.Kill()
	}
	// 兜底：取消后最多再等 3 秒，之后强行断管道，别让一次坏掉的克隆拖住面板。
	cmd.WaitDelay = 3 * time.Second
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()

	out := stdout.Bytes()
	errTail := tail(stderr.String(), 600)
	if ctx.Err() == context.DeadlineExceeded {
		return out, fmt.Errorf("plugin: %s 超时（%s），网络慢或 marketplace 仓库过大", strings.Join(args, " "), timeout)
	}
	if runErr != nil {
		var res Result
		if unmarshalPayload(out, &res) == nil && (res.Message != "" || res.FailureCode != "") {
			msg := res.Message
			if msg == "" && errTail != "" {
				msg = errTail
			}
			return out, &CLIError{Command: strings.Join(args, " "), Message: msg, Code: res.FailureCode, Detail: errTail}
		}
		msg := errTail
		if msg == "" {
			msg = runErr.Error()
		}
		return out, &CLIError{Command: strings.Join(args, " "), Detail: msg}
	}
	return out, nil
}

// env 构造子进程环境。
//
// 复用 process.CleanEnv：它会剔除继承的 HOME / PWD / CLAUDECODE / 代理变量并补
// HOME/PWD 与 PATH 兜底（启动器可能没给 PATH，而 CLI 内部要 spawn git）。
// 之后再把设置里的代理按当前值注入——**大小写两套都要**，git 与 node 各认一套。
func (m *Manager) env() []string {
	env := process.CleanEnv(os.Environ(), m.home, m.workdir())
	if p := currentProxy(); p != "" {
		env = append(env, netproxy.Env(p)...)
	}
	// 非交互：任何凭据/主机确认提示都必须失败退出，而不是挂在后台等输入。
	return append(env, "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0")
}

// unmarshalPayload 解析 CLI 的输出：整段是 JSON，或者最后一行是 JSON。
//
// install/update 这类命令无论成功失败都只吐**一行**对象，而 list 吐整段数组；
// 两种情况都要认。前导的进度行（"Refreshing marketplace cache…"）只出现在
// message 字段里，不会污染 stdout，但仍按「最后一个能解析的 JSON」兜底。
func unmarshalPayload(out []byte, v any) error {
	trimmed := bytes.TrimSpace(out)
	if len(trimmed) == 0 {
		return errors.New("输出为空")
	}
	if json.Unmarshal(trimmed, v) == nil {
		return nil
	}
	lines := bytes.Split(trimmed, []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		line := bytes.TrimSpace(lines[i])
		if len(line) == 0 || line[0] != '{' && line[0] != '[' {
			continue
		}
		if json.Unmarshal(line, v) == nil {
			return nil
		}
	}
	return errors.New("没有可解析的 JSON")
}

func tail(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return "…" + s[len(s)-max:]
}
