package search

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNormalizeBase(t *testing.T) {
	cases := []struct {
		in, want string
		bad      bool
	}{
		{"", DefaultBaseURL, false},
		{"https://api.deepseek.com/v1/tools/", "https://api.deepseek.com/v1/tools", false},
		{"http://gw.local/api/v1/tools", "http://gw.local/api/v1/tools", false},
		{"ftp://x", "", true},
		{"api.deepseek.com", "", true},
	}
	for _, c := range cases {
		got, err := NormalizeBase(c.in)
		if c.bad {
			if err == nil {
				t.Fatalf("%q 应当报错，实际 %q", c.in, got)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Fatalf("%q → %q, %v，期望 %q", c.in, got, err, c.want)
		}
	}
}

func TestSearchSendsBearerAndClampsCount(t *testing.T) {
	var gotAuth, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"results":[{"title":"T","url":"https://x","snippet":"S","date":"2026-01-01"}]}`))
	}))
	defer srv.Close()

	res, err := Search(context.Background(), srv.URL, "k-123", "deepseek 搜索", 999)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if gotAuth != "Bearer k-123" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
	if gotPath != "/search" {
		t.Fatalf("path = %q，期望 /search", gotPath)
	}
	// 结果数会被夹到 50；need_content 必须显式为 false（默认不带正文）。
	if gotBody["count"] != float64(MaxCount) || gotBody["need_content"] != false {
		t.Fatalf("请求体 = %v", gotBody)
	}
	if len(res) != 1 || res[0].Title != "T" || res[0].URL != "https://x" {
		t.Fatalf("结果 = %+v", res)
	}
}

func TestSearchErrors(t *testing.T) {
	if _, err := Search(context.Background(), "", "", "q", 5); err != ErrNoKey {
		t.Fatalf("缺密钥: %v，期望 ErrNoKey", err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "invalid token", http.StatusUnauthorized)
	}))
	defer srv.Close()
	_, err := Search(context.Background(), srv.URL, "bad", "q", 5)
	if err == nil || !strings.Contains(err.Error(), "401") || !strings.Contains(err.Error(), "invalid token") {
		t.Fatalf("401 应带状态码与响应片段: %v", err)
	}
}

func TestFetchReturnsMarkdown(t *testing.T) {
	var gotURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/fetch" {
			t.Errorf("path = %q", r.URL.Path)
		}
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotURL = body["url"]
		w.Header().Set("Content-Type", "text/markdown")
		_, _ = w.Write([]byte("# 标题\n\n正文"))
	}))
	defer srv.Close()

	md, err := Fetch(context.Background(), srv.URL, "k", "https://example.com/a")
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if gotURL != "https://example.com/a" {
		t.Fatalf("url = %q", gotURL)
	}
	if !strings.Contains(md, "正文") {
		t.Fatalf("markdown = %q", md)
	}
	if _, err := Fetch(context.Background(), srv.URL, "k", "file:///etc/passwd"); err == nil {
		t.Fatalf("非 http(s) 应当被拒")
	}
}
