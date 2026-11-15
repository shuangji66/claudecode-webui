package settings

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Model 是网关 /v1/models 返回的一个模型条目。
type Model struct {
	ID      string `json:"id"`
	Display string `json:"display_name,omitempty"`
	OwnedBy string `json:"owned_by,omitempty"`
}

// ModelsResult 是拉取模型列表的结果。
type ModelsResult struct {
	Models   []Model `json:"models"`
	Endpoint string  `json:"endpoint"`
	Status   int     `json:"status"`
	// Detail 是人类可读的结果说明（失败时包含原因）。
	Detail string `json:"detail"`
	// Raw 是响应体前若干字节，解析失败时回显给用户，便于判断网关到底返回了什么
	// （常见情况：网关没实现 /v1/models，转而返回了一个 HTML 页面）。
	Raw string `json:"raw,omitempty"`
	// Tried 记录尝试过的路径，避免用户以为只试了一个。
	Tried []string `json:"tried,omitempty"`
	// Attempts 是每个候选路径的探测结果，供前端列表展示。
	Attempts []Attempt `json:"attempts,omitempty"`
}

// Attempt 是一次路径探测的结果。
type Attempt struct {
	Path   string `json:"path"`
	Status int    `json:"status"`
	Note   string `json:"note"`
}

// autoModelPaths 是自动探测时依次尝试的路径。
//
// 各中转实现差异极大：Anthropic 兼容层一般是 /v1/models，但不少「Claude Code 专用」
// 代理只转发 /v1/messages，模型列表放在自己的管理接口下（/api/models 等）。
// 实测遇到过所有标准路径都 404、而列表其实在别的路径上的情况，所以这里放宽候选。
var autoModelPaths = []string{
	"/v1/models",
	"/models",
	"/api/models",
	"/api/v1/models",
	"/v1/model/list",
	"/v1/models/list",
	"/model/list",
	"/openai/v1/models",
}

const rawPreviewBytes = 600

// perPathTimeout 是自动探测单个候选路径的超时。
// 404 之类会立刻返回，这个上限只用于兜住「连接挂住」的情况。
const perPathTimeout = 4 * time.Second

// FetchModels 用给定配置向网关拉取模型列表。
//
// 各家「Anthropic 兼容」实现差别很大：路径、外层结构、字段名都不统一，甚至
// 根本没实现这个端点（返回 HTML 或 404）。因此这里：
//   - 依次尝试多个路径；
//   - 递归查找「看起来像模型数组」的节点，不假定固定外层键；
//   - 失败时把原始响应片段带回前端，让用户能判断原因。
func FetchModels(ctx context.Context, v Settings) ModelsResult {
	base := strings.TrimRight(v.BaseURL, "/")
	if base == "" {
		base = DefaultBaseURL
	}
	res := ModelsResult{Endpoint: base}
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		res.Detail = "地址必须以 http:// 或 https:// 开头"
		return res
	}

	// 用户显式指定了路径 → 只试它；否则按候选表自动探测。
	paths := autoModelPaths
	if p := strings.TrimSpace(v.ModelsPath); p != "" {
		if !strings.HasPrefix(p, "/") {
			p = "/" + p
		}
		paths = []string{p}
	}

	var lastBody []byte
	for _, p := range paths {
		res.Tried = append(res.Tried, p)
		body, attempt, models := fetchOnePath(ctx, base, p, v)
		res.Attempts = append(res.Attempts, attempt)
		if len(models) > 0 {
			return ModelsResult{
				Models: models, Endpoint: base, Status: attempt.Status,
				Detail: successDetail(len(models), p, attempt.Note),
				Tried:  res.Tried, Attempts: res.Attempts,
			}
		}
		if body != nil {
			lastBody = body
		}
	}

	res.Status = 0
	if n := len(res.Attempts); n > 0 {
		res.Status = res.Attempts[n-1].Status
	}
	res.Raw = preview(lastBody)
	res.Detail = summarizeAttempts(res.Attempts) + hintFor(res.Raw)
	return res
}

// fetchOnePath 探测单个路径。返回原始响应体、探测记录与解析出的模型。
func fetchOnePath(ctx context.Context, base, path string, v Settings) ([]byte, Attempt, []Model) {
	attempt := Attempt{Path: path}
	pctx, cancel := context.WithTimeout(ctx, perPathTimeout)
	defer cancel()

	client := &http.Client{Timeout: perPathTimeout}
	status, body, err := doJSON(pctx, client, http.MethodGet, base+path, v, nil)
	attempt.Status = status
	switch {
	case err != nil:
		attempt.Note = "请求失败：" + err.Error()
		return body, attempt, nil
	case status == http.StatusNotFound:
		attempt.Note = "404（该路径不存在）"
		return body, attempt, nil
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		// 很多中转的这个端点只认 Authorization: Bearer，换一种方式再试一次。
		if v.APIKey != "" && v.AuthToken == "" {
			s2, b2, e2 := doJSONAuth(pctx, client, http.MethodGet, base+path, v, nil, true)
			if e2 == nil {
				if models, perr := parseModels(b2); perr == nil && len(models) > 0 {
					attempt.Status = s2
					attempt.Note = "200，Bearer 鉴权"
					return b2, attempt, models
				}
			}
			attempt.Note = fmt.Sprintf("鉴权失败（%d / Bearer %d）", status, s2)
			return b2, attempt, nil
		}
		attempt.Note = fmt.Sprintf("鉴权失败（HTTP %d）", status)
		return body, attempt, nil
	case status < 200 || status >= 300:
		attempt.Note = fmt.Sprintf("HTTP %d", status)
		return body, attempt, nil
	}

	models, perr := parseModels(body)
	if perr != nil {
		attempt.Note = "200，但不是模型列表（" + perr.Error() + "）"
		return body, attempt, nil
	}
	if len(models) == 0 {
		attempt.Note = "200，但没有模型条目"
		return body, attempt, nil
	}
	attempt.Note = fmt.Sprintf("200，%d 个模型", len(models))
	return body, attempt, models
}

// successDetail 生成成功时的说明；用了 Bearer 重试就点明，避免用户以为没生效。
func successDetail(n int, path, note string) string {
	d := fmt.Sprintf("共 %d 个模型（%s）", n, path)
	if strings.Contains(note, "Bearer") {
		d += "，Bearer 鉴权"
	}
	return d
}

// summarizeAttempts 把探测结果压成一句能直接读的结论。
func summarizeAttempts(attempts []Attempt) string {
	if len(attempts) == 0 {
		return "未尝试任何路径"
	}
	notFound, authFail := 0, 0
	for _, a := range attempts {
		if a.Status == http.StatusNotFound {
			notFound++
		}
		if a.Status == http.StatusUnauthorized || a.Status == http.StatusForbidden {
			authFail++
		}
	}
	switch {
	case authFail > 0:
		return "鉴权失败：所有路径都返回 401/403，请检查密钥或鉴权方式"
	case notFound == len(attempts):
		return fmt.Sprintf("尝试的 %d 个路径全部 404：该网关没有在这些路径上暴露模型列表", len(attempts))
	default:
		return fmt.Sprintf("尝试了 %d 个路径，均未拿到模型列表", len(attempts))
	}
}

// hintFor 依据原始响应给出下一步提示。
func hintFor(raw string) string {
	low := strings.ToLower(strings.TrimSpace(raw))
	switch {
	case low == "":
		return "响应体为空，该网关可能未实现模型列表接口，可直接在下方手动填写模型名。"
	case strings.HasPrefix(low, "<!doctype") || strings.HasPrefix(low, "<html"):
		return "返回的是 HTML 页面（多半是该网关没有 /v1/models，被前端路由兜底了），请手动填写模型名。"
	case strings.Contains(low, "\"error\""):
		return "网关返回了错误对象，请检查地址与密钥。"
	default:
		return "可直接在下方手动填写模型名。"
	}
}

// preview 截取响应体用于回显，去掉换行便于在窄屏显示。
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
func parseModels(body []byte) ([]Model, error) {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return nil, fmt.Errorf("响应体为空")
	}
	var root any
	if err := json.Unmarshal(body, &root); err != nil {
		return nil, fmt.Errorf("响应不是合法 JSON")
	}
	if ms := findModels(root, 0); len(ms) > 0 {
		return ms, nil
	}
	return nil, fmt.Errorf("JSON 里没有可识别的模型数组")
}

// maxWalkDepth 限制递归深度，避免恶意/异常结构导致深递归。
const maxWalkDepth = 6

// findModels 深度优先寻找第一个能解析出模型的节点。
// 优先看常见键名，再兜底遍历所有成员。
func findModels(v any, depth int) []Model {
	if depth > maxWalkDepth {
		return nil
	}
	switch t := v.(type) {
	case []any:
		if ms := decodeItems(t); len(ms) > 0 {
			return ms
		}
		// 数组元素本身也可能是容器（如 [[{...}]]）
		for _, item := range t {
			if ms := findModels(item, depth+1); len(ms) > 0 {
				return ms
			}
		}
	case map[string]any:
		for _, k := range []string{"data", "models", "model_list", "modelList", "items", "list", "result", "results"} {
			if child, ok := t[k]; ok {
				if ms := findModels(child, depth+1); len(ms) > 0 {
					return ms
				}
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

// decodeItems 把数组元素解析成 Model；元素可以是对象，也可以直接是字符串。
func decodeItems(items []any) []Model {
	out := make([]Model, 0, len(items))
	seen := make(map[string]bool, len(items))
	add := func(id, display, owned string) {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		out = append(out, Model{ID: id, Display: display, OwnedBy: owned})
	}

	for _, item := range items {
		switch el := item.(type) {
		case string:
			add(el, "", "")
		case map[string]any:
			id := firstString(el, "id", "name", "model", "model_id", "modelId", "slug")
			if id == "" {
				// 有些实现把标识放在 data.id 或 model.id 里
				if inner, ok := el["data"].(map[string]any); ok {
					id = firstString(inner, "id", "name", "model")
				}
			}
			if id == "" {
				continue
			}
			add(id,
				firstString(el, "display_name", "displayName", "title", "label", "description"),
				firstString(el, "owned_by", "ownedBy", "provider", "owner"))
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

// BuiltinAliases 是 Claude Code 内置的模型别名，也是「伪装」的目标槽位。
//
// 说明：`default` 不是模型，它表示「不指定」，会解析到 opus 槽位；
// 因此映射 default 的实际手段是设置 ANTHROPIC_MODEL。
var BuiltinAliases = []string{"default", "opus", "sonnet", "haiku"}

// ResolveAlias 返回某个别名当前会被解析到的网关模型（空表示未映射）。
func (v Settings) ResolveAlias(alias string) string {
	switch alias {
	case "default":
		// 未显式映射时，default 跟随 opus 槽位（与 CLI 行为一致）。
		if v.Model != "" {
			return v.Model
		}
		return v.OpusModel
	case "opus":
		return v.OpusModel
	case "sonnet":
		return v.SonnetModel
	case "haiku":
		return v.HaikuModel
	}
	return ""
}
