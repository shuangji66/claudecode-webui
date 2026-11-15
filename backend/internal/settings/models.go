package settings

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
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
}

// modelsPaths 是依次尝试的模型列表路径。
// 绝大多数中转实现 /v1/models；少数只暴露 /models。
var modelsPaths = []string{"/v1/models?limit=1000", "/models?limit=1000", "/v1/models", "/models"}

const rawPreviewBytes = 600

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

	client := &http.Client{Timeout: ProbeTimeout}
	var last ModelsResult

	for _, p := range modelsPaths {
		url := base + p
		res.Tried = append(res.Tried, p)
		status, body, err := doJSON(ctx, client, http.MethodGet, url, v, nil)
		last = ModelsResult{Endpoint: base, Status: status, Tried: res.Tried}

		if err != nil {
			last.Detail = "请求失败：" + err.Error()
			continue
		}
		if status == http.StatusUnauthorized || status == http.StatusForbidden {
			// 常见坑：中转的 /v1/models 只认 Authorization: Bearer，
			// 而我们默认发 x-api-key。这里用同一个密钥换一种方式再试一次。
			if v.APIKey != "" && v.AuthToken == "" {
				status2, body2, err2 := doJSONAuth(ctx, client, http.MethodGet, url, v, nil, true)
				if err2 == nil && status2 >= 200 && status2 < 300 {
					if models, perr := parseModels(body2); perr == nil && len(models) > 0 {
						return ModelsResult{
							Models: models, Endpoint: base, Status: status2,
							Detail: fmt.Sprintf("共 %d 个模型（%s，Bearer 鉴权）", len(models), p),
							Tried:  res.Tried,
						}
					}
				}
				last.Status = status2
				last.Raw = preview(body2)
				last.Detail = fmt.Sprintf("鉴权失败（x-api-key 与 Bearer 均返回 %d/%d）", status, status2)
				return last
			}
			last.Detail = fmt.Sprintf("鉴权失败（HTTP %d）", status)
			last.Raw = preview(body)
			return last
		}
		if status < 200 || status >= 300 {
			last.Detail = fmt.Sprintf("HTTP %d", status)
			last.Raw = preview(body)
			continue
		}

		models, perr := parseModels(body)
		if perr == nil && len(models) > 0 {
			return ModelsResult{
				Models: models, Endpoint: base, Status: status,
				Detail: fmt.Sprintf("共 %d 个模型（%s）", len(models), p),
				Tried:  res.Tried,
			}
		}

		last.Raw = preview(body)
		if perr != nil {
			last.Detail = perr.Error()
		} else {
			last.Detail = "响应里没有找到任何模型条目"
		}
	}

	if last.Detail == "" {
		last.Detail = "未能获取模型列表"
	}
	last.Detail += "。" + hintFor(last.Raw)
	return last
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
