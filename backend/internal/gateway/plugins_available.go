package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"ccweb/backend/internal/plugin"
)

// 「可安装插件」目录的缓存与分页。
//
// 为什么需要它（实测 2.1.325）：
//   - `plugin list --available` 在官方市场下是 **3743 条**，全量 JSON ≈ 1.27 MB；
//     每次打开设置页都拉一遍，手机走网关很难受，也白占内存。
//   - 这条命令本身很快：目录缓存落了盘之后 **离线 1.2s** 就能出结果（CLI 自己维护
//     `plugin-catalog-cache.json`）；慢的是首次把目录抓下来（约 13s，要联网）。
//
// 所以分成两件事：
//   1. 面板把「上次读到的目录」落盘（`CCWEB_DATA_DIR/plugins-available.json`），
//      重开设置页/重启进程先读它，不用等、也不用手点刷新；
//   2. 目录只在服务端缓存，HTTP 只回**一页**（默认 20 条）+ 命中数，
//      搜索与翻页都在服务端做（内存里过滤 3743 条是微秒级）。
const (
	// pluginAvailableCacheFile 是目录缓存的落盘文件名（在 CCWEB_DATA_DIR 下）。
	pluginAvailableCacheFile = "plugins-available.json"
	// 一页的默认/上限条数。
	pluginPageDefault = 20
	pluginPageMax     = 100
)

// pluginAvailableCache 是落盘格式。带上 Home：换了 claude HOME（部署迁移、测试实例）
// 旧缓存就不该再显示。
type pluginAvailableCache struct {
	Home      string            `json:"home"`
	FetchedAt time.Time         `json:"fetched_at"`
	Items     []pluginAvailable `json:"items"`
	Note      string            `json:"note,omitempty"`
}

// pluginAvailablePage 是 GET /api/plugins/available 的返回。
type pluginAvailablePage struct {
	Items     []pluginAvailable `json:"items"`
	Matched   int               `json:"matched"`
	Total     int               `json:"total"`
	Offset    int               `json:"offset"`
	Limit     int               `json:"limit"`
	FetchedAt string            `json:"fetched_at,omitempty"`
	Note      string            `json:"note,omitempty"`
}

func (s *Server) pluginCachePath() string {
	if s.d.Cfg.DataDir == "" {
		return ""
	}
	return filepath.Join(s.d.Cfg.DataDir, pluginAvailableCacheFile)
}

// loadPluginCache 第一次用到时把落盘的目录读进内存（只读一次）。
//
// 读失败只当没有缓存：这是加速路径，不是真相源——真正的真相仍然是 CLI。
func (s *Server) loadPluginCache() {
	if s.d.Plugins == nil {
		return
	}
	home := s.d.Plugins.Home()

	s.pluginMu.Lock()
	if s.pluginAvailLoaded {
		s.pluginMu.Unlock()
		return
	}
	s.pluginAvailLoaded = true
	s.pluginMu.Unlock()

	path := s.pluginCachePath()
	if path == "" {
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			s.log.Printf("读取插件目录缓存失败: %v", err)
		}
		return
	}
	var cache pluginAvailableCache
	if err := json.Unmarshal(b, &cache); err != nil || cache.Home != home || len(cache.Items) == 0 {
		return
	}

	s.pluginMu.Lock()
	defer s.pluginMu.Unlock()
	// 期间可能已经有刷新任务写进内存了：以内存为准。
	if len(s.pluginAvail) == 0 {
		s.pluginAvail = cache.Items
		s.pluginAvailAt = cache.FetchedAt
		s.pluginAvailNote = cache.Note
	}
}

// savePluginCache 把目录落到 CCWEB_DATA_DIR（原子替换）。
//
// 写入失败只记日志：缓存丢了顶多下次多读一次 CLI，不该让一次刷新变成失败。
func (s *Server) savePluginCache(items []pluginAvailable, at time.Time, note string) {
	path := s.pluginCachePath()
	if path == "" {
		return
	}
	cache := pluginAvailableCache{Home: s.d.Plugins.Home(), FetchedAt: at, Items: items, Note: note}
	b, err := json.Marshal(cache)
	if err != nil {
		s.log.Printf("序列化插件目录缓存失败: %v", err)
		return
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "plugins-available-*.json")
	if err != nil {
		s.log.Printf("写插件目录缓存失败: %v", err)
		return
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		s.log.Printf("写插件目录缓存失败: %v", err)
		return
	}
	if err := tmp.Close(); err != nil {
		s.log.Printf("写插件目录缓存失败: %v", err)
		return
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		s.log.Printf("写插件目录缓存失败: %v", err)
	}
}

// refreshAvailable 是「刷新可用插件」这项后台任务的实际动作。
func (s *Server) refreshAvailable(ctx context.Context) (plugin.Result, error) {
	_, available, err := s.d.Plugins.Available(ctx)
	if err != nil {
		s.setPluginAvailable(nil, time.Time{}, err.Error())
		return plugin.Result{}, err
	}
	list := make([]pluginAvailable, 0, len(available))
	for _, e := range available {
		list = append(list, pluginAvailable{
			PluginID:    e.PluginID,
			Name:        e.Name,
			Description: e.Description,
			Marketplace: e.Marketplace,
		})
	}
	// 固定顺序（市场 + 名字）：分页与「显示更多」必须稳定，否则翻页会重复/漏项。
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].Marketplace != list[j].Marketplace {
			return list[i].Marketplace < list[j].Marketplace
		}
		return list[i].Name < list[j].Name
	})
	s.setPluginAvailable(list, time.Now(), "")
	return plugin.Result{Command: "refresh", Outcome: "ok"}, nil
}

// maybeAutoRefreshAvailable 在进程里只自动尝试一次：
// 有落盘缓存就直接用，没有才在后台补一次（首次抓目录可能要十几秒，不能阻塞请求）。
func (s *Server) maybeAutoRefreshAvailable() {
	s.pluginMu.Lock()
	if s.pluginAutoTried {
		s.pluginMu.Unlock()
		return
	}
	s.pluginAutoTried = true
	empty := len(s.pluginAvail) == 0
	busy := s.pluginJob != nil && s.pluginJob.Phase == pluginJobRunning
	s.pluginMu.Unlock()

	if !empty || busy {
		return
	}
	// 失败也要留下痕迹（job 里能看到原因），但不要自动重试：离线环境下每次进页面
	// 都白等一轮没有意义，用户点「刷新可用插件」才会重来。
	if _, err := s.startPluginJob("refresh", "", s.refreshAvailable); err != nil && err != errPluginBusy {
		s.log.Printf("自动刷新插件目录失败: %v", err)
	}
}

// handleAvailablePlugins 回一页可安装插件。过滤在服务端做（内存里 3743 条很快），
// 这样前端不必为了搜索而持有上百万字节的 JSON。
func (s *Server) handleAvailablePlugins(w http.ResponseWriter, r *http.Request) {
	if s.pluginUnavailable(w) {
		return
	}
	s.loadPluginCache()

	q := strings.TrimSpace(r.URL.Query().Get("q"))
	market := strings.TrimSpace(r.URL.Query().Get("market"))
	hideInstalled := r.URL.Query().Get("hide_installed") == "1"
	limit := pluginPageDefault
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 {
		limit = min(v, pluginPageMax)
	}
	offset := 0
	if v, err := strconv.Atoi(r.URL.Query().Get("offset")); err == nil && v > 0 {
		offset = v
	}

	items, at, note := s.pluginAvailableSnapshot()

	var installed map[string]bool
	if hideInstalled {
		installed = s.installedPluginIDs(r.Context())
	}
	matched := filterAvailablePlugins(items, q, market, hideInstalled, installed)

	page := make([]pluginAvailable, 0, limit)
	if offset < len(matched) {
		end := min(offset+limit, len(matched))
		page = append(page, matched[offset:end]...)
	}
	out := pluginAvailablePage{
		Items:   page,
		Matched: len(matched),
		Total:   len(items),
		Offset:  offset,
		Limit:   limit,
		Note:    note,
	}
	if !at.IsZero() {
		out.FetchedAt = at.Format(time.RFC3339)
	}
	writeJSON(w, out)
}

// installedPluginIDs 只给「只看未安装」用：读失败就当没装过（宁可多显示几条）。
func (s *Server) installedPluginIDs(ctx context.Context) map[string]bool {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	list, err := s.d.Plugins.List(ctx)
	if err != nil {
		return nil
	}
	out := make(map[string]bool, len(list))
	for _, p := range list {
		out[p.ID] = true
	}
	return out
}

// filterAvailablePlugins 与前端原先的本地过滤语义保持一致（空格分词、全部命中、
// 大小写不敏感），只是搬到了服务端。抽成纯函数便于单测。
func filterAvailablePlugins(items []pluginAvailable, q, market string, hideInstalled bool, installed map[string]bool) []pluginAvailable {
	terms := strings.Fields(strings.ToLower(q))
	market = strings.ToLower(market)
	out := make([]pluginAvailable, 0, len(items))
	for _, item := range items {
		if market != "" && strings.ToLower(item.Marketplace) != market {
			continue
		}
		if hideInstalled && installed[item.PluginID] {
			continue
		}
		if len(terms) > 0 {
			hay := strings.ToLower(item.Name + "\n" + item.Description + "\n" + item.Marketplace)
			ok := true
			for _, term := range terms {
				if !strings.Contains(hay, term) {
					ok = false
					break
				}
			}
			if !ok {
				continue
			}
		}
		out = append(out, item)
	}
	return out
}
