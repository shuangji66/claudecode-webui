package settings

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	neturl "net/url"
	"strings"
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

// AuthInfo 描述一次请求携带的鉴权方式（只报类型，不含值）。
type AuthInfo struct {
	APIKeySent     bool `json:"api_key_sent"`
	AuthTokenSent  bool `json:"auth_token_sent"`
	BearerFallback bool `json:"bearer_fallback"`
}

// Attempt 是一次探测的记录。
type Attempt struct {
	Path   string `json:"path"`
	Status int    `json:"status"`
	Note   string `json:"note"`
}

// ModelsResult 是拉取模型列表的结果。
type ModelsResult struct {
	Models    []Model   `json:"models"`
	Endpoint  string    `json:"endpoint"`
	Status    int       `json:"status"`
	Detail    string    `json:"detail"`
	Raw       string    `json:"raw,omitempty"`
	Tried     []string  `json:"tried,omitempty"`
	Attempts  []Attempt `json:"attempts,omitempty"`
	Auth      AuthInfo  `json:"auth"`
	Supported bool      `json:"supported"`
}

// ListingURL 拼出模型列表地址：`{root}/v1/models?limit=1000`。
//
// 只有 Anthropic Messages 一种协议，所以规则也只有一条。root 用 ListBaseURL
// 剥过 `/v1`，这里无条件拼 `/v1/models`——用户填 `https://api.anthropic.com/v1`
// 与填 `https://api.anthropic.com` 得到同一个地址。
//
// override 非空时直接用 `{base}{override}`，便于覆盖各家不统一的路径
// （例如中转把列表放在 `/models` 而不是 `/v1/models`）。
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

const rawPreviewBytes = 600

// FetchModels 询问端点「你提供哪些模型」。
//
// 这是尽力而为的便利路径：端点用什么格式作答由它自己决定，
// 拿不到时手动输入模型名效果相同。
func FetchModels(ctx context.Context, p Provider) ModelsResult {
	res := ModelsResult{
		Endpoint:  p.Root(),
		Supported: true,
		Auth:      AuthInfo{APIKeySent: p.APIKey != "", AuthTokenSent: p.AuthToken != ""},
	}
	if !strings.HasPrefix(res.Endpoint, "http://") && !strings.HasPrefix(res.Endpoint, "https://") {
		res.Detail = "地址必须以 http:// 或 https:// 开头"
		return res
	}

	url := ListingURL(p.ListBaseURL(), p.ModelsPath)
	// 展示用路径相对主机根，避免 base 带 /v1 时显示成 /models 而误导排查。
	display := url
	if u, err := neturl.Parse(url); err == nil {
		display = u.Path
		if u.RawQuery != "" {
			display += "?" + u.RawQuery
		}
	}
	res.Tried = []string{display}

	client := proxyClient()
	status, body, truncated, err := doAuth(ctx, client, http.MethodGet, url, p, nil)
	res.Status = status
	attempt := Attempt{Path: display, Status: status}

	switch {
	case err != nil:
		attempt.Note = "请求失败：" + err.Error()
	case status >= 200 && status < 300 && truncated:
		attempt.Note = fmt.Sprintf("响应超过 %d 字节被截断，无法解析", readLimitModels)
	case status >= 200 && status < 300:
		models, perr := parseModels(body)
		switch {
		case perr != nil:
			attempt.Note = "200，但不是模型列表（" + perr.Error() + "）"
		case len(models) == 0:
			attempt.Note = "200，但没有模型条目"
		default:
			attempt.Note = fmt.Sprintf("200，%d 个模型", len(models))
			res.Models = models
			res.Attempts = []Attempt{attempt}
			res.Detail = fmt.Sprintf("共 %d 个模型（%s）", len(models), display)
			return res
		}
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		// 同一把密钥换成 Bearer 再试一次：不少中转只认 Bearer。
		if p.APIKey != "" && p.AuthToken == "" {
			alt := p
			alt.AuthToken = p.APIKey
			alt.APIKey = ""
			if s2, b2, _, e2 := doAuth(ctx, client, http.MethodGet, url, alt, nil); e2 == nil {
				res.Auth.BearerFallback = true
				if models, perr := parseModels(b2); perr == nil && len(models) > 0 {
					attempt.Status = s2
					attempt.Note = fmt.Sprintf("200，%d 个模型（Bearer 鉴权）", len(models))
					res.Models = models
					res.Status = s2
					res.Attempts = []Attempt{attempt}
					res.Detail = fmt.Sprintf("共 %d 个模型（%s，Bearer 鉴权）", len(models), display)
					return res
				}
			}
		}
		attempt.Note = fmt.Sprintf("鉴权失败（HTTP %d）", status)
	case status == http.StatusNotFound:
		attempt.Note = "404（该路径不存在）"
	default:
		attempt.Note = fmt.Sprintf("HTTP %d", status)
	}

	res.Attempts = []Attempt{attempt}
	res.Raw = preview(body)
	res.Detail = fmt.Sprintf("未能获取模型列表（%s → %s）", display, attempt.Note) + hintFor(res.Raw)
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
		return "。网关返回了错误对象，请检查地址、协议与密钥。"
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
