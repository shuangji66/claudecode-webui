package gateway

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeDirs struct {
	dirs    []string
	removed []string
	listErr error
	delErr  error
}

func (f *fakeDirs) List(uid int) ([]string, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.dirs, nil
}

func (f *fakeDirs) Remove(uid int, path string) error {
	if f.delErr != nil {
		return f.delErr
	}
	f.removed = append(f.removed, path)
	kept := make([]string, 0, len(f.dirs))
	for _, d := range f.dirs {
		if d != path {
			kept = append(kept, d)
		}
	}
	f.dirs = kept
	return nil
}

// withDirs 换掉测试服务器的目录依赖。
func withDirs(t *testing.T, dirs DirAuth) *Server {
	return withProtected(t, dirs, nil)
}

func withProtected(t *testing.T, dirs DirAuth, protected []string) *Server {
	t.Helper()
	srv, _ := newTestServer(t, "")
	srv.d.Dirs = dirs
	srv.d.DirsProtected = protected
	return srv
}

func dirsRequest(srv *Server, method, path, body string, uid string) *httptest.ResponseRecorder {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	if uid != "" {
		// 统一网关校验登录态之后注入的身份头。
		r.Header.Set("X-Trim-Userid", uid)
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, r)
	return rec
}

func decodeDirs(t *testing.T, rec *httptest.ResponseRecorder) dirsPayload {
	t.Helper()
	var p dirsPayload
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatalf("响应不是 JSON: %v (%s)", err, rec.Body.String())
	}
	return p
}

// 授权是按飞牛用户记账的：没有网关身份头就没有可查的东西，必须说清原因，
// 而不是回一个空列表让人以为「还没授权过任何目录」。
func TestListDirsWithoutGatewayUID(t *testing.T) {
	srv := withDirs(t, &fakeDirs{dirs: []string{"/vol1/home/user"}})
	rec := dirsRequest(srv, http.MethodGet, "/api/dirs", "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d", rec.Code)
	}
	p := decodeDirs(t, rec)
	if len(p.Dirs) != 0 || p.Error == "" {
		t.Fatalf("payload = %+v，应给空列表 + 原因", p)
	}
	if !strings.Contains(p.Error, "飞牛用户") {
		t.Errorf("原因要指向「拿不到用户」：%q", p.Error)
	}
}

func TestListDirsOK(t *testing.T) {
	srv := withDirs(t, &fakeDirs{dirs: []string{"/vol1/home/user", "/vol2/share"}})
	rec := dirsRequest(srv, http.MethodGet, "/api/dirs", "", "1000")
	p := decodeDirs(t, rec)
	if p.UID != 1000 {
		t.Errorf("uid = %d", p.UID)
	}
	if len(p.Dirs) != 2 || p.Dirs[1] != "/vol2/share" {
		t.Fatalf("dirs = %v", p.Dirs)
	}
	if p.Error != "" {
		t.Errorf("error = %q", p.Error)
	}
}

func TestListDirsGatewayError(t *testing.T) {
	srv := withDirs(t, &fakeDirs{listErr: errors.New("飞牛接口失败（200004）：scope denied")})
	p := decodeDirs(t, dirsRequest(srv, http.MethodGet, "/api/dirs", "", "1000"))
	if p.Error == "" || !strings.Contains(p.Error, "scope") {
		t.Fatalf("payload = %+v，必须把网关原因带出来", p)
	}
	if len(p.Dirs) != 0 {
		t.Errorf("失败时不该有目录：%v", p.Dirs)
	}
}

func TestListDirsWithoutDirAuth(t *testing.T) {
	srv, _ := newTestServer(t, "")
	p := decodeDirs(t, dirsRequest(srv, http.MethodGet, "/api/dirs", "", "1000"))
	if p.Error == "" {
		t.Fatal("没接飞牛接口时也要给出原因")
	}
}

// 删除后直接回撤销后的列表：前端不用再查一次，也不会停在「以为删掉了」的状态。
func TestRemoveDirReturnsFreshList(t *testing.T) {
	dirs := &fakeDirs{dirs: []string{"/vol1/home/user", "/vol2/share"}}
	srv := withDirs(t, dirs)
	rec := dirsRequest(srv, http.MethodPost, "/api/dirs/remove", `{"path":"/vol1/home/user"}`, "1000")
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d，body=%s", rec.Code, rec.Body.String())
	}
	p := decodeDirs(t, rec)
	if len(p.Dirs) != 1 || p.Dirs[0] != "/vol2/share" {
		t.Fatalf("dirs = %v", p.Dirs)
	}
	if len(dirs.removed) != 1 || dirs.removed[0] != "/vol1/home/user" {
		t.Fatalf("removed = %v", dirs.removed)
	}
}

func TestRemoveDirRejectsBadInput(t *testing.T) {
	dirs := &fakeDirs{dirs: []string{"/vol1/home/user"}}
	srv := withDirs(t, dirs)

	// 相对路径：/api/v1/trimapp 的 data.path 是绝对路径，别把工作区相对路径喂进去。
	rec := dirsRequest(srv, http.MethodPost, "/api/dirs/remove", `{"path":"home/user"}`, "1000")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("相对路径 code = %d，应 400", rec.Code)
	}
	// 没有网关身份头：不能删。
	rec = dirsRequest(srv, http.MethodPost, "/api/dirs/remove", `{"path":"/vol1/home/user"}`, "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("无 uid code = %d，应 403", rec.Code)
	}
	if len(dirs.removed) != 0 {
		t.Fatalf("不该真的删：%v", dirs.removed)
	}
}

func TestRemoveDirGatewayError(t *testing.T) {
	srv := withDirs(t, &fakeDirs{dirs: []string{"/a"}, delErr: errors.New("飞牛接口失败（200004）：scope denied")})
	rec := dirsRequest(srv, http.MethodPost, "/api/dirs/remove", `{"path":"/a"}`, "1000")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("code = %d，应 502（上游失败）", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "scope") {
		t.Fatalf("body = %s，应带上游原因", rec.Body.String())
	}
}

func TestDirsRequireAuth(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	for _, req := range []*http.Request{
		httptest.NewRequest(http.MethodGet, "/api/dirs", nil),
		httptest.NewRequest(http.MethodPost, "/api/dirs/remove", strings.NewReader(`{"path":"/a"}`)),
	} {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s 无 token 应 401，实际 %d", req.Method, req.URL.Path, rec.Code)
		}
	}
}

// 应用自己的安装目录是安装包固有目录：撤销它等于让运行中的进程读不到自己的二进制，
// 界面里不给按钮，后端也必须挡住（不能只靠前端）。
func TestRemoveDirRefusesAppOwnDirs(t *testing.T) {
	app := filepath.Join(t.TempDir(), "ClaudeCode")
	bin := filepath.Join(app, "bin")
	dirs := &fakeDirs{dirs: []string{app, bin, "/vol1/1000/tmp"}}
	srv := withProtected(t, dirs, []string{app, bin})

	for _, p := range []string{app, bin, filepath.Join(bin, "assets")} {
		rec := dirsRequest(srv, http.MethodPost, "/api/dirs/remove", `{"path":"`+p+`"}`, "1000")
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s 应 400，实际 %d (%s)", p, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "不能撤销") {
			t.Errorf("原因要说明白：%s", rec.Body.String())
		}
	}
	// 撤销父目录同样会波及应用目录（trim_acl 一并失效）。
	rec := dirsRequest(srv, http.MethodPost, "/api/dirs/remove", `{"path":"`+filepath.Dir(app)+`"}`, "1000")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("父目录应 400，实际 %d", rec.Code)
	}
	if len(dirs.removed) != 0 {
		t.Fatalf("不该真的删：%v", dirs.removed)
	}

	// 正常目录照旧可撤销。
	if rec := dirsRequest(srv, http.MethodPost, "/api/dirs/remove", `{"path":"/vol1/1000/tmp"}`, "1000"); rec.Code != http.StatusOK {
		t.Fatalf("普通目录应成功，实际 %d (%s)", rec.Code, rec.Body.String())
	}
}

// 列表把受保护路径一起回给前端：界面据此不给撤销按钮。
func TestListDirsReportsProtected(t *testing.T) {
	app := filepath.Join(t.TempDir(), "ClaudeCode")
	srv := withProtected(t, &fakeDirs{dirs: []string{app}}, []string{app})
	p := decodeDirs(t, dirsRequest(srv, http.MethodGet, "/api/dirs", "", "1000"))
	if len(p.Protected) != 1 || p.Protected[0] != app {
		t.Fatalf("protected = %v", p.Protected)
	}
}

func TestProtectedDirsCoversInstallRootAndData(t *testing.T) {
	data := t.TempDir()
	got := ProtectedDirs(data, filepath.Join(data, "claude"))
	if len(got) == 0 {
		t.Fatal("至少要含数据目录")
	}
	has := func(p string) bool {
		real, err := filepath.EvalSymlinks(p)
		if err != nil {
			real = p
		}
		for _, g := range got {
			if g == filepath.Clean(real) {
				return true
			}
		}
		return false
	}
	if !has(data) {
		t.Errorf("缺数据目录：%v", got)
	}
	// 测试二进制的安装根（go test 的临时可执行文件所在目录的上一级）也要在列表里。
	exe, err := os.Executable()
	if err == nil && !has(filepath.Dir(filepath.Dir(exe))) {
		t.Errorf("缺二进制安装根：%v", got)
	}
}
