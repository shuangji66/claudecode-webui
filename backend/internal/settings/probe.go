package settings

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ProbeTimeout 是连接测试的整体上限。
const ProbeTimeout = 15 * time.Second

// DefaultBaseURL 是未配置地址时使用的官方地址。
const DefaultBaseURL = "https://api.anthropic.com"

// 响应读取上限。模型列表可能很大（单个模型带 description / modalities 就几百字节），
// 用小上限会导致 JSON 被截断而误报「不是合法 JSON」——这是踩过的坑。
const (
	readLimitSmall  = 4 << 10
	readLimitModels = 4 << 20
)

// ProbeResult 描述一次端点探测的结果。
type ProbeResult struct {
	OK        bool   `json:"ok"`
	Endpoint  string `json:"endpoint"`
	Method    string `json:"method"`
	Status    int    `json:"status"`
	LatencyMs int64  `json:"latency_ms"`
	Detail    string `json:"detail"`
}

// 协议是否支持自动获取模型列表。
var listableProtocols = map[string]bool{
	ProtocolAnthropic: true,
	ProtocolOpenAI:    true,
	ProtocolResponses: true,
	ProtocolGemini:    true,
}

// ProtocolOrDefault 返回生效的协议。
func (p Provider) ProtocolOrDefault() string {
	if v := strings.TrimSpace(p.Protocol); v != "" {
		return v
	}
	return DefaultAPIProtocol
}

// ChatBaseURL 返回**对话**用的基础地址。
//
// claude CLI 只会说 Anthropic Messages：它在 baseURL 后面自己拼 `/v1/messages`。
// 而 OpenAI / Gemini 协议的 base 习惯上带 `/v1`（列表地址是 `{base}/models`），
// 两者直接共用会拼成 `/v1/v1/messages` → 404。
// 因此非 Anthropic 协议要剥掉这层 `/v1`；Anthropic 协议按用户填的原样使用。
func (p Provider) ChatBaseURL() string {
	base := p.Root()
	if p.ProtocolOrDefault() != ProtocolAnthropic {
		base = strings.TrimSuffix(base, "/v1")
		base = strings.TrimRight(base, "/")
	}
	return base
}

// Root 返回去掉尾斜杠的地址。
func (p Provider) Root() string {
	base := strings.TrimRight(strings.TrimSpace(p.BaseURL), "/")
	if base == "" {
		base = DefaultBaseURL
	}
	return base
}

// Probe 检查「地址 + 协议 + 凭据」是否可用。
//
// 先问模型列表（不计费）；不支持或失败时，用第一个已添加模型发一次
// max_tokens=1 的请求。401/403 视为鉴权失败直接返回。
func Probe(ctx context.Context, p Provider) ProbeResult {
	res := ProbeResult{Endpoint: p.Root()}
	if !strings.HasPrefix(res.Endpoint, "http://") && !strings.HasPrefix(res.Endpoint, "https://") {
		res.Detail = "地址必须以 http:// 或 https:// 开头"
		return res
	}

	start := time.Now()
	client := &http.Client{Timeout: ProbeTimeout}
	protocol := p.ProtocolOrDefault()

	if listableProtocols[protocol] {
		url := ListingURL(p.Root(), protocol, p.ModelsPath)
		status, body, _, err := doAuth(ctx, client, http.MethodGet, url, p, nil, authKind(protocol))
		res.Method = "GET " + url
		res.Status = status
		res.LatencyMs = time.Since(start).Milliseconds()
		switch {
		case err != nil:
			res.Detail = "请求失败：" + err.Error()
			return res
		case status >= 200 && status < 300:
			if models, perr := parseModels(body); perr == nil && len(models) > 0 {
				res.OK = true
				res.Detail = fmt.Sprintf("端点可用，返回 %d 个模型", len(models))
				return res
			}
		case status == http.StatusUnauthorized || status == http.StatusForbidden:
			res.Detail = "鉴权失败：" + snippet(body)
			return res
		}
	}

	// 退回一次最小对话请求
	model := ""
	if len(p.Models) > 0 {
		model = p.Models[0]
	}
	if model == "" {
		model = "claude-sonnet-4-5"
	}
	payload, _ := json.Marshal(map[string]any{
		"model":      model,
		"max_tokens": 1,
		"messages":   []map[string]any{{"role": "user", "content": "ping"}},
	})
	status, body, _, err := doAuth(ctx, client, http.MethodPost, p.Root()+"/v1/messages", p, payload, authKind(protocol))
	res.Method = "POST /v1/messages"
	res.Status = status
	res.LatencyMs = time.Since(start).Milliseconds()
	switch {
	case err != nil:
		res.Detail = "请求失败：" + err.Error()
	case status >= 200 && status < 300:
		res.OK = true
		res.Detail = fmt.Sprintf("端点与凭据可用（模型 %s）", model)
	default:
		res.Detail = fmt.Sprintf("模型 %s 调用失败：%s", model, snippet(body))
	}
	return res
}

// VerifyModel 用指定模型名发一次最小请求，确认「地址 + 凭据 + 模型名」可用。
func VerifyModel(ctx context.Context, p Provider, model string) ProbeResult {
	res := ProbeResult{Endpoint: p.Root(), Method: "POST /v1/messages"}
	if !strings.HasPrefix(res.Endpoint, "http://") && !strings.HasPrefix(res.Endpoint, "https://") {
		res.Detail = "地址必须以 http:// 或 https:// 开头"
		return res
	}
	if strings.TrimSpace(model) == "" {
		res.Detail = "模型名为空"
		return res
	}

	payload, _ := json.Marshal(map[string]any{
		"model":      model,
		"max_tokens": 1,
		"messages":   []map[string]any{{"role": "user", "content": "ping"}},
	})
	start := time.Now()
	client := &http.Client{Timeout: ProbeTimeout}
	status, body, _, err := doAuth(ctx, client, http.MethodPost, p.Root()+"/v1/messages", p, payload, authKind(p.ProtocolOrDefault()))
	res.Status = status
	res.LatencyMs = time.Since(start).Milliseconds()
	switch {
	case err != nil:
		res.Detail = "请求失败：" + err.Error()
	case status >= 200 && status < 300:
		res.OK = true
		res.Detail = "模型 " + model + " 可用"
	default:
		res.Detail = fmt.Sprintf("模型 %s 不可用：%s", model, snippet(body))
	}
	return res
}

// newRequest 构造一个带通用头的请求。
func newRequest(ctx context.Context, method, url string, body []byte) (*http.Request, error) {
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("anthropic-version", "2023-06-01")
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	return req, nil
}

// sendRequest 发出请求并读取响应体。
// limit 是硬上限；truncated 表示响应确实被截断（调用方据此给出准确提示，
// 而不是把「截断导致的解析失败」说成「不是合法 JSON」）。
func sendRequest(c *http.Client, req *http.Request, limit int64) (int, []byte, bool, error) {
	resp, err := c.Do(req)
	if err != nil {
		return 0, nil, false, err
	}
	defer resp.Body.Close()
	if limit <= 0 {
		limit = readLimitSmall
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if int64(len(b)) > limit {
		return resp.StatusCode, b[:limit], true, nil
	}
	return resp.StatusCode, b, false, nil
}

// doAuth 按指定鉴权方式发请求（同时用于列表与对话测试）。
func doAuth(ctx context.Context, c *http.Client, method, url string, p Provider, body []byte, kind string) (int, []byte, bool, error) {
	req, err := newRequest(ctx, method, url, body)
	if err != nil {
		return 0, nil, false, err
	}
	switch kind {
	case "bearer":
		key := firstNonEmpty(p.AuthToken, p.APIKey)
		if key != "" {
			req.Header.Set("authorization", "Bearer "+key)
		}
	case "google":
		key := firstNonEmpty(p.APIKey, p.AuthToken)
		if key != "" {
			req.Header.Set("x-goog-api-key", key)
		}
	case "anthropic":
		if p.APIKey != "" {
			req.Header.Set("x-api-key", p.APIKey)
		}
		if p.AuthToken != "" {
			req.Header.Set("authorization", "Bearer "+p.AuthToken)
		}
	default:
		if p.APIKey != "" {
			req.Header.Set("x-api-key", p.APIKey)
		}
	}
	return sendRequest(c, req, readLimitModels)
}

// doAuthSmall 用于错误体等小响应。
func doAuthSmall(ctx context.Context, c *http.Client, method, url string, p Provider, body []byte, kind string) (int, []byte, error) {
	req, err := newRequest(ctx, method, url, body)
	if err != nil {
		return 0, nil, err
	}
	if p.APIKey != "" {
		req.Header.Set("x-api-key", p.APIKey)
	}
	if p.AuthToken != "" {
		req.Header.Set("authorization", "Bearer "+p.AuthToken)
	}
	st, b, _, err := sendRequest(c, req, readLimitSmall)
	return st, b, err
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > 200 {
		s = s[:200] + "…"
	}
	if s == "" {
		s = "（无响应体）"
	}
	return s
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
