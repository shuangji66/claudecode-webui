package settings

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	neturl "net/url"
	"slices"
	"strings"
	"time"
)

// Model 是网关模型列表里的一个条目。
type Model struct {
	ID      string `json:"id"`
	Display string `json:"display_name,omitempty"`
	OwnedBy string `json:"owned_by,omitempty"`
	// ContextLength 是条目的上下文窗口（部分网关提供），用于回填压缩窗口。
	ContextLength int `json:"context_length,omitempty"`
	// MaxOutputTokens 是条目的最大输出 token 数（部分网关提供）。
	MaxOutputTokens int `json:"max_output_tokens,omitempty"`
}

// AuthInfo 描述一次请求实际使用的认证方式（只报类型，不含值）。
type AuthInfo struct {
	// Header 是按配置使用的头：x-api-key 或 bearer。
	Header string `json:"header"`
	// SwitchedTo 非空表示按配置的头被拒（401/403）、换成它才成功。界面上
	// 「认证方式」应该改成这个值——对话没有重试的机会。
	SwitchedTo string `json:"switched_to,omitempty"`
}

// Attempt 是一次探测的记录。
type Attempt struct {
	Path   string `json:"path"`
	Status int    `json:"status"`
	Note   string `json:"note"`
}

// ModelsResult 是拉取模型列表的结果。
//
// 没有 `supported`：以前它表示「这个协议的列表能不能自动拉」，协议删掉之后
// 只剩 Anthropic Messages 一条路，字段恒为 true——留着就是个谁都不读、却在
// 暗示「有些端点拉不到列表」的假开关。
type ModelsResult struct {
	Models   []Model   `json:"models"`
	Endpoint string    `json:"endpoint"`
	Status   int       `json:"status"`
	Detail   string    `json:"detail"`
	Raw      string    `json:"raw,omitempty"`
	Tried    []string  `json:"tried,omitempty"`
	Attempts []Attempt `json:"attempts,omitempty"`
	Auth     AuthInfo  `json:"auth"`
}

// ListingURL 拼出模型列表地址：`{root}/v1/models?limit=1000`。
//
// 只有 Anthropic Messages 一种协议，所以规则也只有一条。root 用 ListBaseURL
// 剥过 `/v1`，这里无条件拼 `/v1/models`——用户填 `https://api.anthropic.com/v1`
// 与填 `https://api.anthropic.com` 得到同一个地址。
//
// override 非空时直接用 `{base}{override}`，便于覆盖各家不统一的路径
// （例如中转把列表放在 `/models` 而不是 `/v1/models`）。
//
// 这只是**首选**地址：预置里的 Anthropic 兼容端点常常把 base 指到只承载对话的
// 子路径上，模型列表在同一主机却不在那下面（见 listingCandidates）。
func ListingURL(baseURL, override string) string {
	base := strings.TrimRight(baseURL, "/")
	if o := strings.TrimSpace(override); o != "" {
		if !strings.HasPrefix(o, "/") {
			o = "/" + o
		}
		return base + o
	}
	return base + "/v1/models?limit=1000"
}

// listingCandidates 返回「可能给出模型列表」的地址，按可信度排序。
//
// **对话地址与列表地址在预置里常常不同源**：claude 在 base 后面自己拼
// `/v1/messages`，所以 Anthropic 兼容端点会把 base 指到 `/anthropic`、
// `/apps/anthropic` 这类只承载对话的子路径上；而模型列表在同一主机上通常在
// `{主机}/v1/models`，少数在 `{主机}/models`。实测（2026-11）：
//
//	DeepSeek   /anthropic  → 主机 /v1/models（带密钥 200；/anthropic/v1/models 404）
//	Moonshot   /anthropic  → 主机 /v1/models（/anthropic/v1/models 404）
//	MiniMax    /anthropic  → 主机 /v1/models
//	小米       /anthropic  → 主机 /v1/models
//	百炼 coding /apps/anthropic → 主机 /v1/models（/apps/v1/models 404）
//	Copilot    根          → 根 /models（/v1/models 404）
//	Z.AI       /api/anthropic → /api/paas/v4/models（Coding Plan 是 /api/coding/paas/v4/models）
//
// 前六条是「同一个主机、路径换个前缀」的通用规律，最后一条不是：智谱把模型列表
// 放在它 OpenAI 兼容端点的版本号后面（`/api/paas/v4/models`），主机根下连
// `/v1/models` 都没有。这类只能按主机名登记（hostListingPaths）。
//
// 以前无条件拼 `{base}/v1/models`，于是预置里只要带 `/anthropic` 就必然
// `/anthropic/v1/models → 404`，界面上只说「未能获取模型列表」。
//
// 手动填了 ModelsPath 时以它为准：先按 API 地址拼，再按主机根拼一次（见下），
// 但不再去猜别的路径名。
func listingCandidates(p Provider) []string {
	base := p.ListBaseURL()
	if o := strings.TrimSpace(p.ModelsPath); o != "" {
		manual := ListingURL(base, o)
		out := []string{manual}
		// 手填路径同样要能吃「base 带对话子路径」这一套：用户写 `/v1/models`
		// 时想的是主机根，而不是 `{base}/v1/models`（DeepSeek 的 base 是
		// `/anthropic`，拼上去正好是那个 404）。所以再试一次主机根下的同一路径。
		if root := hostRoot(base); root != strings.TrimRight(base, "/") {
			if alt := ListingURL(root, o); alt != manual {
				out = append(out, alt)
			}
		}
		return out
	}
	out := []string{ListingURL(base, "")}
	root := hostRoot(base)
	// 主机根下的 `/v1/models` 与 `/models`：前者覆盖绝大多数「base 带对话子路径」
	// 的情况，后者覆盖路径本来就不带 /v1 的（Copilot）。
	//
	// 顺序不动 `{base}/v1/models` 那条：预置上它必然 404（几十毫秒），而自建中转
	// 完全可能把列表就放在同一个前缀下——为了省一次往返去猜「/anthropic 结尾
	// 就一定不在下面」是拿语义换性能，不划算。
	if v1 := root + "/v1/models?limit=1000"; v1 != out[0] {
		out = append(out, v1)
	}
	if m := root + "/models"; !slices.Contains(out, m) {
		out = append(out, m)
	}
	for _, path := range extraListingPaths(root) {
		if u := root + path; !slices.Contains(out, u) {
			out = append(out, u)
		}
	}
	return out
}

// hostListingPaths 是「通用规律之外」的按主机登记项（键是 hostname，不带端口）。
//
// 只收那些模型列表确实不在 `{主机}/v1/models` 上的端点，而且必须是**同一份密钥
// 能拉到的列表**——列在这里的路径会真的被请求，猜错只是多一条 attempts 记录。
var hostListingPaths = map[string][]string{
	// 智谱：通用 API 与 Coding Plan 是两个前缀，两个都试（账号只开通其中一个）。
	"api.z.ai":         {"/api/paas/v4/models", "/api/coding/paas/v4/models"},
	"open.bigmodel.cn": {"/api/paas/v4/models", "/api/coding/paas/v4/models"},
}

// extraListingPaths 取某主机登记过的额外路径。
//
// 按 **hostname** 匹配（不含端口）：真实端点都是默认端口，而单测里的
// httptest 会带随机端口——按 Host 匹配的话，那张表在测试里永远命中不了。
func extraListingPaths(root string) []string {
	u, err := neturl.Parse(root)
	if err != nil || u.Host == "" {
		return nil
	}
	return hostListingPaths[u.Hostname()]
}

// hostRoot 返回 `scheme://host[:port]`（去掉 path）。
func hostRoot(rawurl string) string {
	u, err := neturl.Parse(rawurl)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return strings.TrimRight(rawurl, "/")
	}
	return u.Scheme + "://" + u.Host
}

// pathOf 把地址折成「相对主机根」的路径，用于回显与排查。
func pathOf(rawurl string) string {
	u, err := neturl.Parse(rawurl)
	if err != nil {
		return rawurl
	}
	out := u.Path
	if out == "" {
		out = "/"
	}
	if u.RawQuery != "" {
		out += "?" + u.RawQuery
	}
	return out
}

// listingOutcome 是一次「问端点要模型列表」的完整结果（含每条候选的记录）。
type listingOutcome struct {
	models []Model
	// attempts 与 listingCandidates 等长，下标一一对应。
	attempts []Attempt
	// path 是拿到模型的那条候选（失败时是最后一条）。
	path   string
	status int
	body   []byte
	// authSwitched 非空表示按配置的头被拒、换成它才成功。
	authSwitched string
	// authRejected 表示至少有一条候选说「凭据不对」。
	authRejected bool
	// allAuthRejected 表示**每一条**候选都说「凭据不对」（且换头也没救回来）。
	// 只有它才能下「密钥/认证方式不对」的结论：路径不存在也可能回 401。
	allAuthRejected bool
	// deadline 表示调用方给的 ctx 到期了，还有候选没问完。
	//
	// 单条候选的超时不算：那只是这一条慢，后面还要继续问（见 perListingTimeout）。
	deadline bool
	// netFailed 表示每条候选都栽在网络层（DNS / 证书 / 连接被拒）。
	// 这时「列表」这一步什么都证明不了，调用方要么报网络故障，要么继续往下探。
	netFailed bool
	// lastNetErr 是最后一条候选的网络错误（netFailed 时给用户看原因）。
	lastNetErr error
}

// perListingTimeout 是**单条候选**的时间上限。
//
// 候选最多 5 条，而 Probe / FetchModels 的整体预算只有 ProbeTimeout（15 秒）。
// 不加这一层的话，一条不响应的路径（防火墙丢包、被墙的域名）就能吃掉整个预算，
// 后面的候选全部变成 `context deadline exceeded` ——「获取模型列表」变成
// 「点了转 15 秒然后说请求失败」，比修复前还差。3 秒足够正常端点回 404/401
// （实测都在 1 秒内），也留出 5 条候选 + 换头重试的空间。
const perListingTimeout = 3 * time.Second

// oneListing 在一条地址上试一次（用 p 的认证方式）。
//
// 自己套一层 perListingTimeout，只中断这一次请求；调用方的 ctx 仍然管整体预算。
func oneListing(ctx context.Context, c *http.Client, url string, p Provider) (Attempt, []Model, int, []byte, bool, error) {
	tryCtx, cancel := context.WithTimeout(ctx, perListingTimeout)
	defer cancel()
	status, body, truncated, err := doAuth(tryCtx, c, http.MethodGet, url, p, nil)
	attempt := Attempt{Path: pathOf(url), Status: status}
	switch {
	case err != nil:
		attempt.Note = "请求失败：" + err.Error()
		return attempt, nil, status, body, false, err
	case status >= 200 && status < 300 && truncated:
		attempt.Note = fmt.Sprintf("响应超过 %d 字节被截断，无法解析", readLimitModels)
		return attempt, nil, status, body, false, nil
	case status >= 200 && status < 300:
		models, perr := parseModels(body)
		switch {
		case perr != nil:
			attempt.Note = "200，但不是模型列表（" + perr.Error() + "）"
		case len(models) == 0:
			attempt.Note = "200，但没有模型条目"
		default:
			attempt.Note = fmt.Sprintf("200，%d 个模型", len(models))
			return attempt, models, status, body, true, nil
		}
		return attempt, nil, status, body, false, nil
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		attempt.Note = fmt.Sprintf("鉴权失败（HTTP %d）", status)
		return attempt, nil, status, body, true, nil
	case status == http.StatusNotFound:
		attempt.Note = "404（该路径不存在）"
		return attempt, nil, status, body, false, nil
	default:
		attempt.Note = fmt.Sprintf("HTTP %d", status)
		return attempt, nil, status, body, false, nil
	}
}

// listModels 依次试候选地址，返回第一个能解析出模型的结果。
//
// 401/403 的处理分两种情况：
//   - **base 只有主机根**（`https://api.anthropic.com`、`https://gw:8000`）：
//     base 底下就那一条路径，401 就是结论——当场用另一种头重试一次（单地址
//     时代的兜底），不再猜别的路径；
//   - **base 带子路径**（预置里的 `/anthropic`、`/apps/anthropic`）：401 可能只是
//     「这条路径不存在、网关统一回 401」（实测 MiniMax 的 `/anthropic/*` 就是这样），
//     继续试主机根那条；全都不成再把被拒的几条换成另一种头重试。
//
// 不区分的话，前者会把一次鉴权失败放大成三次请求，后者则会把一把有效密钥
// 判成无效。
func listModels(ctx context.Context, c *http.Client, p Provider) listingOutcome {
	candidates := listingCandidates(p)
	out := listingOutcome{}
	// 子路径 base 才需要「路径猜错」这条解释（见函数注释）。
	subPath := strings.TrimSpace(strings.TrimPrefix(pathOf(p.ListBaseURL()), "/")) != ""
	rejected := make([]int, 0, len(candidates))
	// reachable 表示至少有一条候选让端点给出了 HTTP 回应（哪怕是 404）。
	// 它才是「列表在哪」这个问题的依据；只有网络层失败说明连地址都没到。
	reachable := false
	for _, url := range candidates {
		attempt, models, status, body, authish, err := oneListing(ctx, c, url, p)
		out.attempts = append(out.attempts, attempt)
		out.path, out.status, out.body = attempt.Path, status, body
		if len(models) > 0 {
			out.models = models
			return out
		}
		if err != nil {
			// 区分两种失败：**这一条自己超时**（perListingTimeout，后面还有候选
			// 可以问）与**整体预算到期**（调用方的 ctx 也没了，问下去全是即时失败）。
			if ctx.Err() == nil {
				out.lastNetErr = err
				continue
			}
			out.deadline = true
			return out
		}
		reachable = true
		if !authish {
			continue
		}
		out.authRejected = true
		rejected = append(rejected, len(out.attempts)-1)
		if !subPath {
			break
		}
	}
	// 每条候选都栽在网络层：列表这一步什么都没问出来，原因在地址/网络/代理上。
	out.netFailed = !reachable && out.lastNetErr != nil

	alt, header, ok := p.switchAuth()
	if !ok || len(rejected) == 0 {
		out.allAuthRejected = out.authRejected && len(rejected) == len(out.attempts)
		return out
	}
	for _, i := range rejected {
		attempt, models, status, body, _, err := oneListing(ctx, c, candidates[i], alt)
		out.attempts[i] = attempt
		if len(models) > 0 {
			out.models = models
			out.path, out.status, out.body = attempt.Path, status, body
			out.authSwitched = header
			return out
		}
		if err != nil {
			if ctx.Err() == nil {
				continue
			}
			out.deadline = true
			return out
		}
	}
	out.allAuthRejected = out.authRejected && len(rejected) == len(out.attempts)
	return out
}

const rawPreviewBytes = 600

// FetchModels 询问端点「你提供哪些模型」。
//
// 这是尽力而为的便利路径：端点用什么格式作答由它自己决定，
// 拿不到时手动输入模型名效果相同。
//
// 预置的 Anthropic 兼容端点把对话放在 `/anthropic` 这类子路径上，模型列表
// 却在主机根（见 listingCandidates），所以这里要按候选顺序问，而不是只问
// base 底下那一条——只问一条的话，预置里一半的提供商「获取模型列表」永远是 404。
func FetchModels(ctx context.Context, p Provider) ModelsResult {
	res := ModelsResult{
		Endpoint: p.Root(),
		Auth:     AuthInfo{Header: NormalizeAuth(p.Auth)},
	}
	if !strings.HasPrefix(res.Endpoint, "http://") && !strings.HasPrefix(res.Endpoint, "https://") {
		res.Detail = "地址必须以 http:// 或 https:// 开头"
		return res
	}

	client := proxyClient()
	out := listModels(ctx, client, p)
	res.Attempts = out.attempts
	res.Tried = make([]string, 0, len(out.attempts))
	for _, a := range out.attempts {
		res.Tried = append(res.Tried, a.Path)
	}
	res.Status = out.status
	if len(out.models) > 0 {
		res.Models = out.models
		res.Detail = fmt.Sprintf("共 %d 个模型（%s）", len(out.models), out.path)
		if out.authSwitched != "" {
			res.Auth.SwitchedTo = out.authSwitched
			res.Detail = fmt.Sprintf("共 %d 个模型（%s，%s 认证）", len(out.models), out.path, authLabel(out.authSwitched))
		}
		return res
	}

	res.Raw = preview(out.body)
	// 失败原因要说「最后一条为什么不行」，同时把试过的路径都列出来——预置端点
	// 上失败时真正的原因常常是「列表不在对话 base 底下」，只报第一条会误导。
	last, note := out.path, ""
	if n := len(out.attempts); n > 0 {
		note = out.attempts[n-1].Note
		if last == "" {
			last = out.attempts[n-1].Path
		}
	}
	hint := hintFor(res.Raw)
	switch {
	case out.deadline:
		// 整体 15 秒被前面的慢响应吃完了，后面的候选根本没问到：别把
		// `context deadline exceeded` 当成端点故障报出去。
		hint = "。探测超时，还有路径没试完；可用「模型列表路径」直接指定。"
	case out.netFailed:
		// 每条候选都栽在网络层：原因在地址/网络/代理上，不是「这家没有列表接口」。
		// 走到这里时 Raw 是空的，hintFor 会说「可能没有模型列表接口」——那是误导。
		res.Detail = "请求失败：" + out.lastNetErr.Error()
		return res
	case out.authRejected:
		hint = "。有路径回了 401/403：请检查密钥与「认证方式」（x-api-key / Bearer）。"
	}
	res.Detail = fmt.Sprintf("未能获取模型列表（%s → %s）", last, note) + hint
	return res
}

// hintFor 依据原始响应给出下一步提示。
func hintFor(raw string) string {
	low := strings.ToLower(strings.TrimSpace(raw))
	switch {
	case low == "":
		return "。响应体为空，该网关可能没有模型列表接口，可直接手动填写模型名。"
	case strings.HasPrefix(low, "<!doctype") || strings.HasPrefix(low, "<html"):
		return "。返回的是 HTML 页面（多半是该网关没有这个接口，被前端路由兜底了），请手动填写模型名。"
	case strings.Contains(low, "\"error\""):
		return "。网关返回了错误对象，请检查地址、密钥与「认证方式」（x-api-key / Bearer）。"
	default:
		return "。可直接手动填写模型名，效果相同。"
	}
}

// preview 截取响应体用于回显。
func preview(b []byte) string {
	s := strings.TrimSpace(string(b))
	s = strings.ReplaceAll(s, "\r", "")
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > rawPreviewBytes {
		s = s[:rawPreviewBytes] + "…"
	}
	return s
}

// parseModels 宽松解析模型列表：不假定外层键，递归查找「像模型数组」的节点。
//
// 支持 `data` 数组（OpenAI / Anthropic）、`models` 数组或映射、Gemini 的
// `models` 数组（条目名形如 models/gemini-x）。
func parseModels(body []byte) ([]Model, error) {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return nil, fmt.Errorf("响应体为空")
	}
	var root any
	if err := json.Unmarshal([]byte(trimmed), &root); err != nil {
		return nil, fmt.Errorf("响应不是合法 JSON")
	}
	if ms := findModels(root, 0); len(ms) > 0 {
		return ms, nil
	}
	return nil, fmt.Errorf("没有可识别的模型数组")
}

const maxWalkDepth = 6

// findModels 深度优先寻找第一个能解析出模型的节点。
func findModels(v any, depth int) []Model {
	if depth > maxWalkDepth {
		return nil
	}
	switch t := v.(type) {
	case []any:
		if ms := decodeItems(t); len(ms) > 0 {
			return ms
		}
		for _, item := range t {
			if ms := findModels(item, depth+1); len(ms) > 0 {
				return ms
			}
		}
	case map[string]any:
		for _, k := range []string{"data", "models", "model_list", "modelList", "items", "list", "result", "results"} {
			child, ok := t[k]
			if !ok {
				continue
			}
			// `models` 可能是 id→元数据的映射而不是数组。
			if mm, isMap := child.(map[string]any); isMap && k == "models" {
				if ms := findModelsFromMap(mm); len(ms) > 0 {
					return ms
				}
			}
			if ms := findModels(child, depth+1); len(ms) > 0 {
				return ms
			}
		}
		for _, child := range t {
			if ms := findModels(child, depth+1); len(ms) > 0 {
				return ms
			}
		}
	}
	return nil
}

// decodeItems 把数组元素解析成 Model。
func decodeItems(items []any) []Model {
	out := make([]Model, 0, len(items))
	seen := make(map[string]bool, len(items))
	add := func(id, display, owned string, ctxLen, maxOut int) {
		id = strings.TrimSpace(id)
		// Gemini 的条目名形如 models/gemini-1.5-pro，对外只留模型名。
		if i := strings.LastIndex(id, "/"); i >= 0 {
			id = id[i+1:]
		}
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		out = append(out, Model{ID: id, Display: display, OwnedBy: owned, ContextLength: ctxLen, MaxOutputTokens: maxOut})
	}

	for _, item := range items {
		switch el := item.(type) {
		case string:
			add(el, "", "", 0, 0)
		case map[string]any:
			id := firstString(el, "id", "name", "model", "model_id", "modelId", "slug")
			if id == "" {
				if inner, ok := el["data"].(map[string]any); ok {
					id = firstString(inner, "id", "name", "model")
				}
			}
			if id == "" {
				continue
			}
			display := firstString(el, "display_name", "displayName", "title", "label", "name")
			if display == id {
				// `name` 在部分网关里就是模型 ID；留空让前端回落到 ID。
				display = ""
			}
			add(id, display,
				firstString(el, "owned_by", "ownedBy", "provider", "owner"),
				contextLengthOf(el), maxOutputTokensOf(el))
		}
	}
	return out
}

// contextLengthOf 从常见的几个字段里取上下文窗口。
func contextLengthOf(el map[string]any) int {
	for _, k := range []string{"context_length", "context_window", "contextWindow", "max_input_tokens"} {
		if n, ok := el[k].(float64); ok && n > 0 {
			return int(n)
		}
		if obj, ok := el[k].(map[string]any); ok {
			if n, ok := obj["default"].(float64); ok && n > 0 {
				return int(n)
			}
		}
	}
	if lim, ok := el["limit"].(map[string]any); ok {
		if n, ok := lim["context"].(float64); ok && n > 0 {
			return int(n)
		}
	}
	return 0
}

// maxOutputTokensOf 从常见的几个字段里取最大输出 token 数。
//
// 各家字段名不统一：OpenAI 风格用 max_tokens / max_completion_tokens，
// 部分中转用 max_output_tokens，OpenRouter 把上限放在 limit.output 或
// top_provider.max_completion_tokens。取第一个正整数。
func maxOutputTokensOf(el map[string]any) int {
	for _, k := range []string{"max_output_tokens", "max_completion_tokens", "max_tokens", "maxTokens"} {
		if n, ok := el[k].(float64); ok && n > 0 {
			return int(n)
		}
	}
	if lim, ok := el["limit"].(map[string]any); ok {
		if n, ok := lim["output"].(float64); ok && n > 0 {
			return int(n)
		}
	}
	if tp, ok := el["top_provider"].(map[string]any); ok {
		if n, ok := tp["max_completion_tokens"].(float64); ok && n > 0 {
			return int(n)
		}
	}
	return 0
}

// findModelsFromMap 处理 `models` 是映射的情况（键为模型 id）。
func findModelsFromMap(m map[string]any) []Model {
	out := make([]Model, 0, len(m))
	for id, meta := range m {
		display := ""
		if obj, ok := meta.(map[string]any); ok {
			display = firstString(obj, "display_name", "displayName", "name")
		}
		if strings.TrimSpace(id) != "" {
			out = append(out, Model{ID: id, Display: display})
		}
	}
	return out
}

func firstString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
