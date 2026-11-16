package gateway

import (
	"encoding/base64"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"ccweb/backend/internal/agent/manager"
	"ccweb/backend/internal/agent/session"
	"ccweb/backend/internal/authz"
	"ccweb/backend/internal/config"
	"ccweb/backend/internal/hub"
	"ccweb/backend/internal/project"
	"ccweb/backend/internal/settings"
	"ccweb/backend/internal/skills"
	"ccweb/backend/internal/workspace"
)

type fakeMgr struct {
	created []string
	resumed []string
	closed  []string
	failOn  string
	inUse   map[string]bool
}

func (f *fakeMgr) Binary() string { return "/opt/cc/claude" }

func (f *fakeMgr) InUse(bin string) bool { return f.inUse[bin] }

func (f *fakeMgr) Create(cwd, model, mode string) (manager.Info, error) {
	if f.failOn == "create" {
		return manager.Info{}, errFake
	}
	f.created = append(f.created, cwd)
	return manager.Info{ID: "sess-1", Cwd: cwd, State: "ready"}, nil
}

func (f *fakeMgr) Resume(id, cwd, model, mode string) (manager.Info, error) {
	f.resumed = append(f.resumed, id)
	return manager.Info{ID: id, Cwd: cwd, State: "ready"}, nil
}

func (f *fakeMgr) Ensure(cwd, model, mode string) (manager.Info, error) {
	return f.Create(cwd, model, mode)
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
	root := t.TempDir()
	ws, err := workspace.Open(filepath.Join(t.TempDir(), "workspaces.json"), root)
	if err != nil {
		t.Fatalf("workspace.Open: %v", err)
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
		ProjectsRoot:  root,
		Settings:      store,
		Workspaces:    ws,
		Skills:        skills.New(filepath.Join(t.TempDir(), "skills")),
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
	dir := filepath.Join(srv.d.ProjectsRoot, "proj")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
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

func TestCreateSessionRejectsUnauthorizedDir(t *testing.T) {
	srv, mgr := newTestServer(t, "")
	dir := t.TempDir() // 在 ProjectsRoot 之外，且未加入授权列表
	body := `{"cwd":"` + dir + `"}`
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/session", strings.NewReader(body)))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("未授权目录应 403，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if len(mgr.created) != 0 {
		t.Fatal("未授权目录不应创建会话")
	}
}

func TestEnsureSessionUsesAuthorizedWorkspace(t *testing.T) {
	srv, mgr := newTestServer(t, "")
	dir := filepath.Join(srv.d.ProjectsRoot, "proj")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"cwd":"` + dir + `"}`
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/session/ensure", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
	if len(mgr.created) != 1 || mgr.created[0] != dir {
		t.Fatalf("created = %v", mgr.created)
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
// useSPAFS 用内存文件系统替换内嵌前端产物，避免测试依赖 frontend/dist 是否构建过。
func useSPAFS(t *testing.T, index string) {
	t.Helper()
	prev := spaFS
	spaFS = func() (fs.FS, error) {
		return fstest.MapFS{
			"index.html":    &fstest.MapFile{Data: []byte(index)},
			"assets/app.js": &fstest.MapFile{Data: []byte("console.log(1)")},
		}, nil
	}
	t.Cleanup(func() { spaFS = prev })
}

func TestMissingAssetReturns404(t *testing.T) {
	useSPAFS(t, "<html><head></head><body>app</body></html>")
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
	useSPAFS(t, "<html><head></head><body>app</body></html>")
	srv, _ := newTestServer(t, "")
	rec := httptest.NewRecorder()
	// /api/xxx 未注册 → 落到 SPA；前端路由应回退到 index.html。
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

func decodeWorkspaces(t *testing.T, rec *httptest.ResponseRecorder) ([]workspace.Entry, string) {
	t.Helper()
	var body struct {
		Workspaces []workspace.Entry `json:"workspaces"`
		Current    string            `json:"current"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("解析 workspaces: %v", err)
	}
	return body.Workspaces, body.Current
}

func TestWorkspacesListAddSwitchRemove(t *testing.T) {
	srv, _ := newTestServer(t, "")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/workspaces", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET code = %d", rec.Code)
	}
	items, current := decodeWorkspaces(t, rec)
	if len(items) != 1 || current != srv.d.ProjectsRoot {
		t.Fatalf("初始 workspaces = %+v current = %q", items, current)
	}

	added := filepath.Join(t.TempDir(), "authorized")
	if err := os.Mkdir(added, 0o755); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/workspaces", strings.NewReader(`{"path":"`+added+`"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST code = %d: %s", rec.Code, rec.Body.String())
	}
	items, current = decodeWorkspaces(t, rec)
	if len(items) != 2 || current != added {
		t.Fatalf("添加后 workspaces = %+v current = %q", items, current)
	}

	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/workspaces/current", strings.NewReader(`{"path":"`+srv.d.ProjectsRoot+`"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("switch code = %d: %s", rec.Code, rec.Body.String())
	}
	if _, current = decodeWorkspaces(t, rec); current != srv.d.ProjectsRoot {
		t.Fatalf("current = %q", current)
	}

	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/workspaces?path="+added, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE code = %d: %s", rec.Code, rec.Body.String())
	}
	items, _ = decodeWorkspaces(t, rec)
	if len(items) != 1 || items[0].Path != srv.d.ProjectsRoot {
		t.Fatalf("删除后 workspaces = %+v", items)
	}
}

func TestWorkspaceCannotRemoveWithRunningSession(t *testing.T) {
	srv, _ := newTestServer(t, "")
	// fakeMgr.List 固定返回 /tmp 的会话，因此移除 /tmp 应被拒绝。
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/workspaces?path=/tmp", nil))
	if rec.Code != http.StatusConflict {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestBrowseDirs(t *testing.T) {
	srv, _ := newTestServer(t, "")
	sub := filepath.Join(srv.d.ProjectsRoot, "alpha")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/fs/list?path="+srv.d.ProjectsRoot, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Path    string        `json:"path"`
		Parent  string        `json:"parent"`
		Entries []project.Dir `json:"entries"`
		Roots   []string      `json:"roots"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Path != srv.d.ProjectsRoot || len(body.Entries) != 1 || body.Entries[0].Name != "alpha" {
		t.Fatalf("body = %+v", body)
	}
	if len(body.Roots) == 0 || body.Roots[0] != srv.d.ProjectsRoot {
		t.Fatalf("roots = %+v", body.Roots)
	}
}

func TestBrowseDirsRejectsMissingPath(t *testing.T) {
	srv, _ := newTestServer(t, "")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/fs/list?path=/definitely/not/here", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d", rec.Code)
	}
}

func TestSettingsModelMetaAndPreferences(t *testing.T) {
	srv, _ := newTestServer(t, "")
	body := `{
	  "providers":[{"id":"gw","name":"网关","protocol":"anthropic-messages","base_url":"https://gw.example",
	    "models":["m1"],"model_meta":{"m1":{"name":"模型一","reasoning_efforts":["low","high"],"default_reasoning_effort":"high","supports_image":true}}}],
	  "selected":{"provider":"gw","model":"m1","effort":"low"},
	  "theme":"dark","locale":"en","font_size":16
	}`
	rec := putSettings(t, srv, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT code = %d: %s", rec.Code, rec.Body.String())
	}
	var pub struct {
		Providers []struct {
			ModelMeta map[string]struct {
				Name          string   `json:"name"`
				Efforts       []string `json:"reasoning_efforts"`
				DefaultEffort string   `json:"default_reasoning_effort"`
				SupportsImage bool     `json:"supports_image"`
			} `json:"model_meta"`
		} `json:"providers"`
		Selected struct {
			Effort string `json:"effort"`
		} `json:"selected"`
		Theme    string `json:"theme"`
		Locale   string `json:"locale"`
		FontSize int    `json:"font_size"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &pub); err != nil {
		t.Fatal(err)
	}
	if pub.Theme != "dark" || pub.Locale != "en" || pub.FontSize != 16 {
		t.Fatalf("prefs = %+v", pub)
	}
	if pub.Selected.Effort != "low" {
		t.Fatalf("effort = %q", pub.Selected.Effort)
	}
	m := pub.Providers[0].ModelMeta["m1"]
	if m.Name != "模型一" || !m.SupportsImage || m.DefaultEffort != "high" || len(m.Efforts) != 2 {
		t.Fatalf("model meta = %+v", m)
	}
}

func TestApplyProxyPersistsAndRestartsSessions(t *testing.T) {
	srv, mgr := newTestServer(t, "")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/settings/proxy", strings.NewReader(`{"proxy_url":"socks5://127.0.0.1:1080"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Settings struct {
			ProxyURL string `json:"proxy_url"`
		} `json:"settings"`
		Sessions []manager.Info `json:"sessions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Settings.ProxyURL != "socks5://127.0.0.1:1080" {
		t.Fatalf("proxy_url = %q", body.Settings.ProxyURL)
	}
	if len(mgr.closed) != 1 || mgr.closed[0] != "sess-1" {
		t.Fatalf("旧会话应被关闭: %v", mgr.closed)
	}
	if len(mgr.resumed) != 1 || mgr.resumed[0] != "sess-1" {
		t.Fatalf("应按原对话 id 恢复: %v", mgr.resumed)
	}
	if len(body.Sessions) != 1 {
		t.Fatalf("sessions = %+v", body.Sessions)
	}
}

func TestDecodeAttachments(t *testing.T) {
	atts, err := decodeAttachments([]wireAttachment{
		{Name: "a.png", MediaType: "image/png", Data: base64.StdEncoding.EncodeToString([]byte("png"))},
		{Name: "a.txt", MediaType: "text/plain", Data: base64.StdEncoding.EncodeToString([]byte("hello"))},
	})
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(atts) != 2 || string(atts[0].Data) != "png" || string(atts[1].Data) != "hello" {
		t.Fatalf("atts = %+v", atts)
	}
	if _, err := decodeAttachments([]wireAttachment{{Name: "x.zip", MediaType: "application/zip", Data: "AAAA"}}); err == nil {
		t.Fatal("不支持的类型应报错")
	}
	if _, err := decodeAttachments([]wireAttachment{{Name: "x.txt", MediaType: "text/plain", Data: "不是 base64"}}); err == nil {
		t.Fatal("非法 base64 应报错")
	}
}

func TestRenameWorkspace(t *testing.T) {
	srv, _ := newTestServer(t, "")
	rec := httptest.NewRecorder()
	body := `{"path":"` + srv.d.ProjectsRoot + `","name":"我的项目"}`
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/workspaces/rename", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("rename code = %d: %s", rec.Code, rec.Body.String())
	}
	items, current := decodeWorkspaces(t, rec)
	if len(items) != 1 || items[0].Name != "我的项目" {
		t.Fatalf("items = %+v", items)
	}
	// 只改显示名：路径与当前工作区都不动
	if items[0].Path != srv.d.ProjectsRoot || current != srv.d.ProjectsRoot {
		t.Fatalf("path/current = %q/%q", items[0].Path, current)
	}

	rec = httptest.NewRecorder()
	body = `{"path":"/definitely/not/authorized","name":"x"}`
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/workspaces/rename", strings.NewReader(body)))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("未知目录 code = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestMkdirDir(t *testing.T) {
	srv, _ := newTestServer(t, "")
	rec := httptest.NewRecorder()
	body := `{"path":"` + srv.d.ProjectsRoot + `","name":"新建目录"}`
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/fs/mkdir", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("mkdir code = %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(srv.d.ProjectsRoot, "新建目录")
	if out.Path != want {
		t.Fatalf("path = %q, want %q", out.Path, want)
	}
	if st, err := os.Stat(want); err != nil || !st.IsDir() {
		t.Fatalf("目录未创建: %v", err)
	}

	// 名字带分隔符 → 400（不能借这个接口往任意路径写）
	rec = httptest.NewRecorder()
	body = `{"path":"` + srv.d.ProjectsRoot + `","name":"a/b"}`
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/fs/mkdir", strings.NewReader(body)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("非法名字 code = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestFsAccess(t *testing.T) {
	srv, _ := newTestServer(t, "")
	post := func(body string) (int, string) {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/fs/access", strings.NewReader(body)))
		return rec.Code, rec.Body.String()
	}
	type payload struct {
		Path     string `json:"path"`
		Writable bool   `json:"writable"`
		Reason   string `json:"reason"`
	}

	code, body := post(`{"path":"` + srv.d.ProjectsRoot + `"}`)
	if code != http.StatusOK {
		t.Fatalf("access code = %d: %s", code, body)
	}
	var ok payload
	if err := json.Unmarshal([]byte(body), &ok); err != nil {
		t.Fatal(err)
	}
	if !ok.Writable || ok.Reason != "" {
		t.Fatalf("可写目录应 writable=true: %+v", ok)
	}
	if ok.Path != filepath.Clean(srv.d.ProjectsRoot) {
		t.Fatalf("path = %q", ok.Path)
	}

	// 不存在的目录：仍是 200 + writable=false，前端据此改走飞牛授权。
	code, body = post(`{"path":"/definitely/not/here"}`)
	if code != http.StatusOK {
		t.Fatalf("未知目录 code = %d: %s", code, body)
	}
	var bad payload
	if err := json.Unmarshal([]byte(body), &bad); err != nil {
		t.Fatal(err)
	}
	if bad.Writable || bad.Reason == "" {
		t.Fatalf("不可写目录应带原因: %+v", bad)
	}
}

func TestGitRepos(t *testing.T) {
	srv, _ := newTestServer(t, "")
	repo := filepath.Join(srv.d.ProjectsRoot, "inner")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/git/repos?cwd="+srv.d.ProjectsRoot, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("repos code = %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Repos []struct {
			Path string `json:"path"`
			Root string `json:"root"`
		} `json:"repos"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Repos) != 1 || out.Repos[0].Path != "inner" || out.Repos[0].Root != repo {
		t.Fatalf("repos = %+v", out.Repos)
	}

	// 未授权的 cwd 一律 403，和其余 git 路由一致（用一个真实存在但在工作区外的目录）。
	outside := t.TempDir()
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/git/repos?cwd="+outside, nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("未授权 cwd code = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestFsHostFile(t *testing.T) {
	srv, _ := newTestServer(t, "")
	dir := t.TempDir()
	png := filepath.Join(dir, "shot.png")
	// 最小 PNG 头足以让 http.DetectContentType 认出 image/png。
	if err := os.WriteFile(png, append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 64)...), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	text := filepath.Join(dir, "notes.txt")
	if err := os.WriteFile(text, []byte("hello"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	// 扩展名是 .png、内容其实是 HTML：嗅探必须拦住。
	fake := filepath.Join(dir, "fake.png")
	if err := os.WriteFile(fake, []byte("<html><script>alert(1)</script></html>"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	post := func(path string) (int, string) {
		rec := httptest.NewRecorder()
		body := `{"path":"` + path + `"}`
		srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/fs/host-file", strings.NewReader(body)))
		return rec.Code, rec.Body.String()
	}

	code, body := post(png)
	if code != http.StatusOK {
		t.Fatalf("png code = %d: %s", code, body)
	}
	var out struct {
		Name      string `json:"name"`
		MediaType string `json:"media_type"`
		Size      int64  `json:"size"`
		Data      string `json:"data"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatal(err)
	}
	if out.Name != "shot.png" || out.MediaType != "image/png" || out.Size == 0 || out.Data == "" {
		t.Fatalf("payload = %+v", out)
	}

	// 非图片/PDF 一律拒绝：前端改用路径引用。
	if code, body := post(text); code != http.StatusUnsupportedMediaType {
		t.Fatalf("txt code = %d: %s", code, body)
	}
	if code, body := post(fake); code != http.StatusUnsupportedMediaType {
		t.Fatalf("伪装 png code = %d: %s", code, body)
	}
	if code, body := post("relative.png"); code != http.StatusBadRequest {
		t.Fatalf("相对路径 code = %d: %s", code, body)
	}
}
