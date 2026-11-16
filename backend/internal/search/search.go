// Package search 是 DeepSeek Search / Fetch API 的客户端。
//
// 接口形状与 DSH 的 deepseek-search-api / deepseek-fetch-api 一致（一次请求，
// 不经过模型回合）：
//
//	POST {base}/search  {"query": "...", "count": 10, "need_content": false}
//	  → {"results": [{"title","url","snippet","summary","date"}]}
//	POST {base}/fetch   {"url": "https://..."}
//	  → 页面 Markdown（text/plain；抓不到内容时 API 回错误状态）
//
// base 默认是 DeepSeek 官方的 https://api.deepseek.com/v1/tools，可指向自建网关
// （路径前缀要带全，不含 /search、/fetch）。认证用 Authorization: Bearer <key>，
// 与对话用的密钥分开——搜索能力单独计费，不能默认套用对话密钥。
//
// 本包只做 HTTP 客户端，不认识 MCP，也不读设置（由调用方传 base/key 进来）。
package search

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"ccweb/backend/internal/netproxy"
)

// DefaultBaseURL 是 DeepSeek 官方 Search / Fetch API 的基地址。
const DefaultBaseURL = "https://api.deepseek.com/v1/tools"

// DefaultCount / MinCount / MaxCount 与 API 的限制一致（1..50）。
const (
	DefaultCount = 10
	MinCount     = 1
	MaxCount     = 50
)

// 单次请求的预算：搜索是同步调用，等待过久只会让主对话干等。
const timeout = 20 * time.Second

// 响应体上限：正常结果几十 KB，防的是被网关换成一个巨型页面。
const maxBody = 4 << 20

var (
	// ErrNoKey 表示没有配置搜索密钥。
	ErrNoKey = errors.New("search: 未配置搜索密钥")
	// ErrBadBase 表示基地址不是 http(s)。
	ErrBadBase = errors.New("search: 基地址必须是 http(s)")
)

// Result 是一条搜索结果。
type Result struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet,omitempty"`
	Summary string `json:"summary,omitempty"`
	Date    string `json:"date,omitempty"`
}

// SearchResponse 是 /search 的返回（只取用得到的字段）。
type SearchResponse struct {
	Results []Result `json:"results"`
}

var (
	proxyMu  sync.RWMutex
	proxyNow = func() string { return "" }
)

// SetProxySource 接上「当前代理」的取值函数。
//
// 搜索是面板/内置 MCP 服务自己发出的出站请求，不会自动继承设置里的代理
// （Go 的 http.ProxyFromEnvironment 只读进程启动时的环境变量）。
func SetProxySource(f func() string) {
	if f == nil {
		return
	}
	proxyMu.Lock()
	proxyNow = f
	proxyMu.Unlock()
}

func currentProxy() string {
	proxyMu.RLock()
	defer proxyMu.RUnlock()
	return proxyNow()
}

func client() *http.Client {
	return &http.Client{
		Timeout:   timeout,
		Transport: &http.Transport{Proxy: netproxy.Func(currentProxy())},
	}
}

// NormalizeBase 校验并规范化基地址（去掉尾部斜杠）。
func NormalizeBase(raw string) (string, error) {
	b := strings.TrimSpace(raw)
	if b == "" {
		b = DefaultBaseURL
	}
	u, err := url.Parse(b)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", ErrBadBase
	}
	return strings.TrimRight(b, "/"), nil
}

// ClampCount 把结果数夹到 API 允许的范围。
func ClampCount(n int) int {
	if n <= 0 {
		return DefaultCount
	}
	if n < MinCount {
		return MinCount
	}
	if n > MaxCount {
		return MaxCount
	}
	return n
}

// Search 执行一次搜索。
func Search(ctx context.Context, base, key, query string, count int) ([]Result, error) {
	norm, err := NormalizeBase(base)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(key) == "" {
		return nil, ErrNoKey
	}
	q := strings.TrimSpace(query)
	if q == "" {
		return nil, errors.New("search: 查询不能为空")
	}
	body, _ := json.Marshal(map[string]any{
		"query": q,
		"count": ClampCount(count),
		// 不要正文：正文由 web_fetch 按需取，一次搜索塞满页面会把上下文烧光。
		"need_content": false,
	})
	var out SearchResponse
	if err := postJSON(ctx, norm+"/search", key, body, &out); err != nil {
		return nil, err
	}
	return out.Results, nil
}

// Fetch 抓取一个页面，返回 Markdown 正文。
func Fetch(ctx context.Context, base, key, target string) (string, error) {
	norm, err := NormalizeBase(base)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(key) == "" {
		return "", ErrNoKey
	}
	t := strings.TrimSpace(target)
	if t == "" {
		return "", errors.New("search: url 不能为空")
	}
	if !strings.HasPrefix(t, "http://") && !strings.HasPrefix(t, "https://") {
		return "", errors.New("search: url 必须是 http(s)")
	}
	body, _ := json.Marshal(map[string]string{"url": t})
	resp, err := do(ctx, norm+"/fetch", key, body)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", statusError(resp)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return "", fmt.Errorf("search: 读取抓取结果: %w", err)
	}
	return string(b), nil
}

func postJSON(ctx context.Context, endpoint, key string, body []byte, out any) error {
	resp, err := do(ctx, endpoint, key, body)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return statusError(resp)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return fmt.Errorf("search: 读取响应: %w", err)
	}
	if err := json.Unmarshal(b, out); err != nil {
		return fmt.Errorf("search: 解析响应: %w（前 200 字节：%s）", err, snippet(b, 200))
	}
	return nil
}

func do(ctx context.Context, endpoint, key string, body []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("search: 构造请求: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/markdown, text/plain")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(key))
	resp, err := client().Do(req)
	if err != nil {
		return nil, fmt.Errorf("search: 请求 %s: %w", endpoint, err)
	}
	return resp, nil
}

// statusError 把非 2xx 变成带响应片段的错误：401/403 与「路径不存在」要能区分。
func statusError(resp *http.Response) error {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	msg := strings.TrimSpace(string(b))
	if msg == "" {
		msg = http.StatusText(resp.StatusCode)
	}
	return fmt.Errorf("search: HTTP %d: %s", resp.StatusCode, snippet([]byte(msg), 500))
}

func snippet(b []byte, n int) string {
	r := []rune(string(b))
	if len(r) > n {
		return string(r[:n]) + "…"
	}
	return string(r)
}
