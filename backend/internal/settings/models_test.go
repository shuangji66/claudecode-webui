package settings

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseModelsShapes(t *testing.T) {
	cases := []struct {
		name string
		body string
		want int
	}{
		{"Anthropic 标准", `{"data":[{"id":"a"},{"id":"b"}]}`, 2},
		{"models 数组", `{"models":[{"name":"m-a"}]}`, 1},
		{"models 映射", `{"models":{"gw-a":{"display_name":"A"},"gw-b":{}}}`, 2},
		{"顶层数组", `[{"id":"m-b"},{"model":"m-c"}]`, 2},
		{"纯字符串数组", `{"data":["x-model","y-model"]}`, 2},
		{"data 是对象", `{"code":0,"data":{"models":[{"id":"nested"}]}}`, 1},
		{"多层嵌套", `{"result":{"items":{"list":[{"id":"deep"}]}}}`, 1},
		{"Gemini", `{"models":[{"name":"models/gemini-1.5-pro"}]}`, 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := parseModels([]byte(c.body))
			if err != nil {
				t.Fatalf("parseModels: %v", err)
			}
			if len(got) != c.want {
				t.Fatalf("应解析出 %d 个，实际 %+v", c.want, got)
			}
		})
	}
}

// Gemini 的条目名带 models/ 前缀，对外应剥掉。
func TestParseModelsStripsGeminiPrefix(t *testing.T) {
	got, err := parseModels([]byte(`{"models":[{"name":"models/gemini-1.5-pro"}]}`))
	if err != nil {
		t.Fatalf("parseModels: %v", err)
	}
	if got[0].ID != "gemini-1.5-pro" {
		t.Fatalf("ID = %q", got[0].ID)
	}
}

// 真实中转的模型条目很大（description / modalities / context_window 全带），
// 整份响应经常超过 4KB。曾经把小上限用于读取，导致合法 JSON 被截断后误报
// 「不是合法 JSON」——这条是回归测试。
func TestFetchModelsLargeResponseNotTruncated(t *testing.T) {
	entry := func(i int) string {
		return fmt.Sprintf(`{
			"id":"cn:deepseek-v4.1-flash-%d",
			"name":"DeepSeek-V4.1-Flash",
			"object":"model",
			"created":1753600000,
			"owned_by":"workbuddy",
			"description":"[x0.11 credit] 已更新至 V4.1-Flash-1017 最新版，支持 1M 上下文窗口，原生多模态；这是一段足够长的中文描述用来把响应体撑大，模拟真实网关的返回。",
			"credits":"x0.11",
			"promo_label":"夜间折扣",
			"can_disable_thinking":true,
			"only_reasoning":true,
			"context_length":1000000,
			"context_window":{"default":300000,"supported":[300000,600000,1000000]},
			"limit":{"context":1000000,"output":128000},
			"max_allowed_size":1000000,
			"max_output_tokens":128000,
			"modalities":{"input":["text","image"],"output":["text"]}
		}`, i)
	}
	parts := make([]string, 0, 12)
	for i := 0; i < 12; i++ {
		parts = append(parts, entry(i))
	}
	body := `{"data":[` + strings.Join(parts, ",") + `]}`
	if len(body) <= readLimitSmall {
		t.Fatalf("测试响应应大于小上限，实际 %d 字节", len(body))
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	res := FetchModels(t.Context(), Provider{BaseURL: srv.URL, APIKey: "k"})
	if len(res.Models) != 12 {
		t.Fatalf("应解析出 12 个模型，实际 %d（detail=%s）", len(res.Models), res.Detail)
	}
	if res.Models[0].ID != "cn:deepseek-v4.1-flash-0" {
		t.Fatalf("首个模型 = %q", res.Models[0].ID)
	}
}

func TestParseModelsRejectsHTML(t *testing.T) {
	_, err := parseModels([]byte(`<!doctype html><html></html>`))
	if err == nil || !strings.Contains(err.Error(), "JSON") {
		t.Fatalf("HTML 应报非 JSON: %v", err)
	}
}

func TestParseModelsEmptyBody(t *testing.T) {
	if _, err := parseModels(nil); err == nil {
		t.Fatal("空响应应报错")
	}
}

// 列表路径规则照 DSH：Anthropic 需要把 base 末尾的 /v1 剥掉再拼 /v1/models。
func TestListingURLPerProtocol(t *testing.T) {
	cases := []struct {
		base, protocol, want string
	}{
		{"https://api.anthropic.com", ProtocolAnthropic, "https://api.anthropic.com/v1/models?limit=1000"},
		{"https://gw.example/v1", ProtocolAnthropic, "https://gw.example/v1/models?limit=1000"},
		{"https://gw.example/v1/", ProtocolAnthropic, "https://gw.example/v1/models?limit=1000"},
		{"https://gw.example/v1", ProtocolOpenAI, "https://gw.example/v1/models"},
		{"https://gw.example/openai/v1", ProtocolResponses, "https://gw.example/openai/v1/models"},
		{"https://gw.example/v1beta", ProtocolGemini, "https://gw.example/v1beta/models?pageSize=1000"},
	}
	for _, c := range cases {
		if got := ListingURL(c.base, c.protocol, ""); got != c.want {
			t.Fatalf("ListingURL(%q,%q) = %q, want %q", c.base, c.protocol, got, c.want)
		}
	}
}

func TestFetchModelsAnthropicUsesKeyHeader(t *testing.T) {
	var gotKey, gotAuth, gotVersion string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		gotKey = r.Header.Get("x-api-key")
		gotAuth = r.Header.Get("authorization")
		gotVersion = r.Header.Get("anthropic-version")
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"claude-x"}]}`))
	}))
	defer srv.Close()

	res := FetchModels(t.Context(), Provider{BaseURL: srv.URL, APIKey: "k1"})
	if len(res.Models) != 1 {
		t.Fatalf("应拿到模型: %+v", res)
	}
	if gotKey != "k1" {
		t.Fatalf("Anthropic 协议应发 x-api-key，实际 %q", gotKey)
	}
	if gotAuth != "" {
		t.Fatalf("不应同时发 Bearer: %q", gotAuth)
	}
	if gotVersion != "2023-06-01" {
		t.Fatalf("应带 anthropic-version，实际 %q", gotVersion)
	}
	if !res.Auth.APIKeySent {
		t.Fatal("Auth.APIKeySent 应为 true")
	}
}

func TestFetchModelsOpenAIUsesBearer(t *testing.T) {
	var gotAuth, gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/models" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		gotAuth = r.Header.Get("authorization")
		gotKey = r.Header.Get("x-api-key")
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"gpt-x"}]}`))
	}))
	defer srv.Close()

	res := FetchModels(t.Context(), Provider{BaseURL: srv.URL, APIKey: "k2", Protocol: ProtocolOpenAI})
	if len(res.Models) != 1 {
		t.Fatalf("应拿到模型: %+v", res)
	}
	if gotAuth != "Bearer k2" {
		t.Fatalf("OpenAI 协议应发 Bearer，实际 %q", gotAuth)
	}
	if gotKey != "" {
		t.Fatalf("OpenAI 协议不应发 x-api-key: %q", gotKey)
	}
}

func TestFetchModelsGeminiUsesGoogHeader(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/models" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		got = r.Header.Get("x-goog-api-key")
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"models":[{"name":"models/gemini-1.5-pro"}]}`))
	}))
	defer srv.Close()

	res := FetchModels(t.Context(), Provider{BaseURL: srv.URL, APIKey: "g1", Protocol: ProtocolGemini})
	if len(res.Models) != 1 || res.Models[0].ID != "gemini-1.5-pro" {
		t.Fatalf("应拿到 Gemini 模型: %+v", res)
	}
	if got != "g1" {
		t.Fatalf("应发 x-goog-api-key，实际 %q", got)
	}
}

// 不支持的协议应直接提示手动录入，而不是发请求后报「没有模型」。
func TestFetchModelsUnsupportedProtocol(t *testing.T) {
	res := FetchModels(t.Context(), Provider{BaseURL: "https://gw.example", Protocol: "azure-openai"})
	if res.Supported {
		t.Fatal("Supported 应为 false")
	}
	if !strings.Contains(res.Detail, "手动填写") {
		t.Fatalf("提示不清楚: %q", res.Detail)
	}
	if res.Status != 0 {
		t.Fatalf("不应发出请求，Status = %d", res.Status)
	}
}

// 401 时用同一密钥换 Bearer 再试一次（很多中转只认 Bearer）。
func TestFetchModelsRetriesWithBearer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "Bearer sk-relay" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"invalid api key"}`))
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"cn:deepseek-v4.1-flash"}]}`))
	}))
	defer srv.Close()

	res := FetchModels(t.Context(), Provider{BaseURL: srv.URL, APIKey: "sk-relay"})
	if len(res.Models) != 1 {
		t.Fatalf("Bearer 重试应成功: %+v", res)
	}
	if !res.Auth.BearerFallback || !strings.Contains(res.Detail, "Bearer") {
		t.Fatalf("应说明用了 Bearer 鉴权: %+v", res)
	}
}

func TestFetchModelsHTMLGivesActionableError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/html")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`<!doctype html><html><body>SPA</body></html>`))
	}))
	defer srv.Close()

	res := FetchModels(t.Context(), Provider{BaseURL: srv.URL})
	if len(res.Models) != 0 {
		t.Fatalf("不应解析出模型: %+v", res)
	}
	if !strings.Contains(res.Raw, "<!doctype html") {
		t.Fatalf("应回显原始响应: %q", res.Raw)
	}
	if !strings.Contains(res.Detail, "HTML") || !strings.Contains(res.Detail, "手动填写") {
		t.Fatalf("提示不够具体: %q", res.Detail)
	}
}

func TestFetchModelsUnauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"message":"invalid key"}}`))
	}))
	defer srv.Close()

	res := FetchModels(t.Context(), Provider{BaseURL: srv.URL, APIKey: "wrong"})
	if !strings.Contains(res.Detail, "鉴权失败") {
		t.Fatalf("提示 = %q", res.Detail)
	}
}

func TestFetchModelsManualPathOverride(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"m"}]}`))
	}))
	defer srv.Close()

	res := FetchModels(t.Context(), Provider{BaseURL: srv.URL, ModelsPath: "/api/models"})
	if gotPath != "/api/models" {
		t.Fatalf("应走手动指定的路径，实际 %q", gotPath)
	}
	if len(res.Models) != 1 {
		t.Fatalf("应拿到模型: %+v", res)
	}
}

func TestFetchModelsRejectsBadScheme(t *testing.T) {
	res := FetchModels(t.Context(), Provider{BaseURL: "relay.local"})
	if len(res.Models) != 0 || !strings.Contains(res.Detail, "http") {
		t.Fatalf("应提示协议头: %+v", res)
	}
}

// 别名槽位已废弃：选中的模型就是 CLI 的默认模型。
func TestDefaultModelAndEnv(t *testing.T) {
	v := Settings{
		Providers: []Provider{
			{ID: "gw", Name: "GW", Protocol: ProtocolAnthropic, BaseURL: "https://gw.example", APIKey: "sk-1", Models: []string{"cn:deepseek"}},
		},
		Selected: Selection{Provider: "gw", Model: "cn:deepseek"},
	}
	env := strings.Join(v.Env(), ",")
	for _, want := range []string{
		"ANTHROPIC_BASE_URL=https://gw.example",
		"ANTHROPIC_API_KEY=sk-1",
		"ANTHROPIC_MODEL=cn:deepseek",
	} {
		if !strings.Contains(env, want) {
			t.Fatalf("Env 缺少 %q：%v", want, env)
		}
	}
	if got := v.DefaultModel(); got != "cn:deepseek" {
		t.Fatalf("DefaultModel = %q", got)
	}
}

func TestEnvEmptyWhenNothingSelected(t *testing.T) {
	env := Settings{}.Env()
	if len(env) != 0 {
		t.Fatalf("未选模型时不应注入任何变量: %v", env)
	}
}

func TestVerifyModel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Header.Get("x-api-key") != "k" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"content":[]}`))
	}))
	defer srv.Close()

	ok := VerifyModel(t.Context(), Provider{BaseURL: srv.URL, APIKey: "k"}, "gw-good")
	if !ok.OK {
		t.Fatalf("应验证通过: %+v", ok)
	}
	bad := VerifyModel(t.Context(), Provider{BaseURL: srv.URL, APIKey: "wrong"}, "gw-good")
	if bad.OK || !strings.Contains(bad.Detail, "不可用") {
		t.Fatalf("错误凭据应失败: %+v", bad)
	}
	empty := VerifyModel(t.Context(), Provider{BaseURL: srv.URL}, "")
	if empty.OK || !strings.Contains(empty.Detail, "为空") {
		t.Fatalf("空模型名应失败: %+v", empty)
	}
}

// 显示名只取 display_name/name 等字段，不能把 description 当成名字。
func TestParseModelsDoesNotUseDescriptionAsDisplay(t *testing.T) {
	got, err := parseModels([]byte(`{"data":[
	  {"id":"a","name":"A 模型","description":"很长的模型描述"},
	  {"id":"b","description":"只有描述"}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	if got[0].Display != "A 模型" {
		t.Fatalf("Display = %q", got[0].Display)
	}
	if got[1].Display != "" {
		t.Fatalf("只有 description 时 Display 应为空，实际 %q", got[1].Display)
	}
}
