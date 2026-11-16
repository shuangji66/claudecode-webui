package gateway

import (
	"archive/zip"
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHistoryExportServesZip(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	id := "99999999-aaaa-4bbb-8ccc-dddddddddddd"
	dir := filepath.Join(srv.d.HistoryDir, "proj")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(`{"type":"user"}`+"\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodGet, "/api/history/export?id="+id, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/zip" {
		t.Fatalf("content-type = %q", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.Contains(cd, "claude-session-"+id+".zip") {
		t.Fatalf("content-disposition = %q", cd)
	}
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatalf("zip: %v", err)
	}
	if len(zr.File) != 1 || zr.File[0].Name != id+".jsonl" {
		t.Fatalf("entries = %+v", zr.File)
	}
}

func TestHistoryExportErrors(t *testing.T) {
	srv, _ := newTestServer(t, "secret")

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodGet, "/api/history/export", ""))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("缺 id 应 400，得到 %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodGet, "/api/history/export?id=11111111-2222-4333-8444-555555555555", ""))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("没有转录应 404，得到 %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/history/export?id=x", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("未鉴权应 401，得到 %d", rec.Code)
	}
}
