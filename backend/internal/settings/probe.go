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

// stripVersionSuffix 去掉尾部的 `/v1`。
//
// 两个用途共用一个规则，因为它们必须一致：
//   - **列表**：Anthropic 的列表是 `{root}/v1/models`，base 若已带 `/v1` 会拼成
//     `/v1/v1/models`；
//   - **对话**：claude 在 `ANTHROPIC_BASE_URL` 后面自己拼 `/v1/messages`，同样怕
//     `/v1/v1/messages`。
//
// 曾经只有对话剥、列表对 anthropic 不剥，于是「列表拉得到、对话 404」或反过来，
// 取决于用户填的地址带不带 `/v1`。协议归一之后没有理由再分叉。
func stripVersionSuffix(base string) string {
	base = strings.TrimRight(base, "/")
	if strings.HasSuffix(base, "/v1") {
		base = strings.TrimSuffix(base, "/v1")
	}
	return strings.TrimRight(base, "/")
}

// ChatBaseURL 返回**对话**用的基础地址（注入 ANTHROPIC_BASE_URL）。
//
// claude CLI 只会说 Anthropic Messages：它在 baseURL 后面自己拼 `/v1/messages`，
// 所以这里必须去掉用户可能带上的那层 `/v1`。
func (p Provider) ChatBaseURL() string {
	return stripVersionSuffix(p.Root())
}

// ListBaseURL 返回**拉模型列表**用的基础地址。
//
// 与 ChatBaseURL 同一份规则（见 stripVersionSuffix），列表路径再在这之上拼
// `/v1/models`。
func (p Provider) ListBaseURL() string {
	return stripVersionSuffix(p.Root())
}

// Root 返回去掉尾斜杠的地址。
func (p Provider) Root() string {
	base := strings.TrimRight(strings.TrimSpace(p.BaseURL), "/")
	if base == "" {
		base = DefaultBaseURL
	}
	return base
}

// Probe 检查「地址 + 凭据」是否可用。
//
// 先问模型列表（不计费）；拿不到时，用第一个已添加模型发一次
// max_tokens=1 的对话请求。401/403 视为鉴权失败直接返回。
func Probe(ctx context.Context, p Provider) ProbeResult {
	res := ProbeResult{Endpoint: p.Root()}
	if !strings.HasPrefix(res.Endpoint, "http://") && !strings.HasPrefix(res.Endpoint, "https://") {
		res.Detail = "地址必须以 http:// 或 https:// 开头"
		return res
	}

	start := time.Now()
	client := proxyClient()

	url := ListingURL(p.ListBaseURL(), p.ModelsPath)
	status, body, _, err := doAuth(ctx, client, http.MethodGet, url, p, nil)
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
	status, body, _, err = doAuth(ctx, client, http.MethodPost, p.ChatBaseURL()+"/v1/messages", p, payload)
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
	status, body, _, err := doAuth(ctx, client, http.MethodPost, p.ChatBaseURL()+"/v1/messages", p, payload)
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

// doAuth 按 Anthropic Messages 的规则发请求（列表与对话测试共用）。
//
// 两种凭据并存不是二选一：APIKey 走 x-api-key，AuthToken 走 Bearer，
// 同时设置就都发（claude CLI 自己也是这么做的）。不少中转只认 Bearer，
// 那种情况下用户把密钥填到「Bearer 令牌」即可——不再需要按协议切换鉴权方式。
func doAuth(ctx context.Context, c *http.Client, method, url string, p Provider, body []byte) (int, []byte, bool, error) {
	req, err := newRequest(ctx, method, url, body)
	if err != nil {
		return 0, nil, false, err
	}
	if p.APIKey != "" {
		req.Header.Set("x-api-key", p.APIKey)
	}
	if p.AuthToken != "" {
		req.Header.Set("authorization", "Bearer "+p.AuthToken)
	}
	return sendRequest(c, req, readLimitModels)
}

// doAuthSmall 用于错误体等小响应。
func doAuthSmall(ctx context.Context, c *http.Client, method, url string, p Provider, body []byte) (int, []byte, error) {
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
