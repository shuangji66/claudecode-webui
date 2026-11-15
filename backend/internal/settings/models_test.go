package settings

import (
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
		if got := ListingURL(c.base, c.protocol); got != c.want {
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

	res := FetchModels(t.Context(), Settings{BaseURL: srv.URL, APIKey: "k1"})
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

	res := FetchModels(t.Context(), Settings{BaseURL: srv.URL, APIKey: "k2", APIProtocol: ProtocolOpenAI})
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

	res := FetchModels(t.Context(), Settings{BaseURL: srv.URL, APIKey: "g1", APIProtocol: ProtocolGemini})
	if len(res.Models) != 1 || res.Models[0].ID != "gemini-1.5-pro" {
		t.Fatalf("应拿到 Gemini 模型: %+v", res)
	}
	if got != "g1" {
		t.Fatalf("应发 x-goog-api-key，实际 %q", got)
	}
}

// 不支持的协议应直接提示手动录入，而不是发请求后报「没有模型」。
func TestFetchModelsUnsupportedProtocol(t *testing.T) {
	res := FetchModels(t.Context(), Settings{BaseURL: "https://gw.example", APIProtocol: "azure-openai"})
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

	res := FetchModels(t.Context(), Settings{BaseURL: srv.URL, APIKey: "sk-relay"})
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

	res := FetchModels(t.Context(), Settings{BaseURL: srv.URL})
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

	res := FetchModels(t.Context(), Settings{BaseURL: srv.URL, APIKey: "wrong"})
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

	res := FetchModels(t.Context(), Settings{BaseURL: srv.URL, ModelsPath: "/api/models"})
	if gotPath != "/api/models" {
		t.Fatalf("应走手动指定的路径，实际 %q", gotPath)
	}
	if len(res.Models) != 1 {
		t.Fatalf("应拿到模型: %+v", res)
	}
}

func TestFetchModelsRejectsBadScheme(t *testing.T) {
	res := FetchModels(t.Context(), Settings{BaseURL: "relay.local"})
	if len(res.Models) != 0 || !strings.Contains(res.Detail, "http") {
		t.Fatalf("应提示协议头: %+v", res)
	}
}

func TestResolveAlias(t *testing.T) {
	v := Settings{Model: "gw-default", OpusModel: "gw-opus", SonnetModel: "gw-sonnet"}
	if got := v.ResolveAlias("default"); got != "gw-default" {
		t.Fatalf("default = %q", got)
	}
	if got := v.ResolveAlias("opus"); got != "gw-opus" {
		t.Fatalf("opus = %q", got)
	}
	if got := v.ResolveAlias("haiku"); got != "" {
		t.Fatalf("未映射的 haiku 应为空: %q", got)
	}
	if got := (Settings{OpusModel: "gw-opus"}).ResolveAlias("default"); got != "gw-opus" {
		t.Fatalf("default 应跟随 opus: %q", got)
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

	ok := VerifyModel(t.Context(), Settings{BaseURL: srv.URL, APIKey: "k"}, "gw-good")
	if !ok.OK {
		t.Fatalf("应验证通过: %+v", ok)
	}
	bad := VerifyModel(t.Context(), Settings{BaseURL: srv.URL, APIKey: "wrong"}, "gw-good")
	if bad.OK || !strings.Contains(bad.Detail, "不可用") {
		t.Fatalf("错误凭据应失败: %+v", bad)
	}
	empty := VerifyModel(t.Context(), Settings{BaseURL: srv.URL}, "")
	if empty.OK || !strings.Contains(empty.Detail, "为空") {
		t.Fatalf("空模型名应失败: %+v", empty)
	}
}
