package settings

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParseModelsAnthropicStyle(t *testing.T) {
	body := []byte(`{"data":[{"id":"gw-opus-1","display_name":"GW Opus","owned_by":"gw"},{"id":"gw-sonnet-1"}],"has_more":false}`)
	got, err := parseModels(body)
	if err != nil {
		t.Fatalf("parseModels: %v", err)
	}
	if len(got) != 2 || got[0].ID != "gw-opus-1" || got[0].Display != "GW Opus" {
		t.Fatalf("解析结果不对: %+v", got)
	}
}

func TestParseModelsAlternateShapes(t *testing.T) {
	cases := []struct {
		name string
		body string
		want int
	}{
		{"models 键", `{"models":[{"name":"m-a"}]}`, 1},
		{"顶层数组", `[{"id":"m-b"},{"model":"m-c"}]`, 2},
		{"model_id 键", `{"data":[{"model_id":"m-d"}]}`, 1},
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
	body := []byte(`{"data":[{"id":"a"},{"id":"a"},{"display_name":"无 id"}]}`)
	got, err := parseModels(body)
	if err != nil {
		t.Fatalf("parseModels: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("应去重并忽略无标识项，实际 %+v", got)
	}
}

func TestFetchModelsAgainstServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Header.Get("x-api-key") != "k1" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"gw-a"},{"id":"gw-b"}]}`))
	}))
	defer srv.Close()

	res := FetchModels(t.Context(), Settings{BaseURL: srv.URL, APIKey: "k1"})
	if len(res.Models) != 2 || res.Models[0].ID != "gw-a" {
		t.Fatalf("结果不对: %+v", res)
	}

	// 错误凭据应把状态码带回来，供前端提示
	bad := FetchModels(t.Context(), Settings{BaseURL: srv.URL, APIKey: "wrong"})
	if bad.Status != http.StatusUnauthorized || len(bad.Models) != 0 {
		t.Fatalf("鉴权失败应返回 401: %+v", bad)
	}
}

func TestResolveAlias(t *testing.T) {
	v := Settings{Model: "gw-default", OpusModel: "gw-opus", SonnetModel: "gw-sonnet", HaikuModel: ""}
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
	v2 := Settings{OpusModel: "gw-opus"}
	if got := v2.ResolveAlias("default"); got != "gw-opus" {
		t.Fatalf("default 应跟随 opus: %q", got)
	}
}
