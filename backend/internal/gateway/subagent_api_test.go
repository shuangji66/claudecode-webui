package gateway

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSessionTaskValidatesInput(t *testing.T) {
	srv, _ := newTestServer(t, "secret")

	cases := []struct {
		name string
		body string
		want int
	}{
		{"bad json", "{", http.StatusBadRequest},
		{"missing id", `{"action":"stop","task_id":"t1"}`, http.StatusBadRequest},
		{"unknown action", `{"id":"sess-1","action":"nuke"}`, http.StatusBadRequest},
		{"missing task id", `{"id":"sess-1","action":"stop"}`, http.StatusBadRequest},
		// 会话进程已被回收：没有可控制的任务，让前端去重连。
		{"session not running", `{"id":"sess-404","action":"stop","task_id":"t1"}`, http.StatusConflict},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, authedRequest(http.MethodPost, "/api/session/task", c.body))
		if rec.Code != c.want {
			t.Fatalf("%s: code = %d, want %d (%s)", c.name, rec.Code, c.want, rec.Body.String())
		}
	}
}

func TestSubagentTranscriptRoute(t *testing.T) {
	srv, _ := newTestServer(t, "secret")

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodGet, "/api/history/subagent?id=x", ""))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("缺 agent 应 400，得到 %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodGet, "/api/history/subagent?id=11111111-2222-4333-8444-555555555555&agent=abc", ""))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("没有转录应 404，得到 %d", rec.Code)
	}
}

func TestSubagentRoutesNeedAuth(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	for _, tc := range []struct{ method, target string }{
		{http.MethodGet, "/api/history/subagent?id=a&agent=b"},
		{http.MethodGet, "/api/history/subagent-usage?id=a"},
		{http.MethodPost, "/api/session/task"},
	} {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, httptest.NewRequest(tc.method, tc.target, strings.NewReader(`{}`)))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s: code = %d, want 401", tc.method, tc.target, rec.Code)
		}
	}
}

// 累计消耗的轻量入口：转录还没落盘时回空数组（刚建的空对话，不是错误）。
func TestSubagentUsageRoute(t *testing.T) {
	srv, _ := newTestServer(t, "secret")

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodGet, "/api/history/subagent-usage", ""))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("缺 id 应 400，得到 %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodGet, "/api/history/subagent-usage?id=11111111-2222-4333-8444-555555555555", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("没有转录应回空数组，得到 %d (%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"subagents":[]`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}
