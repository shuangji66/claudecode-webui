package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestHistoryPreview(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	id := "dddddddd-1111-4222-8333-444444444444"
	dir := filepath.Join(srv.d.HistoryDir, "proj")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	body := `{"type":"user","message":{"content":"问一下"}}` + "\n" +
		`{"type":"assistant","message":{"content":[{"type":"text","text":"答一下"}]}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodGet, "/api/history/preview?id="+id, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
	var got struct {
		User      string `json:"user"`
		Assistant string `json:"assistant"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("json: %v", err)
	}
	if got.User != "问一下" || got.Assistant != "答一下" {
		t.Fatalf("preview = %+v", got)
	}
}

func TestHistoryPreviewErrors(t *testing.T) {
	srv, _ := newTestServer(t, "secret")

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodGet, "/api/history/preview", ""))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("缺 id 应 400，得到 %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodGet, "/api/history/preview?id=eeeeeeee-1111-4222-8333-444444444444", ""))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("没有转录应 404，得到 %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/history/preview?id=x", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("未鉴权应 401，得到 %d", rec.Code)
	}
}
