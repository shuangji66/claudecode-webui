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
	// AuthSwitchedTo 非空表示按配置的认证方式被拒（401/403）、换成它才成功。
	// 对话没有重试的机会，界面应当把「认证方式」改成这个值再保存。
	AuthSwitchedTo string `json:"auth_switched_to,omitempty"`
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

// switchAuth 返回「同一把密钥换成另一种发送方式」的副本，以及换成了哪种。
//
// 认证方式选错是最常见的一类 401：密钥是真有效的，只是被放进了另一个请求头。
// 探测路径换一次能直接告诉用户「该用 Bearer」；对话没有这个重试机会——CLI
// 注错环境变量就是整场 401，所以这个结论必须让用户看到并保存下来。
//
// 没填密钥时返回 false：没有东西可以换。
func (p Provider) switchAuth() (Provider, string, bool) {
	if p.APIKey == "" {
		return Provider{}, "", false
	}
	alt := p
	if NormalizeAuth(p.Auth) == AuthBearer {
		alt.Auth = AuthXAPIKey
	} else {
		alt.Auth = AuthBearer
	}
	return alt, alt.Auth, true
}

// authLabel 是认证方式的界面用词。
func authLabel(auth string) string {
	if NormalizeAuth(auth) == AuthBearer {
		return "Bearer"
	}
	return "x-api-key"
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
// 先问模型列表（不计费，按候选路径依次试，见 listingCandidates）；拿不到时，
// 用第一个已添加模型发一次 max_tokens=1 的对话请求。401/403 视为鉴权失败直接返回。
func Probe(ctx context.Context, p Provider) ProbeResult {
	res := ProbeResult{Endpoint: p.Root()}
	if !strings.HasPrefix(res.Endpoint, "http://") && !strings.HasPrefix(res.Endpoint, "https://") {
		res.Detail = "地址必须以 http:// 或 https:// 开头"
		return res
	}

	start := time.Now()
	client := proxyClient()

	out := listModels(ctx, client, p)
	res.Method = "GET " + out.path
	res.Status = out.status
	res.LatencyMs = time.Since(start).Milliseconds()
	if len(out.models) > 0 {
		res.OK = true
		res.Detail = fmt.Sprintf("端点可用，返回 %d 个模型", len(out.models))
		if out.authSwitched != "" {
			res.AuthSwitchedTo = out.authSwitched
			res.Detail = fmt.Sprintf("端点可用，返回 %d 个模型（%s 认证）", len(out.models), authLabel(out.authSwitched))
		}
		return res
	}
	if out.deadline {
		res.Detail = "探测超时，还有路径没试完；请检查网络与代理设置"
		return res
	}
	if out.netFailed {
		// 列表这一步每条候选都栽在网络层：地址/网络/代理就是原因，
		// 不必再发一次注定一样的对话请求。
		res.Detail = "请求失败：" + out.lastNetErr.Error()
		return res
	}
	if out.allAuthRejected {
		// 每一条候选都回了 401/403，且换头也没救回来（listModels 已经试过）：
		// 这才是真的鉴权失败，不再往下发一次注定 401 的对话请求。
		// 只判「有一条 401」是不行的——路径不存在也可能回 401，而别的路径是 404，
		// 那时结论是「不知道列表在哪」，交给下面的对话探测回答「地址+凭据」。
		res.Detail = "鉴权失败：" + snippet(out.body)
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
	status, body, _, err := doAuth(ctx, client, http.MethodPost, p.ChatBaseURL()+"/v1/messages", p, payload)
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
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		// 与 Probe / FetchModels 同一条诊断：认证方式选错时换个头再试一次，
		// 结论带回给界面，避免「测试连接说要用 Bearer、这里却说密钥无效」。
		if alt, header, ok := p.switchAuth(); ok {
			if s2, _, _, e2 := doAuth(ctx, client, http.MethodPost, p.ChatBaseURL()+"/v1/messages", alt, payload); e2 == nil && s2 >= 200 && s2 < 300 {
				res.OK = true
				res.Status = s2
				res.AuthSwitchedTo = header
				res.Detail = fmt.Sprintf("模型 %s 可用（%s 认证）", model, authLabel(header))
				return res
			}
		}
		res.Detail = fmt.Sprintf("模型 %s 不可用：%s", model, snippet(body))
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

// doAuth 按 Anthropic Messages 的规则发请求（列表、测试连接与模型验证共用）。
//
// 只发配置的那一种头：同一把密钥同时塞进 x-api-key 与 Authorization 会让
// 「认证方式」这个选择失去意义，也与对话路径不一致——对话按 Auth 只注入一个
// 环境变量，CLI 只发一个头。
func doAuth(ctx context.Context, c *http.Client, method, url string, p Provider, body []byte) (int, []byte, bool, error) {
	req, err := newRequest(ctx, method, url, body)
	if err != nil {
		return 0, nil, false, err
	}
	if p.APIKey != "" {
		if NormalizeAuth(p.Auth) == AuthBearer {
			req.Header.Set("authorization", "Bearer "+p.APIKey)
		} else {
			req.Header.Set("x-api-key", p.APIKey)
		}
	}
	return sendRequest(c, req, readLimitModels)
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
