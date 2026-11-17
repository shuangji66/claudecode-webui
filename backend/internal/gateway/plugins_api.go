package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"ccweb/backend/internal/plugin"
)

// 插件管理：把 `claude plugin` 包成面板里的界面。
//
// 与 MCP 那套（改配置文件）不同，插件的真源是 CLI 自己维护的几份文件，格式随版本走，
// 所以这里一律 spawn CLI 并解析它的 --json 输出（见 internal/plugin）。
//
// 两个结构性决定：
//
//  1. **同一时刻只允许一个变更任务**（pluginJob）。marketplace 的克隆/刷新在 CLI
//     内部最长 120s，同步接口会被浏览器与前置网关的超时掐断；而 CLI 会读改写
//     settings.json / .claude.json，两个并发安装会互相覆盖。接口立即返回，前端轮询。
//  2. **可用插件列表单独缓存**。`plugin list --available` 可能要联网刷新目录，
//     不能挂在「打开设置页」这条路径上；由 /api/plugins/refresh 触发后缓存。
const (
	pluginJobRunning = "running"
	pluginJobDone    = "done"
	pluginJobError   = "error"
	// pluginJobTimeout 比包内的命令超时留一点余量：真正的上限在包内按命令区分。
	pluginJobTimeout = 5 * time.Minute
)

// pluginJobView 是一次变更任务的公开状态。
type pluginJobView struct {
	Kind       string         `json:"kind"`
	Target     string         `json:"target"`
	Phase      string         `json:"phase"`
	Message    string         `json:"message,omitempty"`
	Error      string         `json:"error,omitempty"`
	Result     *plugin.Result `json:"result,omitempty"`
	StartedAt  time.Time      `json:"started_at"`
	FinishedAt *time.Time     `json:"finished_at,omitempty"`
}

// pluginEntry / pluginMarketplace / pluginAvailable 是界面看到的形状（snake_case）。
type pluginEntry struct {
	ID            string `json:"id"`
	Version       string `json:"version"`
	Scope         string `json:"scope"`
	Enabled       bool   `json:"enabled"`
	InstallPath   string `json:"install_path"`
	ProjectPath   string `json:"project_path,omitempty"`
	InstalledAt   string `json:"installed_at,omitempty"`
	LastUpdated   string `json:"last_updated,omitempty"`
	HasMCPServers bool   `json:"has_mcp_servers"`
}

type pluginMarketplace struct {
	Name            string `json:"name"`
	Source          string `json:"source"`
	Path            string `json:"path,omitempty"`
	InstallLocation string `json:"install_location"`
}

type pluginAvailable struct {
	PluginID    string `json:"plugin_id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Marketplace string `json:"marketplace"`
}

type pluginsPayload struct {
	Supported bool   `json:"supported"`
	Reason    string `json:"reason,omitempty"`
	// Home 是插件状态所在的 claude HOME（界面显示「装到哪」）。
	Home         string              `json:"home"`
	Installed    []pluginEntry       `json:"installed"`
	Marketplaces []pluginMarketplace `json:"marketplaces"`
	// 可安装插件只给「有多少条 / 什么时候刷的」，明细走 GET /api/plugins/available 分页：
	// 官方市场一份就 3743 条、全量 JSON 1.27 MB，塞进这个每次都要拉的接口不合适。
	AvailableTotal int            `json:"available_total"`
	AvailableAt    string         `json:"available_at,omitempty"`
	AvailableNote  string         `json:"available_note,omitempty"`
	Job            *pluginJobView `json:"job"`
}

// pluginScopeError 把「project 作用域需要已授权的工作区」这类问题说清楚。
var errPluginBusy = errors.New("已有插件任务在进行，等它结束再试")

func (s *Server) pluginUnavailable(w http.ResponseWriter) bool {
	if s.d.Plugins == nil {
		writeErr(w, "插件管理未启用", http.StatusServiceUnavailable)
		return true
	}
	return false
}

// pluginManagerFor 按作用域选 Manager：project 必须先过工作区授权。
func (s *Server) pluginManagerFor(w http.ResponseWriter, scope, cwd string) (*plugin.Manager, bool) {
	if scope == plugin.ScopeProject {
		if cwd == "" {
			writeErr(w, "项目级插件需要先选一个工作区", http.StatusBadRequest)
			return nil, false
		}
		abs, err := s.authorizedCwd(cwd)
		if err != nil {
			s.writeCwdError(w, err)
			return nil, false
		}
		return s.d.Plugins.WithDir(abs), true
	}
	return s.d.Plugins, true
}

// handleListPlugins 读当前状态。这一步只跑快命令（list / marketplace list），
// 可用插件走缓存——否则打开设置页可能触发一次联网刷新。
func (s *Server) handleListPlugins(w http.ResponseWriter, r *http.Request) {
	if s.pluginUnavailable(w) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()

	// 先读落盘缓存（重开设置页/重启进程都不必等一次 CLI），再决定要不要自动补一次。
	s.loadPluginCache()

	payload := pluginsPayload{
		Installed:    []pluginEntry{},
		Marketplaces: []pluginMarketplace{},
		Home:         s.d.Plugins.Home(),
	}
	if avail, at, note := s.pluginAvailableSnapshot(); avail != nil {
		payload.AvailableTotal = len(avail)
		payload.AvailableAt = at.Format(time.RFC3339)
		payload.AvailableNote = note
	}
	// 没有缓存就在后台补一次（首次抓目录可能十几秒，不能卡住这个请求）。
	s.maybeAutoRefreshAvailable()
	// job 要在触发之后再取，前端才能看到「正在读取」。
	payload.Job = s.pluginJobSnapshot()

	// 先真的读一次列表，再判断「版本支持不支持」：探测会 spawn 一次 CLI，
	// 而 CLI 在别的进程写状态文件时可能偶发失败——拿一次偶发失败当结论，
	// 用户会看到「这套 claude 不支持插件」（实测踩到过）。列表读成功就是支持。
	// CLI 每次调用要 ~1s（它自己要读一堆状态文件），两个独立查询并发跑：
	// 打开设置页的等待从「两次串行」降到「一次」。marketplace 读失败不影响主列表。
	type mkResult struct {
		list []plugin.Marketplace
		err  error
	}
	mkCh := make(chan mkResult, 1)
	go func() {
		list, err := s.d.Plugins.Marketplaces(ctx)
		mkCh <- mkResult{list: list, err: err}
	}()

	installed, err := s.d.Plugins.List(ctx)
	if err != nil {
		ok, reason := s.d.Plugins.Support(ctx)
		payload.Supported = ok
		payload.Reason = reason
		if !ok {
			// 连 plugin 子命令都没有：这是「不支持」，不是错误。
			writeJSON(w, payload)
			return
		}
		writeErr(w, "读取插件列表失败: "+err.Error(), http.StatusInternalServerError)
		return
	}
	payload.Supported = true
	for _, p := range installed {
		payload.Installed = append(payload.Installed, entryOf(p))
	}
	// marketplace 列表读失败不该藏掉已装插件：那是两个独立的信息面。
	if mk := <-mkCh; mk.err == nil {
		for _, item := range mk.list {
			payload.Marketplaces = append(payload.Marketplaces, pluginMarketplace{
				Name:            item.Name,
				Source:          item.Source,
				Path:            item.Path,
				InstallLocation: item.InstallLocation,
			})
		}
	} else if payload.Reason == "" {
		payload.Reason = "读取 marketplace 失败: " + mk.err.Error()
	}
	writeJSON(w, payload)
}

func entryOf(p plugin.Plugin) pluginEntry {
	e := pluginEntry{
		ID:            p.ID,
		Version:       p.Version,
		Scope:         p.Scope,
		Enabled:       p.Enabled,
		InstallPath:   p.InstallPath,
		ProjectPath:   p.ProjectPath,
		InstalledAt:   p.InstalledAt,
		LastUpdated:   p.LastUpdated,
		HasMCPServers: len(p.MCPServers) > 0 && string(p.MCPServers) != "null",
	}
	return e
}

// handleRefreshPlugins 刷新「可用插件」缓存（可能要联网，所以走后台任务）。
func (s *Server) handleRefreshPlugins(w http.ResponseWriter, r *http.Request) {
	if s.pluginUnavailable(w) {
		return
	}
	job, err := s.startPluginJob("refresh", "", s.refreshAvailable)
	if err != nil {
		writeErr(w, err.Error(), http.StatusConflict)
		return
	}
	writeJSON(w, map[string]any{"job": job})
}

// pluginInstallReq 是安装请求。id 可以是 `名字@市场`，也可以只给名字 + marketplace。
type pluginInstallReq struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Marketplace   string `json:"marketplace"`
	Scope         string `json:"scope"`
	Cwd           string `json:"cwd"`
	AcceptCommand string `json:"accept_command"`
}

func (s *Server) handleInstallPlugin(w http.ResponseWriter, r *http.Request) {
	if s.pluginUnavailable(w) {
		return
	}
	var req pluginInstallReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, "请求体不是合法 JSON", http.StatusBadRequest)
		return
	}
	scope := req.Scope
	if scope == "" {
		scope = plugin.ScopeUser
	}
	mgr, ok := s.pluginManagerFor(w, scope, req.Cwd)
	if !ok {
		return
	}
	target := req.ID
	if target == "" {
		target = req.Name
	}
	// 界面上点「安装」拿到的 id 已经带 `@市场`。而 CLI 的 --marketplace 只接受
	// **来源**（owner/repo / https / 路径），把市场名塞进去会被拒（ErrBadSource）——
	// 所以这里把「已注册的市场名」还原成 id，只有真的给了来源才透传 --marketplace。
	market := strings.TrimSpace(req.Marketplace)
	if market != "" && !strings.ContainsAny(market, "/:") {
		target = strings.TrimSuffix(target, "@"+market) + "@" + market
		market = ""
	} else if market != "" {
		target = strings.TrimSuffix(target, "@"+market)
	}
	job, err := s.startPluginJob("install", describeTarget(target, market), func(ctx context.Context) (plugin.Result, error) {
		return mgr.Install(ctx, target, market, scope, req.AcceptCommand)
	})
	if err != nil {
		writeErr(w, err.Error(), http.StatusConflict)
		return
	}
	writeJSON(w, map[string]any{"job": job})
}

func describeTarget(name, marketplace string) string {
	if marketplace != "" {
		return name + " ← " + marketplace
	}
	return name
}

// pluginActionReq 是需要插件标识的操作（启用/停用/更新/卸载）。
type pluginActionReq struct {
	ID       string `json:"id"`
	Scope    string `json:"scope"`
	Cwd      string `json:"cwd"`
	Enabled  *bool  `json:"enabled"`
	KeepData bool   `json:"keep_data"`
}

func (s *Server) decodePluginAction(w http.ResponseWriter, r *http.Request) (pluginActionReq, *plugin.Manager, bool) {
	var req pluginActionReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, "请求体不是合法 JSON", http.StatusBadRequest)
		return req, nil, false
	}
	if req.ID == "" {
		writeErr(w, "缺少插件标识（名字@市场）", http.StatusBadRequest)
		return req, nil, false
	}
	if req.Scope == "" {
		req.Scope = plugin.ScopeUser
	}
	mgr, ok := s.pluginManagerFor(w, req.Scope, req.Cwd)
	if !ok {
		return req, nil, false
	}
	return req, mgr, true
}

// handleSetPluginEnabled 启用/停用。停用只改 enabledPlugins，不删数据。
func (s *Server) handleSetPluginEnabled(w http.ResponseWriter, r *http.Request) {
	if s.pluginUnavailable(w) {
		return
	}
	req, mgr, ok := s.decodePluginAction(w, r)
	if !ok {
		return
	}
	if req.Enabled == nil {
		writeErr(w, "缺少 enabled", http.StatusBadRequest)
		return
	}
	kind := "disable"
	if *req.Enabled {
		kind = "enable"
	}
	job, err := s.startPluginJob(kind, req.ID, func(ctx context.Context) (plugin.Result, error) {
		if *req.Enabled {
			return mgr.Enable(ctx, req.ID, req.Scope)
		}
		return mgr.Disable(ctx, req.ID, req.Scope)
	})
	if err != nil {
		writeErr(w, err.Error(), http.StatusConflict)
		return
	}
	writeJSON(w, map[string]any{"job": job})
}

func (s *Server) handleUpdatePlugin(w http.ResponseWriter, r *http.Request) {
	if s.pluginUnavailable(w) {
		return
	}
	req, mgr, ok := s.decodePluginAction(w, r)
	if !ok {
		return
	}
	job, err := s.startPluginJob("update", req.ID, func(ctx context.Context) (plugin.Result, error) {
		return mgr.Update(ctx, req.ID, req.Scope)
	})
	if err != nil {
		writeErr(w, err.Error(), http.StatusConflict)
		return
	}
	writeJSON(w, map[string]any{"job": job})
}

func (s *Server) handleUninstallPlugin(w http.ResponseWriter, r *http.Request) {
	if s.pluginUnavailable(w) {
		return
	}
	req, mgr, ok := s.decodePluginAction(w, r)
	if !ok {
		return
	}
	job, err := s.startPluginJob("uninstall", req.ID, func(ctx context.Context) (plugin.Result, error) {
		return mgr.Uninstall(ctx, req.ID, req.Scope, req.KeepData)
	})
	if err != nil {
		writeErr(w, err.Error(), http.StatusConflict)
		return
	}
	writeJSON(w, map[string]any{"job": job})
}

// handlePluginDetails 读组件清单（token 成本、hooks、MCP server）。
// 只认已安装的插件；安装前的风险提示靠 Inspect（看清单文件，不跑 CLI）。
func (s *Server) handlePluginDetails(w http.ResponseWriter, r *http.Request) {
	if s.pluginUnavailable(w) {
		return
	}
	id := r.URL.Query().Get("id")
	if id == "" {
		writeErr(w, "缺少 id", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	out := map[string]any{
		"id":      id,
		"details": plugin.Details{},
		"inspect": s.d.Plugins.Inspect(ctx, id),
	}
	d, err := s.d.Plugins.Details(ctx, id)
	if err != nil {
		// 未安装的插件查不到详情是正常情况：把 Inspect 的结果照样返回，
		// 让界面显示「装之前能看到的那部分」。
		out["error"] = err.Error()
		writeJSON(w, out)
		return
	}
	out["details"] = d
	writeJSON(w, out)
}

// pluginMarketplaceReq 是 marketplace 的增删改。
type pluginMarketplaceReq struct {
	Action string `json:"action"`
	Source string `json:"source"`
	Name   string `json:"name"`
}

func (s *Server) handlePluginMarketplace(w http.ResponseWriter, r *http.Request) {
	if s.pluginUnavailable(w) {
		return
	}
	var req pluginMarketplaceReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, "请求体不是合法 JSON", http.StatusBadRequest)
		return
	}
	var (
		kind   string
		target string
		fn     func(context.Context) (plugin.Result, error)
	)
	switch req.Action {
	case "add":
		if req.Source == "" {
			writeErr(w, "缺少 source（owner/repo 或 https 地址）", http.StatusBadRequest)
			return
		}
		kind, target = "marketplace-add", req.Source
		fn = func(ctx context.Context) (plugin.Result, error) {
			return s.d.Plugins.AddMarketplace(ctx, req.Source)
		}
	case "update":
		kind, target = "marketplace-update", req.Name
		if target == "" {
			target = "全部"
		}
		fn = func(ctx context.Context) (plugin.Result, error) {
			return s.d.Plugins.UpdateMarketplace(ctx, req.Name)
		}
	case "remove":
		if req.Name == "" {
			writeErr(w, "缺少 name", http.StatusBadRequest)
			return
		}
		kind, target = "marketplace-remove", req.Name
		fn = func(ctx context.Context) (plugin.Result, error) {
			return s.d.Plugins.RemoveMarketplace(ctx, req.Name)
		}
	default:
		writeErr(w, "未知的 action（add / update / remove）", http.StatusBadRequest)
		return
	}
	job, err := s.startPluginJob(kind, target, fn)
	if err != nil {
		writeErr(w, err.Error(), http.StatusConflict)
		return
	}
	writeJSON(w, map[string]any{"job": job})
}

// startPluginJob 启动一个后台任务（同一时刻只允许一个）。
//
// 失败（CLI 报错/超时）记进 job.Error，接口本身仍是 200：任务是异步的，
// 200 只表示「已接受」。前端按 phase 判断结果。
func (s *Server) startPluginJob(kind, target string, fn func(context.Context) (plugin.Result, error)) (pluginJobView, error) {
	s.pluginMu.Lock()
	if s.pluginJob != nil && s.pluginJob.Phase == pluginJobRunning {
		s.pluginMu.Unlock()
		return pluginJobView{}, errPluginBusy
	}
	job := &pluginJobView{Kind: kind, Target: target, Phase: pluginJobRunning, StartedAt: time.Now()}
	s.pluginJob = job
	view := *job
	s.pluginMu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), pluginJobTimeout)
		defer cancel()
		res, err := fn(ctx)

		s.pluginMu.Lock()
		defer s.pluginMu.Unlock()
		now := time.Now()
		job.FinishedAt = &now
		if err != nil {
			job.Phase = pluginJobError
			job.Error = err.Error()
			// CLI 明确给出的结果也带上：失败时界面要能显示 message/failureCode。
			if res.Outcome != "" {
				r := res
				job.Result = &r
			}
			return
		}
		job.Phase = pluginJobDone
		job.Message = res.Message
		job.Result = &res
	}()
	return view, nil
}

func (s *Server) pluginJobSnapshot() *pluginJobView {
	s.pluginMu.Lock()
	defer s.pluginMu.Unlock()
	if s.pluginJob == nil {
		return nil
	}
	cp := *s.pluginJob
	return &cp
}

// pluginAvailableSnapshot 返回目录缓存的副本（items / 抓取时间 / 失败说明）。
//
// 时间用 time.Time 而不是字符串：调用方有的要格式化给前端，有的要判断「有没有缓存」。
func (s *Server) pluginAvailableSnapshot() ([]pluginAvailable, time.Time, string) {
	s.pluginMu.Lock()
	defer s.pluginMu.Unlock()
	if s.pluginAvailAt.IsZero() {
		return nil, time.Time{}, ""
	}
	out := make([]pluginAvailable, len(s.pluginAvail))
	copy(out, s.pluginAvail)
	return out, s.pluginAvailAt, s.pluginAvailNote
}

func (s *Server) setPluginAvailable(list []pluginAvailable, at time.Time, note string) {
	s.pluginMu.Lock()
	s.pluginAvail = list
	s.pluginAvailAt = at
	s.pluginAvailNote = note
	s.pluginMu.Unlock()

	// 成功读到目录才落盘（at 为零表示刷新失败，保留上一次的缓存）。
	if at.IsZero() || len(list) == 0 {
		return
	}
	s.savePluginCache(list, at, note)
}
