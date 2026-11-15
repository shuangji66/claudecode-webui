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
		{"models 键", `{"models":[{"name":"m-a"}]}`, 1},
		{"顶层数组", `[{"id":"m-b"},{"model":"m-c"}]`, 2},
		{"model_id 键", `{"data":[{"model_id":"m-d"}]}`, 1},
		{"纯字符串数组", `{"data":["x-model","y-model"]}`, 2},
		// 实测会遇到：data 是对象而不是数组
		{"data 是对象", `{"code":0,"data":{"models":[{"id":"nested"}]}}`, 1},
		// 更深的嵌套
		{"多层嵌套", `{"result":{"items":{"list":[{"id":"deep"}]}}}`, 1},
		{"OpenAI 风格", `{"object":"list","data":[{"id":"gpt-4o","object":"model","owned_by":"x"}]}`, 1},
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

func TestParseModelsDedupesAndIgnoresEmpty(t *testing.T) {
	got, err := parseModels([]byte(`{"data":[{"id":"a"},{"id":"a"},{"display_name":"无 id"}]}`))
	if err != nil {
		t.Fatalf("parseModels: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("应去重并忽略无标识项，实际 %+v", got)
	}
}

func TestParseModelsRejectsHTML(t *testing.T) {
	_, err := parseModels([]byte(`<!doctype html><html><body>app</body></html>`))
	if err == nil {
		t.Fatal("HTML 应解析失败")
	}
	if !strings.Contains(err.Error(), "JSON") {
		t.Fatalf("错误信息应指明不是 JSON: %v", err)
	}
}

func TestParseModelsEmptyBody(t *testing.T) {
	if _, err := parseModels(nil); err == nil {
		t.Fatal("空响应应报错")
	}
}

// 网关没实现 /v1/models 时，应继续尝试 /models。
func TestFetchModelsFallsBackToAlternatePath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"not found"}`))
		case "/models":
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"data":[{"id":"only-here"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	res := FetchModels(t.Context(), Settings{BaseURL: srv.URL, APIKey: "k"})
	if len(res.Models) != 1 || res.Models[0].ID != "only-here" {
		t.Fatalf("应从 /models 拿到列表: %+v", res)
	}
	if len(res.Tried) < 2 {
		t.Fatalf("应记录尝试过的路径: %v", res.Tried)
	}
}

// 返回 HTML 时必须把原文带回，并给出「手动填写」的提示。
func TestFetchModelsHTMLGivesActionableError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/html")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`<!doctype html><html><head><title>App</title></head><body>SPA</body></html>`))
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
	if res.Status != http.StatusUnauthorized {
		t.Fatalf("状态 = %d", res.Status)
	}
	if !strings.Contains(res.Detail, "鉴权失败") {
		t.Fatalf("提示 = %q", res.Detail)
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
	// default 不单独指定时跟随 opus（与 CLI 行为一致）
	if got := (Settings{OpusModel: "gw-opus"}).ResolveAlias("default"); got != "gw-opus" {
		t.Fatalf("default 应跟随 opus: %q", got)
	}
}

// 只认 Bearer 的中转：默认发 x-api-key 会被 401，应自动换一种方式重试。
func TestFetchModelsRetriesWithBearer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
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
	if len(res.Models) != 1 || res.Models[0].ID != "cn:deepseek-v4.1-flash" {
		t.Fatalf("Bearer 重试应成功: %+v", res)
	}
	if !strings.Contains(res.Detail, "Bearer") {
		t.Fatalf("应说明用了 Bearer 鉴权: %q", res.Detail)
	}
}

// 两种鉴权都失败时要如实报告两个状态码。
func TestFetchModelsBothAuthFail(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	res := FetchModels(t.Context(), Settings{BaseURL: srv.URL, APIKey: "bad"})
	if len(res.Models) != 0 || !strings.Contains(res.Detail, "鉴权失败") {
		t.Fatalf("应报鉴权失败: %+v", res)
	}
}

func TestVerifyModel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("content-type", "application/json")
		if r.Header.Get("x-api-key") != "k" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"ok"}]}`))
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
