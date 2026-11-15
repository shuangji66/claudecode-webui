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
	Protocol  string    `json:"protocol"`
	Status    int       `json:"status"`
	Detail    string    `json:"detail"`
	Raw       string    `json:"raw,omitempty"`
	Tried     []string  `json:"tried,omitempty"`
	Attempts  []Attempt `json:"attempts,omitempty"`
	Auth      AuthInfo  `json:"auth"`
	Supported bool      `json:"supported"`
}

// 协议常量，与 DSH 的命名保持一致。
const (
	ProtocolAnthropic = "anthropic-messages"
	ProtocolOpenAI    = "openai-completions"
	ProtocolResponses = "openai-responses"
	ProtocolGemini    = "google-generative-ai"
)

// listableProtocols 是支持自动获取模型列表的协议。
// 其它协议（Azure、Codex OAuth 等）直接提示手动录入，避免把鉴权失败误报成「没有模型」。
var listableProtocols = map[string]bool{
	ProtocolAnthropic: true,
	ProtocolOpenAI:    true,
	ProtocolResponses: true,
	ProtocolGemini:    true,
}

// APIProtocol 返回生效的协议（未配置时用 Anthropic Messages）。
func (v Settings) APIProtocolOrDefault() string {
	if p := strings.TrimSpace(v.APIProtocol); p != "" {
		return p
	}
	return DefaultAPIProtocol
}

// ListingURL 按协议拼出模型列表地址。
//
// 规则与 DSH 的 discovery 保持一致：
//   - anthropic-messages：`{root}/v1/models?limit=1000`，root 是 base 去掉尾部斜杠、
//     再去掉一层尾部 `/v1`（网关文档两种写法都有，只有列表地址做这个归一化）。
//   - openai-completions / openai-responses：`{base}/models`（base 已含 `/v1`）。
//   - google-generative-ai：`{base}/models?pageSize=1000`（base 已含 API 版本）。
func ListingURL(baseURL, protocol string) string {
	base := strings.TrimRight(baseURL, "/")
	switch protocol {
	case ProtocolGemini:
		return base + "/models?pageSize=1000"
	case ProtocolAnthropic:
		root := base
		if strings.HasSuffix(root, "/v1") {
			root = strings.TrimSuffix(root, "/v1")
		}
		return root + "/v1/models?limit=1000"
	default:
		return base + "/models"
	}
}

// authKind 决定用哪种鉴权头。
func authKind(protocol string) string {
	switch protocol {
	case ProtocolGemini:
		return "google"
	case ProtocolAnthropic:
		return "anthropic"
	default:
		return "bearer"
	}
}

const rawPreviewBytes = 600

// FetchModels 按配置的协议询问端点「你提供哪些模型」。
//
// 这是一条**尽力而为**的便利路径：端点用什么格式作答由它自己决定，
// 拿不到时手动填写模型名效果完全一样（DSH 的文档也是这么说的）。
func FetchModels(ctx context.Context, v Settings) ModelsResult {
	protocol := v.APIProtocolOrDefault()
	res := ModelsResult{
		Protocol:  protocol,
		Supported: listableProtocols[protocol],
		Auth:      AuthInfo{APIKeySent: v.APIKey != "", AuthTokenSent: v.AuthToken != ""},
	}

	base := strings.TrimRight(v.BaseURL, "/")
	if base == "" {
		base = DefaultBaseURL
	}
	res.Endpoint = base
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		res.Detail = "地址必须以 http:// 或 https:// 开头"
		return res
	}

	// 手动指定路径时优先（便于覆盖协议默认规则）。
	var url string
	if p := strings.TrimSpace(v.ModelsPath); p != "" {
		if !strings.HasPrefix(p, "/") {
			p = "/" + p
		}
		url = base + p
	} else if res.Supported {
		url = ListingURL(base, protocol)
	} else {
		res.Detail = fmt.Sprintf("协议 %s 不支持自动获取模型列表，请手动填写模型名", protocol)
		return res
	}

	// 展示用路径相对于主机根，而不是相对 base —— 否则 base 带 /v1 时
	// 界面会显示 /models，与真实请求地址对不上，排查时会误导。
	display := url
	if u, err := neturl.Parse(url); err == nil {
		display = u.Path
		if u.RawQuery != "" {
			display += "?" + u.RawQuery
		}
	}
	res.Tried = []string{display}

	client := &http.Client{Timeout: ProbeTimeout}
	status, body, err := doAuth(ctx, client, http.MethodGet, url, v, nil, authKind(protocol))
	res.Status = status
	attempt := Attempt{Path: display, Status: status}

	switch {
	case err != nil:
		attempt.Note = "请求失败：" + err.Error()
	case status >= 200 && status < 300:
		models, perr := parseModels(body)
		if perr != nil {
			attempt.Note = "200，但不是模型列表（" + perr.Error() + "）"
		} else if len(models) == 0 {
			attempt.Note = "200，但没有模型条目"
		} else {
			attempt.Note = fmt.Sprintf("200，%d 个模型", len(models))
			res.Models = models
			res.Attempts = []Attempt{attempt}
			res.Raw = ""
			res.Detail = fmt.Sprintf("共 %d 个模型（%s，%s）", len(models), display, protocol)
			return res
		}
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		// 同一把密钥换成 Bearer 再试一次：不少中转只认 Bearer。
		if v.APIKey != "" && v.AuthToken == "" && protocol != ProtocolGemini {
			if s2, b2, e2 := doAuth(ctx, client, http.MethodGet, url, v, nil, "bearer"); e2 == nil {
				res.Auth.BearerFallback = true
				if models, perr := parseModels(b2); perr == nil && len(models) > 0 {
					attempt.Status = s2
					attempt.Note = fmt.Sprintf("200，%d 个模型（Bearer 鉴权）", len(models))
					res.Models = models
					res.Status = s2
					res.Attempts = []Attempt{attempt}
					res.Detail = fmt.Sprintf("共 %d 个模型（%s，%s，Bearer 鉴权）", len(models), display, protocol)
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

// doAuth 按指定的鉴权方式发请求。
func doAuth(ctx context.Context, c *http.Client, method, url string, v Settings, body []byte, kind string) (int, []byte, error) {
	switch kind {
	case "bearer":
		cp := v
		cp.AuthToken = firstNonEmpty(v.AuthToken, v.APIKey)
		cp.APIKey = ""
		return doJSONAuth(ctx, c, method, url, cp, body, false)
	case "google":
		cp := v
		cp.APIKey = ""
		cp.AuthToken = ""
		return doJSONHeader(ctx, c, method, url, cp, body, map[string]string{"x-goog-api-key": firstNonEmpty(v.APIKey, v.AuthToken)})
	default:
		return doJSONAuth(ctx, c, method, url, v, body, false)
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
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

// parseModels 解析模型列表。
//
// 支持 DSH 文档提到的两种形态以及 Gemini：
//   - `data` 数组（OpenAI / Anthropic 标准）
//   - `models` 映射或数组（部分兼容网关的「富」格式）
//   - Gemini 的 `models` 数组，条目 `name` 形如 `models/gemini-x`
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
		// 常见键优先；`models` 既可能是数组，也可能是 id→元数据的映射。
		for _, k := range []string{"data", "models", "model_list", "modelList", "items", "list", "result", "results"} {
			child, ok := t[k]
			if !ok {
				continue
			}
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
	add := func(id, display, owned string) {
		id = strings.TrimSuffix(strings.TrimSpace(id), "/")
		// Gemini 的条目名形如 models/gemini-1.5-pro，对外只留模型名。
		if i := strings.LastIndex(id, "/"); i >= 0 {
			id = id[i+1:]
		}
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

// findModelsFromMap 处理 `models` 是映射的情况（键为模型 id）。
func findModelsFromMap(m map[string]any) []Model {
	out := make([]Model, 0, len(m))
	for id, meta := range m {
		display := ""
		if obj, ok := meta.(map[string]any); ok {
			display = firstString(obj, "display_name", "displayName", "name")
		}
		if id != "" {
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

// BuiltinAliases 是 Claude Code 内置的模型别名，也是「伪装」的目标槽位。
var BuiltinAliases = []string{"default", "opus", "sonnet", "haiku"}

// ResolveAlias 返回某个别名当前会被解析到的网关模型（空表示未映射）。
func (v Settings) ResolveAlias(alias string) string {
	switch alias {
	case "default":
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
