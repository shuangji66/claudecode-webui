package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ccweb/backend/internal/agent/manager"
	"ccweb/backend/internal/agent/session"
	"ccweb/backend/internal/authz"
	"ccweb/backend/internal/config"
	"ccweb/backend/internal/hub"
)

type fakeMgr struct {
	created []string
	closed  []string
	failOn  string
}

func (f *fakeMgr) Binary() string { return "/opt/cc/claude" }

func (f *fakeMgr) Create(cwd, model, mode string) (manager.Info, error) {
	if f.failOn == "create" {
		return manager.Info{}, errFake
	}
	f.created = append(f.created, cwd)
	return manager.Info{ID: "sess-1", Cwd: cwd, State: "ready"}, nil
}

func (f *fakeMgr) Get(id string) (*session.Session, bool) {
	if id == "sess-1" {
		return &session.Session{ID: "sess-1", Cwd: "/tmp"}, true
	}
	return nil, false
}

func (f *fakeMgr) List() []manager.Info {
	return []manager.Info{{ID: "sess-1", Cwd: "/tmp", State: "ready"}}
}

func (f *fakeMgr) Close(id string) error {
	if f.failOn == "close" {
		return errFake
	}
	f.closed = append(f.closed, id)
	return nil
}

type fakeErr struct{}

func (fakeErr) Error() string { return "fake error" }

var errFake = fakeErr{}

func newTestServer(t *testing.T, token string) (*Server, *fakeMgr) {
	t.Helper()
	mgr := &fakeMgr{}
	deps := Deps{
		Cfg: config.Config{
			BaseURL:     "",
			AdminSock:   "/tmp/cc.sock",
			Version:     "test-1",
			MaxSessions: 4,
		},
		Guard:         authz.New(token),
		Hub:           hub.New(),
		Manager:       mgr,
		HistoryDir:    t.TempDir(),
		ProjectsRoot:  t.TempDir(),
		ClaudeVersion: "2.1.325",
		StartedAt:     time.Now(),
	}
	return New(deps, nil), mgr
}

func TestHealthNeedsNoAuth(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d", rec.Code)
	}
}

func TestInfoRequiresToken(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/info", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("无 token 应 401，实际 %d", rec.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/info", nil)
	req.Header.Set("Authorization", "Bearer secret")
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("带 token 应 200，实际 %d", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("解析: %v", err)
	}
	if body["claude_version"] != "2.1.325" {
		t.Fatalf("claude_version = %v", body["claude_version"])
	}
	if body["auth_required"] != true {
		t.Fatal("auth_required 应为 true")
	}
}

func TestCreateSessionValidatesCwd(t *testing.T) {
	srv, mgr := newTestServer(t, "")
	body := `{"cwd":"/definitely/not/here"}`
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/session", strings.NewReader(body)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("不存在的目录应 400，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if len(mgr.created) != 0 {
		t.Fatal("校验失败时不应创建会话")
	}
}

func TestCreateSessionHappyPath(t *testing.T) {
	srv, mgr := newTestServer(t, "")
	dir := t.TempDir()
	body := `{"cwd":"` + dir + `"}`
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/session", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
	if len(mgr.created) != 1 || mgr.created[0] != dir {
		t.Fatalf("created = %v", mgr.created)
	}
	var info manager.Info
	_ = json.Unmarshal(rec.Body.Bytes(), &info)
	if info.ID != "sess-1" {
		t.Fatalf("id = %q", info.ID)
	}
}

func TestCloseSession(t *testing.T) {
	srv, mgr := newTestServer(t, "")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/session?id=sess-1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d", rec.Code)
	}
	if len(mgr.closed) != 1 || mgr.closed[0] != "sess-1" {
		t.Fatalf("closed = %v", mgr.closed)
	}

	mgr.failOn = "close"
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/session?id=nope", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("关闭失败应 404，实际 %d", rec.Code)
	}
}

func TestCloseSessionRequiresID(t *testing.T) {
	srv, _ := newTestServer(t, "")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/session", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d", rec.Code)
	}
}

func TestBaseURLStripsPrefix(t *testing.T) {
	h := withBaseURL("/app/ccweb", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(r.URL.Path))
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/app/ccweb/api/info", nil))
	if rec.Body.String() != "/api/info" {
		t.Fatalf("剥离后路径 = %q", rec.Body.String())
	}

	// 前缀外的请求必须 404，避免裸路径被外部扫描到。
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/info", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("前缀外应 404，实际 %d", rec.Code)
	}
}

func TestBaseURLRedirectsBarePrefix(t *testing.T) {
	h := withBaseURL("/app/ccweb", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/app/ccweb", nil))
	if rec.Code != http.StatusMovedPermanently {
		t.Fatalf("code = %d, want 301", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "/app/ccweb/" {
		t.Fatalf("Location = %q", loc)
	}
}

func TestRewriteBase(t *testing.T) {
	in := `<html><head><meta charset="utf-8"></head><body><script src="./assets/index-abc.js"></script><link href="./assets/app.css"></body></html>`
	out := string(rewriteBase([]byte(in), "/app/ccweb"))
	if !strings.Contains(out, `<base href="/app/ccweb/">`) {
		t.Fatalf("缺少 base 标签: %s", out)
	}
	if !strings.Contains(out, `src="/app/ccweb/assets/index-abc.js"`) {
		t.Fatalf("assets 未改写: %s", out)
	}
	if !strings.Contains(out, `href="/app/ccweb/assets/app.css"`) {
		t.Fatalf("css 未改写: %s", out)
	}
}

func TestRewriteBaseNoopWithoutPrefix(t *testing.T) {
	in := `<html><head></head><body><script src="./assets/a.js"></script></body></html>`
	if got := string(rewriteBase([]byte(in), "")); got != in {
		t.Fatalf("空前缀不应改动: %s", got)
	}
}

func TestCacheControlFor(t *testing.T) {
	cases := map[string]string{
		"index.html":          "no-cache, must-revalidate",
		"assets/index-abc.js": "public, max-age=31536000, immutable",
		"favicon.ico":         "public, max-age=86400",
	}
	for name, want := range cases {
		if got := cacheControlFor(name); got != want {
			t.Fatalf("cacheControlFor(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestUnknownRoute(t *testing.T) {
	srv, _ := newTestServer(t, "")
	rec := httptest.NewRecorder()
	// /api/xxx 未注册 → 落到 SPA；由于内嵌占位 index.html 存在，应返回 200 HTML。
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/xxx", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Fatalf("Content-Type = %q", ct)
	}
}
