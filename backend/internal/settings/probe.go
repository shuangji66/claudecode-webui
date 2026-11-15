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

// ProbeTimeout 是连通性探测的整体上限。
const ProbeTimeout = 15 * time.Second

// DefaultBaseURL 是未配置 BaseURL 时使用的官方地址。
const DefaultBaseURL = "https://api.anthropic.com"

// ProbeResult 描述一次端点探测的结果。
type ProbeResult struct {
	OK        bool   `json:"ok"`
	Endpoint  string `json:"endpoint"`
	Method    string `json:"method"`
	Status    int    `json:"status"`
	LatencyMs int64  `json:"latency_ms"`
	Detail    string `json:"detail"`
}

// Probe 检查「端点 + 凭据」是否可用。
//
// 优先 GET /v1/models（不消耗 token）；不支持该端点时退回一次
// POST /v1/messages（max_tokens=1，成本可忽略）。401/403 视为鉴权失败直接返回，
// 不再继续尝试，避免把错误凭据反复打到对端。
func Probe(ctx context.Context, v Settings) ProbeResult {
	base := strings.TrimRight(v.BaseURL, "/")
	if base == "" {
		base = DefaultBaseURL
	}
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		return ProbeResult{OK: false, Endpoint: base, Detail: "地址必须以 http:// 或 https:// 开头"}
	}

	start := time.Now()
	client := &http.Client{Timeout: ProbeTimeout}

	// 一、/v1/models
	status, body, err := doJSON(ctx, client, http.MethodGet, base+"/v1/models?limit=1", v, nil)
	if err == nil && status >= 200 && status < 300 {
		return ProbeResult{
			OK: true, Endpoint: base, Method: "GET /v1/models", Status: status,
			LatencyMs: time.Since(start).Milliseconds(),
			Detail:    fmt.Sprintf("端点可用，返回 %d 字节", len(body)),
		}
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return ProbeResult{
			OK: false, Endpoint: base, Method: "GET /v1/models", Status: status,
			LatencyMs: time.Since(start).Milliseconds(),
			Detail:    "鉴权失败：" + snippet(body),
		}
	}

	// 二、退回一次最小请求
	model := v.Model
	if model == "" {
		model = v.SonnetModel
	}
	if model == "" {
		model = "claude-sonnet-4-5"
	}
	payload := map[string]any{
		"model":      model,
		"max_tokens": 1,
		"messages":   []map[string]any{{"role": "user", "content": "ping"}},
	}
	raw, _ := json.Marshal(payload)
	status2, body2, err2 := doJSON(ctx, client, http.MethodPost, base+"/v1/messages", v, raw)
	res := ProbeResult{
		Endpoint: base, Method: "POST /v1/messages", Status: status2,
		LatencyMs: time.Since(start).Milliseconds(),
	}
	switch {
	case err2 != nil:
		res.Detail = "请求失败：" + err2.Error()
		return res
	case status2 >= 200 && status2 < 300:
		res.OK = true
		res.Detail = fmt.Sprintf("端点与凭据均可用于 %s", model)
		return res
	default:
		res.Detail = fmt.Sprintf("模型 %s 调用失败：%s", model, snippet(body2))
		return res
	}
}

// doJSON 发一个请求并读取有限长度的响应体。
func doJSON(ctx context.Context, c *http.Client, method, url string, v Settings, body []byte) (int, []byte, error) {
	return doJSONAuth(ctx, c, method, url, v, body, false)
}

// 响应读取上限。模型列表可能很大（单个模型带 description / modalities 就几百字节），
// 用小上限会导致 JSON 被截断而误报「不是合法 JSON」——这是踩过的坑。
const (
	readLimitSmall  = 4 << 10 // 错误体、探测：够用且省内存
	readLimitModels = 4 << 20 // 模型列表：与 DSH 的 MAX_RESPONSE_BYTES 一致
)

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
// limit 是硬上限；返回 truncated 表示响应确实被截断（调用方据此给出准确提示，
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
	// 多读 1 字节用于判断是否还有剩余内容。
	b, _ := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if int64(len(b)) > limit {
		return resp.StatusCode, b[:limit], true, nil
	}
	return resp.StatusCode, b, false, nil
}

// doJSONHeader 用调用方给定的鉴权头发请求（如 Gemini 的 x-goog-api-key）。
func doJSONHeader(ctx context.Context, c *http.Client, method, url string, v Settings, body []byte, extra map[string]string) (int, []byte, error) {
	st, b, _, err := doJSONHeaderLimit(ctx, c, method, url, v, body, extra, readLimitSmall)
	return st, b, err
}

func doJSONHeaderLimit(ctx context.Context, c *http.Client, method, url string, v Settings, body []byte, extra map[string]string, limit int64) (int, []byte, bool, error) {
	req, err := newRequest(ctx, method, url, body)
	if err != nil {
		return 0, nil, false, err
	}
	for k, val := range extra {
		if val != "" {
			req.Header.Set(k, val)
		}
	}
	return sendRequest(c, req, limit)
}

// doJSONAuth 按 Claude Code 的两种鉴权方式发请求。
// forceBearer=true 时把 APIKey 当作 Bearer 令牌发送（不发送 x-api-key）——
// 不少中转的模型列表只认 Authorization: Bearer，不认 x-api-key。
func doJSONAuth(ctx context.Context, c *http.Client, method, url string, v Settings, body []byte, forceBearer bool) (int, []byte, error) {
	st, b, _, err := doJSONAuthLimit(ctx, c, method, url, v, body, forceBearer, readLimitSmall)
	return st, b, err
}

func doJSONAuthLimit(ctx context.Context, c *http.Client, method, url string, v Settings, body []byte, forceBearer bool, limit int64) (int, []byte, bool, error) {
	req, err := newRequest(ctx, method, url, body)
	if err != nil {
		return 0, nil, false, err
	}
	if forceBearer {
		if v.APIKey != "" {
			req.Header.Set("authorization", "Bearer "+v.APIKey)
		}
	} else {
		if v.APIKey != "" {
			req.Header.Set("x-api-key", v.APIKey)
		}
	}
	if v.AuthToken != "" && !forceBearer {
		req.Header.Set("authorization", "Bearer "+v.AuthToken)
	}
	return sendRequest(c, req, limit)
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

// VerifyModel 用指定模型名发一次最小请求，验证「网关 + 凭据 + 模型名」三者是否可用。
//
// 有些网关压根没有 /v1/models（直接 404），这时用户只能手输模型名，
// 这个接口就是给他确认输入是否正确用的。
func VerifyModel(ctx context.Context, v Settings, model string) ProbeResult {
	base := strings.TrimRight(v.BaseURL, "/")
	if base == "" {
		base = DefaultBaseURL
	}
	res := ProbeResult{Endpoint: base, Method: "POST /v1/messages"}
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		res.Detail = "地址必须以 http:// 或 https:// 开头"
		return res
	}
	if strings.TrimSpace(model) == "" {
		res.Detail = "模型名为空"
		return res
	}

	payload := map[string]any{
		"model":      model,
		"max_tokens": 1,
		"messages":   []map[string]any{{"role": "user", "content": "ping"}},
	}
	raw, _ := json.Marshal(payload)

	start := time.Now()
	client := &http.Client{Timeout: ProbeTimeout}
	status, body, err := doJSON(ctx, client, http.MethodPost, base+"/v1/messages", v, raw)
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
