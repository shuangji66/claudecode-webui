package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ccweb/backend/internal/claudebin"
)

// fakeDeploy 实现 ClaudeDeployer：网关测试不碰网络、不碰真实版本目录。
type fakeDeploy struct {
	status     claudebin.Status
	check      claudebin.CheckResult
	checkErr   error
	installErr error
	activeErr  error
	installed  []string
	cancelled  int
	deleted    []string
	deleteErr  error
	// onDelete 在真正删除前调用，用来断言「进程已经结束」这个顺序。
	onDelete func()
	activated  []string
	sources    []string
}

func (f *fakeDeploy) Status() claudebin.Status { return f.status }

func (f *fakeDeploy) Check(context.Context) (claudebin.CheckResult, error) {
	return f.check, f.checkErr
}

func (f *fakeDeploy) StartInstall(version, source string) error {
	if f.installErr != nil {
		return f.installErr
	}
	f.installed = append(f.installed, version+"@"+source)
	return nil
}

func (f *fakeDeploy) CancelInstall() error {
	f.cancelled++
	return nil
}

func (f *fakeDeploy) Delete(version string) error {
	if f.onDelete != nil {
		f.onDelete()
	}
	if f.deleteErr != nil {
		return f.deleteErr
	}
	f.deleted = append(f.deleted, version)
	return nil
}

func (f *fakeDeploy) SetActive(version string) error {
	if f.activeErr != nil {
		return f.activeErr
	}
	f.activated = append(f.activated, version)
	f.status.Active = version
	return nil
}

func (f *fakeDeploy) SetSource(source string) error {
	f.sources = append(f.sources, source)
	f.status.Source = source
	return nil
}

func withDeploy(t *testing.T, f *fakeDeploy) *Server {
	t.Helper()
	srv, _ := newTestServer(t, "secret")
	srv.d.Claude = f
	return srv
}

func authedRequest(method, path, body string) *http.Request {
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	req.Header.Set("Authorization", "Bearer secret")
	return req
}

func TestClaudeRoutesRequireToken(t *testing.T) {
	srv := withDeploy(t, &fakeDeploy{})
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/api/claude/status"},
		{http.MethodPost, "/api/claude/check"},
		{http.MethodPost, "/api/claude/install"},
		{http.MethodPost, "/api/claude/cancel"},
		{http.MethodDelete, "/api/claude/version"},
		{http.MethodPost, "/api/claude/active"},
		{http.MethodPost, "/api/claude/source"},
	} {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, httptest.NewRequest(route.method, route.path, nil))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s 无 token 应 401，实际 %d", route.method, route.path, rec.Code)
		}
	}
}

func TestClaudeStatusShape(t *testing.T) {
	srv := withDeploy(t, &fakeDeploy{status: claudebin.Status{
		Platform: "linux-x64",
		Dir:      "/data/claude/versions",
		Installed: []claudebin.Version{
			{Version: "2.1.325", Path: "/data/claude/versions/2.1.325/claude", Size: 365842960},
		},
		Active: "2.1.325",
		Source: claudebin.SourceNpmmirror,
		Latest: "2.1.325",
	}})
	srv.d.Manager.(*fakeMgr).using = map[string][]string{"/data/claude/versions/2.1.325/claude": {"sess-1"}}

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodGet, "/api/claude/status", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d, body=%s", rec.Code, rec.Body.String())
	}
	var got claudebin.Status
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("解析: %v", err)
	}
	if got.Platform != "linux-x64" || got.Active != "2.1.325" || len(got.Installed) != 1 {
		t.Fatalf("状态不符: %+v", got)
	}
	// in_use 由网关从 manager 现算：claudebin 不认识会话。
	if got.Installed[0].InUse != 1 {
		t.Fatalf("in_use 应为 1，实际 %d", got.Installed[0].InUse)
	}
}

func TestClaudeInstallPassesVersionAndSource(t *testing.T) {
	f := &fakeDeploy{}
	srv := withDeploy(t, f)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodPost, "/api/claude/install", `{"version":"2.1.325","source":"official"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d, body=%s", rec.Code, rec.Body.String())
	}
	if len(f.installed) != 1 || f.installed[0] != "2.1.325@official" {
		t.Fatalf("安装请求未透传: %v", f.installed)
	}
}

func TestClaudeInstallConflictAndBadRequest(t *testing.T) {
	f := &fakeDeploy{installErr: claudebin.ErrBusy}
	srv := withDeploy(t, f)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodPost, "/api/claude/install", `{"version":"2.1.325"}`))
	if rec.Code != http.StatusConflict {
		t.Fatalf("已有任务应 409，实际 %d", rec.Code)
	}

	f.installErr = nil
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodPost, "/api/claude/install", `{}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("空版本号应 400，实际 %d", rec.Code)
	}
}

func TestClaudeCancel(t *testing.T) {
	f := &fakeDeploy{}
	srv := withDeploy(t, f)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodPost, "/api/claude/cancel", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("取消失败: code=%d body=%s", rec.Code, rec.Body.String())
	}
	if f.cancelled != 1 {
		t.Fatalf("取消未透传: %d", f.cancelled)
	}
}

func TestClaudeDeleteVersion(t *testing.T) {
	f := &fakeDeploy{status: claudebin.Status{Installed: []claudebin.Version{
		{Version: "2.1.325", Path: "/data/versions/2.1.325/claude"},
		{Version: "2.1.324", Path: "/data/versions/2.1.324/claude"},
	}}}
	srv := withDeploy(t, f)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodDelete, "/api/claude/version?version=2.1.324", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("删除失败: code=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(f.deleted) != 1 || f.deleted[0] != "2.1.324" {
		t.Fatalf("删除请求未透传: %v", f.deleted)
	}
}

// 旧版本还有会话在跑时，删除要先把这些进程结束掉，再删二进制：
// 只删目录会让进程继续跑一份已经不存在的文件。
func TestClaudeDeleteVersionStopsSessionsFirst(t *testing.T) {
	f := &fakeDeploy{status: claudebin.Status{Installed: []claudebin.Version{
		{Version: "2.1.324", Path: "/data/versions/2.1.324/claude"},
	}}}
	srv := withDeploy(t, f)
	mgr := srv.d.Manager.(*fakeMgr)
	mgr.using = map[string][]string{"/data/versions/2.1.324/claude": {"sess-a", "sess-b"}}
	f.onDelete = func() {
		if len(mgr.closed) != 2 {
			t.Fatalf("删二进制时还有 %d 个会话没结束: %v", 2-len(mgr.closed), mgr.closed)
		}
	}

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodDelete, "/api/claude/version?version=2.1.324", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("删除失败: code=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(f.deleted) != 1 || f.deleted[0] != "2.1.324" {
		t.Fatalf("删除请求未透传: %v", f.deleted)
	}
	if len(mgr.closed) != 2 || mgr.closed[0] != "sess-a" || mgr.closed[1] != "sess-b" {
		t.Fatalf("应结束使用该版本的两个会话: %v", mgr.closed)
	}
}

// 生效版本不能删。这一步要挡在结束进程之前：注定失败的删除不该打断对话。
func TestClaudeDeleteActiveDoesNotStopSessions(t *testing.T) {
	f := &fakeDeploy{status: claudebin.Status{
		Installed: []claudebin.Version{{Version: "2.1.324", Path: "/data/versions/2.1.324/claude"}},
		Active:    "2.1.324",
	}}
	srv := withDeploy(t, f)
	mgr := srv.d.Manager.(*fakeMgr)
	mgr.using = map[string][]string{"/data/versions/2.1.324/claude": {"sess-a"}}

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodDelete, "/api/claude/version?version=2.1.324", ""))
	if rec.Code != http.StatusConflict {
		t.Fatalf("生效版本应 409，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if len(f.deleted) != 0 || len(mgr.closed) != 0 {
		t.Fatalf("不应删除、也不应结束会话: deleted=%v closed=%v", f.deleted, mgr.closed)
	}
}

func TestClaudeDeleteVersionActiveOrMissing(t *testing.T) {
	f := &fakeDeploy{
		status: claudebin.Status{
			Installed: []claudebin.Version{{Version: "2.1.325", Path: "/data/versions/2.1.325/claude"}},
			Active:    "2.1.325",
		},
	}
	srv := withDeploy(t, f)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodDelete, "/api/claude/version?version=2.1.325", ""))
	if rec.Code != http.StatusConflict {
		t.Fatalf("生效版本应 409，实际 %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodDelete, "/api/claude/version?version=9.9.9", ""))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("未安装版本应 404，实际 %d", rec.Code)
	}
}

func TestClaudeActivateAndSource(t *testing.T) {
	f := &fakeDeploy{}
	srv := withDeploy(t, f)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodPost, "/api/claude/active", `{"version":"2.1.311"}`))
	if rec.Code != http.StatusOK || len(f.activated) != 1 || f.activated[0] != "2.1.311" {
		t.Fatalf("切换版本未生效: code=%d activated=%v", rec.Code, f.activated)
	}

	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodPost, "/api/claude/source", `{"source":"official"}`))
	if rec.Code != http.StatusOK || len(f.sources) != 1 || f.sources[0] != "official" {
		t.Fatalf("切换源未生效: code=%d sources=%v", rec.Code, f.sources)
	}
}

func TestClaudeDeployDisabledReturns503(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodGet, "/api/claude/status", ""))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("未装配部署管理应 503，实际 %d", rec.Code)
	}
}

func TestInfoOmitsClaudeFieldsWhenDeployDisabled(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodGet, "/api/info", ""))
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("解析: %v", err)
	}
	// 没有托管安装能力时不能给 false：前端会据此弹一个装不了东西的安装提示。
	if _, ok := body["claude_installed"]; ok {
		t.Fatalf("未装配部署管理时不应带 claude_installed: %v", body["claude_installed"])
	}
}

func TestInfoReportsInstalledClaude(t *testing.T) {
	srv := withDeploy(t, &fakeDeploy{status: claudebin.Status{
		Installed: []claudebin.Version{{Version: "2.1.325"}},
		Active:    "2.1.325",
	}})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, authedRequest(http.MethodGet, "/api/info", ""))
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("解析: %v", err)
	}
	if body["claude_installed"] != true || body["claude_active"] != "2.1.325" {
		t.Fatalf("info 未带上安装状态: %v / %v", body["claude_installed"], body["claude_active"])
	}
}
