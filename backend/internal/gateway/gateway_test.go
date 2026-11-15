package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ccweb/backend/internal/agent/manager"
	"ccweb/backend/internal/agent/session"
	"ccweb/backend/internal/authz"
	"ccweb/backend/internal/config"
	"ccweb/backend/internal/hub"
	"ccweb/backend/internal/settings"
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
	store, err := settings.Open(filepath.Join(t.TempDir(), "settings.json"))
	if err != nil {
		t.Fatalf("settings.Open: %v", err)
	}
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
		Settings:      store,
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
		"index.html":          "no-store, must-revalidate",
		"assets/index-abc.js": "public, max-age=31536000, immutable",
		"favicon.ico":         "public, max-age=86400",
	}
	for name, want := range cases {
		if got := cacheControlFor(name); got != want {
			t.Fatalf("cacheControlFor(%q) = %q, want %q", name, got, want)
		}
	}
}

// 缺失的静态资源必须 404，不能回退成 index.html —— 否则浏览器拿到
// text/html 的"JS"，模块加载失败，整页白屏。
func TestMissingAssetReturns404(t *testing.T) {
	srv, _ := newTestServer(t, "")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/assets/index-oldhash.js", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("缺失资源应 404，实际 %d（body 前 40 字节：%s）", rec.Code, rec.Body.String()[:min(40, rec.Body.Len())])
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
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

func putSettings(t *testing.T, srv *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/settings", strings.NewReader(body)))
	return rec
}

func TestPutSettingsProvidersPersistAndMask(t *testing.T) {
	srv, _ := newTestServer(t, "")
	rec := putSettings(t, srv, `{"providers":[{"id":"gw","name":"网关","protocol":"anthropic-messages","base_url":"https://relay.example","api_key":"sk-ant-supersecret-value","models":["m1","m2"]}],"selected":{"provider":"gw","model":"m1"}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT code = %d: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "supersecret") {
		t.Fatalf("PUT 响应泄露密钥: %s", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/settings", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET code = %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "supersecret") {
		t.Fatalf("GET 响应泄露密钥: %s", rec.Body.String())
	}
	var pub struct {
		Providers []struct {
			ID        string   `json:"id"`
			APIKeySet bool     `json:"api_key_set"`
			Models    []string `json:"models"`
		} `json:"providers"`
		Selected struct {
			Provider string `json:"provider"`
			Model    string `json:"model"`
		} `json:"selected"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &pub); err != nil {
		t.Fatalf("解析: %v", err)
	}
	if len(pub.Providers) != 1 || !pub.Providers[0].APIKeySet {
		t.Fatalf("providers = %+v", pub.Providers)
	}
	if len(pub.Providers[0].Models) != 2 {
		t.Fatalf("models = %v", pub.Providers[0].Models)
	}
	if pub.Selected.Model != "m1" {
		t.Fatalf("selected = %+v", pub.Selected)
	}
}

// 只改模型列表时，密钥留空不能把已存密钥抹掉。
func TestPutSettingsKeepsSecretWhenEmpty(t *testing.T) {
	srv, _ := newTestServer(t, "")
	if rec := putSettings(t, srv, `{"providers":[{"id":"gw","api_key":"sk-keep-me"}]}`); rec.Code != http.StatusOK {
		t.Fatalf("PUT code = %d: %s", rec.Code, rec.Body.String())
	}
	if rec := putSettings(t, srv, `{"providers":[{"id":"gw","api_key":"","models":["m1"]}]}`); rec.Code != http.StatusOK {
		t.Fatalf("PUT code = %d", rec.Code)
	}

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/settings", nil))
	var pub struct {
		Providers []struct {
			APIKeySet bool     `json:"api_key_set"`
			Models    []string `json:"models"`
		} `json:"providers"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &pub)
	if len(pub.Providers) != 1 || !pub.Providers[0].APIKeySet {
		t.Fatal("空串不应清空已保存的密钥")
	}
	if len(pub.Providers[0].Models) != 1 {
		t.Fatalf("models 未更新: %v", pub.Providers[0].Models)
	}
}

func TestPutSettingsClearKeyExplicit(t *testing.T) {
	srv, _ := newTestServer(t, "")
	putSettings(t, srv, `{"providers":[{"id":"gw","api_key":"sk-x"}]}`)
	putSettings(t, srv, `{"providers":[{"id":"gw","clear_key":true}]}`)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/settings", nil))
	var pub struct {
		Providers []struct {
			APIKeySet bool `json:"api_key_set"`
		} `json:"providers"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &pub)
	if pub.Providers[0].APIKeySet {
		t.Fatal("显式清除后 api_key_set 应为 false")
	}
}

func TestPutSettingsRejectsDuplicateProvider(t *testing.T) {
	srv, _ := newTestServer(t, "")
	rec := putSettings(t, srv, `{"providers":[{"id":"a"},{"id":"a"}]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("重复 ID 应 400，实际 %d", rec.Code)
	}
}

func TestSettingsRequireAuth(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/settings", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("code = %d, want 401", rec.Code)
	}
}

func TestInfoExposesDataDir(t *testing.T) {
	srv, _ := newTestServer(t, "")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/info", nil))
	var info map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &info)
	for _, k := range []string{"data_dir", "claude_home", "settings_file"} {
		if _, ok := info[k]; !ok {
			t.Fatalf("/api/info 缺少 %s", k)
		}
	}
}
