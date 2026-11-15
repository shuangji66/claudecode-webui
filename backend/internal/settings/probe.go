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
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, rdr)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("anthropic-version", "2023-06-01")
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	// 两种鉴权方式二选一：官方用 x-api-key，部分中转只认 Bearer。
	if v.APIKey != "" {
		req.Header.Set("x-api-key", v.APIKey)
	}
	if v.AuthToken != "" {
		req.Header.Set("authorization", "Bearer "+v.AuthToken)
	}

	resp, err := c.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	return resp.StatusCode, b, nil
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
