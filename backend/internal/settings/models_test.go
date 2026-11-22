package settings

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
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
	// 网关同时给出上下文窗口与最大输出，两个都要回填，前端才能预填模型容量。
	if res.Models[0].ContextLength != 1000000 {
		t.Fatalf("context_length = %d，期望 1000000", res.Models[0].ContextLength)
	}
	if res.Models[0].MaxOutputTokens != 128000 {
		t.Fatalf("max_output_tokens = %d，期望 128000", res.Models[0].MaxOutputTokens)
	}
}

func TestCapacityParsing(t *testing.T) {
	el := map[string]any{
		"context_window": map[string]any{"default": float64(300000)},
		"limit":          map[string]any{"output": float64(64000)},
	}
	if got := contextLengthOf(el); got != 300000 {
		t.Fatalf("contextLengthOf = %d，期望 300000", got)
	}
	if got := maxOutputTokensOf(el); got != 64000 {
		t.Fatalf("maxOutputTokensOf = %d，期望 64000", got)
	}

	cases := []struct {
		name string
		el   map[string]any
		want int
	}{
		{"max_output_tokens", map[string]any{"max_output_tokens": float64(128000)}, 128000},
		{"max_completion_tokens", map[string]any{"max_completion_tokens": float64(8192)}, 8192},
		{"max_tokens", map[string]any{"max_tokens": float64(4096)}, 4096},
		{"top_provider", map[string]any{"top_provider": map[string]any{"max_completion_tokens": float64(2048)}}, 2048},
		{"没有容量字段", map[string]any{"id": "m"}, 0},
		{"非法值", map[string]any{"max_tokens": "128k"}, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := maxOutputTokensOf(c.el); got != c.want {
				t.Fatalf("maxOutputTokensOf = %d，期望 %d", got, c.want)
			}
		})
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

// 列表路径只有一条规则：剥掉 base 末尾的 /v1 再拼 /v1/models。
// 用户填带不带 /v1 都应该落到同一个地址。
//
// **必须走 Provider.ListBaseURL**（而不是自己先 strip 再调 ListingURL）：调用链里
// 少剥一层就是 `…/v1/v1/models`，而自己 strip 过的用例照样能过——`Probe` 就曾经
// 因为传的是 `p.Root()` 而漏了这一步。
func TestListingURLStripsVersionSuffix(t *testing.T) {
	cases := []struct {
		base, want string
	}{
		{"https://api.anthropic.com", "https://api.anthropic.com/v1/models?limit=1000"},
		{"https://gw.example/v1", "https://gw.example/v1/models?limit=1000"},
		{"https://gw.example/v1/", "https://gw.example/v1/models?limit=1000"},
		{"https://gw.example/api/anthropic", "https://gw.example/api/anthropic/v1/models?limit=1000"},
	}
	for _, c := range cases {
		p := Provider{BaseURL: c.base}
		if got := ListingURL(p.ListBaseURL(), ""); got != c.want {
			t.Fatalf("ListingURL(ListBaseURL(%q)) = %q, want %q", c.base, got, c.want)
		}
	}
}

// 覆盖路径原样拼接，不经过 /v1 推导。
func TestListingURLOverride(t *testing.T) {
	if got := ListingURL("https://gw.example", "/models"); got != "https://gw.example/models" {
		t.Fatalf("override = %q", got)
	}
	if got := ListingURL("https://gw.example", "models"); got != "https://gw.example/models" {
		t.Fatalf("override 缺前导斜杠 = %q", got)
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
	if res.Auth.Header != AuthXAPIKey {
		t.Fatalf("Auth.Header 应为 %s，实际 %q", AuthXAPIKey, res.Auth.Header)
	}
}

func TestFetchModelsBearerToken(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		gotAuth = r.Header.Get("authorization")
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"glm-x"}]}`))
	}))
	defer srv.Close()

	res := FetchModels(t.Context(), Provider{BaseURL: srv.URL, APIKey: "b2", Auth: AuthBearer})
	if len(res.Models) != 1 {
		t.Fatalf("应拿到模型: %+v", res)
	}
	if gotAuth != "Bearer b2" {
		t.Fatalf("认证方式选 Bearer 就应该发 Bearer，实际 %q", gotAuth)
	}
	if res.Auth.Header != AuthBearer {
		t.Fatalf("Auth.Header 应为 %s，实际 %q", AuthBearer, res.Auth.Header)
	}
}

// 认证方式选了 x-api-key、但网关只认 Bearer 时，用同一把密钥换 Bearer 重试一次。
func TestFetchModelsBearerFallback(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		// 只认 Bearer：x-api-key 的第一次请求回 401。
		if r.Header.Get("authorization") != "Bearer k3" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"m"}]}`))
	}))
	defer srv.Close()

	res := FetchModels(t.Context(), Provider{BaseURL: srv.URL, APIKey: "k3"})
	if len(res.Models) != 1 {
		t.Fatalf("应拿到模型: %+v", res)
	}
	if res.Auth.SwitchedTo != AuthBearer {
		t.Fatalf("SwitchedTo 应为 %s，实际 %q", AuthBearer, res.Auth.SwitchedTo)
	}
	if calls != 2 {
		t.Fatalf("应请求两次（x-api-key 失败后换 Bearer），实际 %d", calls)
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
	if res.Auth.SwitchedTo != AuthBearer || !strings.Contains(res.Detail, "Bearer") {
		t.Fatalf("应说明用了 Bearer 鉴权: %+v", res)
	}
}

// 同一条 Bearer 兜底也要在「测试连接」上生效：只认 Bearer 的中转上，
// 少了它就会出现「获取列表成功、测试连接鉴权失败」这种自相矛盾的结论。
func TestProbeRetriesWithBearer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "Bearer sk-relay" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"invalid api key"}`))
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"m"}]}`))
	}))
	defer srv.Close()

	res := Probe(t.Context(), Provider{BaseURL: srv.URL, APIKey: "sk-relay"})
	if !res.OK {
		t.Fatalf("测试连接应通过: %+v", res)
	}
	if !strings.Contains(res.Detail, "Bearer") {
		t.Fatalf("应说明用了 Bearer 鉴权: %q", res.Detail)
	}
	if res.AuthSwitchedTo != AuthBearer {
		t.Fatalf("AuthSwitchedTo 应为 %s，实际 %q", AuthBearer, res.AuthSwitchedTo)
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

// Probe 与 FetchModels 必须打到同一个列表地址：两条路都走 ListBaseURL。
//
// 只比对预期字符串不够（自己先 strip 再断言照样能过），这里真的发请求——
// `Probe` 曾经传的是 `p.Root()`，于是 base 带 `/v1` 时它请求
// `…/v1/v1/models`，「测试连接」永远 404 而「获取模型列表」正常。
func TestProbeUsesSameListingURLAsFetchModels(t *testing.T) {
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.Path)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"m"}]}`))
	}))
	defer srv.Close()

	p := Provider{BaseURL: srv.URL + "/v1"}
	if res := Probe(t.Context(), p); !res.OK {
		t.Fatalf("Probe 应通过: %+v", res)
	}
	if res := FetchModels(t.Context(), p); len(res.Models) != 1 {
		t.Fatalf("FetchModels 应拿到模型: %+v", res)
	}
	if len(seen) != 2 || seen[0] != "/v1/models" || seen[1] != "/v1/models" {
		t.Fatalf("两条路的列表地址应同为 /v1/models，实际 %v", seen)
	}
}

// 别名槽位已废弃：选中的模型就是 CLI 的默认模型。
func TestDefaultModelAndEnv(t *testing.T) {
	v := Settings{
		Providers: []Provider{
			{ID: "gw", Name: "GW", BaseURL: "https://gw.example", APIKey: "sk-1", Models: []string{"cn:deepseek"}},
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
	env := strings.Join(Settings{}.Env(), ",")
	if strings.Contains(env, "ANTHROPIC_") {
		t.Fatalf("未选模型时不应注入 ANTHROPIC_*: %v", env)
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

// listingCandidates：预置的 Anthropic 兼容端点把对话放在子路径上，列表在主机根。
//
// 这条是实机踩到的：DeepSeek 预置填的是 `https://api.deepseek.com/anthropic`，
// 旧实现只问 `…/anthropic/v1/models`（带密钥实测 404），「获取模型列表」永远失败；
// 真正的地址是 `…/v1/models`。百炼 coding 更靠外：base 是 `/apps/anthropic`，
// 列表在主机根，连 `/apps/v1/models` 都是 404。
func TestListingCandidatesCoversConversationSubpaths(t *testing.T) {
	cases := []struct {
		base string
		want []string
	}{
		{
			// 官方端点：base 底下就是答案，不多猜。
			"https://api.anthropic.com",
			[]string{"/v1/models?limit=1000", "/models"},
		},
		{
			"https://api.deepseek.com/anthropic",
			[]string{"/anthropic/v1/models?limit=1000", "/v1/models?limit=1000", "/models"},
		},
		{
			"https://coding.dashscope.aliyuncs.com/apps/anthropic",
			[]string{"/apps/anthropic/v1/models?limit=1000", "/v1/models?limit=1000", "/models"},
		},
	}
	for _, c := range cases {
		got := listingCandidates(Provider{BaseURL: c.base})
		paths := make([]string, 0, len(got))
		for _, u := range got {
			paths = append(paths, pathOf(u))
		}
		if strings.Join(paths, " ") != strings.Join(c.want, " ") {
			t.Fatalf("%s 的候选 = %v，期望 %v", c.base, paths, c.want)
		}
	}
}

// 手动填了列表路径：以它为准，但也要能吃「base 带对话子路径」这一套。
//
// 用户填 `/v1/models` 时想的是主机根；DeepSeek 的 base 是 `/anthropic`，
// 只拼 base 的话正好落到那个 404 上——这个输入框就成了摆设。
func TestListingCandidatesRespectsManualPath(t *testing.T) {
	got := listingCandidates(Provider{BaseURL: "https://api.deepseek.com/anthropic", ModelsPath: "/v1/models"})
	want := []string{
		"https://api.deepseek.com/anthropic/v1/models",
		"https://api.deepseek.com/v1/models",
	}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("手填路径的候选 = %v，期望 %v", got, want)
	}
	// base 本来就是主机根时只有一条，不多猜。
	only := listingCandidates(Provider{BaseURL: "https://gw.example", ModelsPath: "/api/models"})
	if len(only) != 1 || only[0] != "https://gw.example/api/models" {
		t.Fatalf("主机根 base 的手填路径 = %v", only)
	}
}

// 列表在主机根、对话 base 带 /anthropic：FetchModels 必须顺着候选找到它。
func TestFetchModelsFallsBackToHostRoot(t *testing.T) {
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.Path)
		if r.URL.Path != "/v1/models" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"message":"Not Found"}}`))
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"deepseek-flash"}]}`))
	}))
	defer srv.Close()

	res := FetchModels(t.Context(), Provider{
		BaseURL: srv.URL + "/anthropic",
		APIKey:  "sk-1",
		Auth:    AuthBearer,
	})
	if len(res.Models) != 1 || res.Models[0].ID != "deepseek-flash" {
		t.Fatalf("应从主机根拿到模型: %+v", res)
	}
	if len(seen) != 2 || seen[0] != "/anthropic/v1/models" || seen[1] != "/v1/models" {
		t.Fatalf("应先问 base 底下那条、再退到主机根，实际 %v", seen)
	}
	if !strings.Contains(res.Detail, "/v1/models") {
		t.Fatalf("应说明命中的路径: %q", res.Detail)
	}
}

// 子路径 base 上「路径不存在」也可能回 401（实测 MiniMax 的 /anthropic/*），
// 这时不能当场判「鉴权失败」：主机根那条用同一把密钥能拉到列表。
func TestFetchModelsKeepsScanningAfter401OnSubpath(t *testing.T) {
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.Path)
		if r.URL.Path != "/v1/models" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"type":"error","error":{"type":"authentication_error"}}`))
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"MiniMax-M3"}]}`))
	}))
	defer srv.Close()

	res := FetchModels(t.Context(), Provider{
		BaseURL: srv.URL + "/anthropic",
		APIKey:  "valid-key",
		Auth:    AuthBearer,
	})
	if len(res.Models) != 1 {
		t.Fatalf("401 之后应继续试主机根: %+v", res)
	}
	if len(seen) != 2 {
		t.Fatalf("应请求两条路径，实际 %v", seen)
	}
	if res.Auth.SwitchedTo != "" {
		t.Fatalf("同一把密钥就成功了，不该报换认证: %q", res.Auth.SwitchedTo)
	}
}

// 而 base 只有主机根时，401 就是结论：当场换一种头重试，不扩散成对别的路径的猜测。
func TestFetchModelsHostOnlyBaseStopsOn401(t *testing.T) {
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.Path)
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"message":"invalid key"}}`))
	}))
	defer srv.Close()

	res := FetchModels(t.Context(), Provider{BaseURL: srv.URL, APIKey: "wrong"})
	if len(res.Models) != 0 || !strings.Contains(res.Detail, "鉴权失败") {
		t.Fatalf("应报鉴权失败: %+v", res)
	}
	if len(seen) != 2 || seen[0] != "/v1/models" || seen[1] != "/v1/models" {
		t.Fatalf("应只对同一路径换头发两次，实际 %v", seen)
	}
}

// 智谱不在「主机根 + /v1/models」这条通用规律里：列表在 OpenAI 兼容端点的
// 版本号后面，主机根下没有 /v1/models。这类按主机登记。
func TestListingCandidatesZai(t *testing.T) {
	got := listingCandidates(Provider{BaseURL: "https://api.z.ai/api/anthropic"})
	paths := make([]string, 0, len(got))
	for _, u := range got {
		paths = append(paths, pathOf(u))
	}
	want := []string{
		"/api/anthropic/v1/models?limit=1000",
		"/v1/models?limit=1000",
		"/models",
		"/api/paas/v4/models",
		"/api/coding/paas/v4/models",
	}
	if strings.Join(paths, " ") != strings.Join(want, " ") {
		t.Fatalf("候选 = %v，期望 %v", paths, want)
	}
	// 中国区同一套。
	cn := listingCandidates(Provider{BaseURL: "https://open.bigmodel.cn/api/anthropic"})
	if pathOf(cn[len(cn)-2]) != "/api/paas/v4/models" {
		t.Fatalf("bigmodel 应带 paas 路径: %v", cn)
	}
}

// 同主机登记的路径也能命中：Z.AI 的 /api/paas/v4/models 是它的真实列表地址。
func TestFetchModelsFallsBackToRegisteredPath(t *testing.T) {
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.Path)
		if r.URL.Path != "/api/paas/v4/models" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"code":"500","message":"404 NOT_FOUND"}}`))
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"glm-5"}]}`))
	}))
	defer srv.Close()

	// httptest 的主机是 127.0.0.1:port，不在登记表里——登记表按 host 匹配，
	// 所以这里用测试覆盖登记表本身（上一条）与「通用规律之外的候选也会被尝试」。
	hostListingPaths["127.0.0.1"] = []string{"/api/paas/v4/models"}
	defer delete(hostListingPaths, "127.0.0.1")

	res := FetchModels(t.Context(), Provider{
		BaseURL: srv.URL + "/api/anthropic",
		APIKey:  "id.secret",
		Auth:    AuthBearer,
	})
	if len(res.Models) != 1 || res.Models[0].ID != "glm-5" {
		t.Fatalf("应从登记路径拿到模型: %+v", res)
	}
	if len(seen) < 2 || seen[len(seen)-1] != "/api/paas/v4/models" {
		t.Fatalf("最后应问到登记路径，实际 %v", seen)
	}
}

// 单条候选有自己的超时：一条不响应的路径不能吃掉整个 15 秒预算。
//
// 以前 5 条候选共用调用方的 ctx，第一条卡住就全部变成
// `context deadline exceeded`——「获取模型列表」变成「转 15 秒然后请求失败」，
// 比修复前还差。这里让第一条永远不响应（超过 perListingTimeout），
// 第二条必须仍然被问到。
func TestListModelsPerTryTimeout(t *testing.T) {
	if testing.Short() {
		t.Skip("依赖真实超时，short 模式跳过")
	}
	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.URL.Path)
		mu.Unlock()
		if r.URL.Path == "/anthropic/v1/models" {
			// 不响应，直到客户端自己超时。
			<-r.Context().Done()
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"m"}]}`))
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(t.Context(), ProbeTimeout)
	defer cancel()
	start := time.Now()
	res := FetchModels(ctx, Provider{BaseURL: srv.URL + "/anthropic", APIKey: "k"})
	elapsed := time.Since(start)

	if len(res.Models) != 1 {
		t.Fatalf("第一条超时后应继续问下一条: %+v", res)
	}
	if elapsed > perListingTimeout+3*time.Second {
		t.Fatalf("不该用掉整个预算，实际 %v", elapsed)
	}
	if len(seen) < 2 || seen[1] != "/v1/models" {
		t.Fatalf("应继续问主机根，实际 %v", seen)
	}
}

// 「有一条 401」不等于「密钥不对」：路径不存在也可能回 401（MiniMax 实测）。
// 只有每一条候选都被拒、且换头也没救回来，才能下鉴权失败的结论。
func TestProbeAuthVerdictNeedsAllRejected(t *testing.T) {
	// 子路径 401、主机根 404：结论是「不知道列表在哪」，不是「密钥无效」。
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/anthropic/v1/messages":
			// 对话请求：凭据其实是对的（base 带 /anthropic，CLI 就是拼这里）。
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"id":"msg_1","type":"message"}`))
		case "/anthropic/v1/models":
			w.WriteHeader(http.StatusUnauthorized)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	res := Probe(t.Context(), Provider{
		BaseURL: srv.URL + "/anthropic",
		APIKey:  "valid",
		Models:  []string{"m"},
	})
	if !res.OK {
		t.Fatalf("凭据有效时不该报鉴权失败: %+v", res)
	}
	if strings.Contains(res.Detail, "鉴权失败") {
		t.Fatalf("Detail 不应说鉴权失败: %q", res.Detail)
	}

	// 反过来：每一条都 401 → 真的是鉴权失败。
	all401 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"message":"invalid key"}}`))
	}))
	defer all401.Close()
	bad := Probe(t.Context(), Provider{BaseURL: all401.URL, APIKey: "wrong"})
	if bad.OK || !strings.Contains(bad.Detail, "鉴权失败") {
		t.Fatalf("全部 401 应报鉴权失败: %+v", bad)
	}
}

// 每条候选都栽在网络层时，列表这一步已经给出结论，不要再发一次对话请求
// （那会多等 15 秒，还把原因换成 POST 的错误）。
func TestProbeNetFailureStopsEarly(t *testing.T) {
	// .invalid 是保留 TLD，DNS 必然失败。
	start := time.Now()
	res := Probe(t.Context(), Provider{BaseURL: "https://no-such-host-ccweb-test.invalid", APIKey: "k"})
	elapsed := time.Since(start)

	if res.OK || !strings.Contains(res.Detail, "请求失败") {
		t.Fatalf("应报网络失败: %+v", res)
	}
	if strings.Contains(res.Detail, "/v1/messages") {
		t.Fatalf("不该退到对话探测: %q", res.Detail)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("DNS 失败应立即返回，实际 %v", elapsed)
	}
}

// 「有些路径连不上、有些回了 404」不是网络故障：端点本身是通的，
// 结论应该是「列表不在这些路径上」，而不是「请求失败」。
//
// 用 ModelsPath 造出两条候选（{base} 下一条、主机根一条），让它们分别落到
// 死地址与活地址上——这正是真实预置的样子：base 是 /anthropic 子路径，
// 而列表在主机根。
func TestListModelsMixedNetAnd404(t *testing.T) {
	// 先起一个服务拿到端口，再关掉：连接会被拒。
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadHost := dead.URL
	dead.Close()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"message":"Not Found"}}`))
	}))
	defer srv.Close()

	// 全部候选都在死地址上 → netFailed。
	onlyDead := listModels(t.Context(), proxyClient(), Provider{BaseURL: deadHost, APIKey: "k"})
	if !onlyDead.netFailed {
		t.Fatalf("候选全连不上时应标 netFailed: %+v", onlyDead)
	}
	if onlyDead.deadline {
		t.Fatalf("连接被拒不是超时: %+v", onlyDead)
	}

	// 活地址上全 404 → 不是 netFailed（端点通了，只是没这个路径）。
	all404 := listModels(t.Context(), proxyClient(), Provider{BaseURL: srv.URL, APIKey: "k"})
	if all404.netFailed {
		t.Fatalf("端点可达时不该标 netFailed: %+v", all404)
	}
	if len(all404.attempts) == 0 {
		t.Fatal("应该至少问过一条")
	}
}
