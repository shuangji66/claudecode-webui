package gateway

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func TestFsTreeRequiresAuthAndWorkspace(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	root := srv.d.ProjectsRoot

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/fs/tree?cwd="+root, nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("无 token 应 401，实际 %d", rec.Code)
	}

	outside := t.TempDir()
	req := httptest.NewRequest(http.MethodGet, "/api/fs/tree?cwd="+outside, nil)
	req.Header.Set("Authorization", "Bearer secret")
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("未授权目录应 403，实际 %d: %s", rec.Code, rec.Body.String())
	}

	if err := os.Mkdir(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "readme.md"), []byte("# hi\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest(http.MethodGet, "/api/fs/tree?cwd="+root, nil)
	req.Header.Set("Authorization", "Bearer secret")
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
	var listing struct {
		Entries []struct {
			Name string `json:"name"`
			Type string `json:"type"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listing); err != nil {
		t.Fatal(err)
	}
	if len(listing.Entries) != 2 || listing.Entries[0].Name != "src" || listing.Entries[0].Type != "dir" {
		t.Fatalf("entries = %+v", listing.Entries)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/fs/tree?cwd="+root+"&path=../etc", nil)
	req.Header.Set("Authorization", "Bearer secret")
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("路径穿越应 403，实际 %d: %s", rec.Code, rec.Body.String())
	}
}

func TestFsCompleteRequiresAuthAndWorkspace(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	root := srv.d.ProjectsRoot
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "main.go"), []byte("package main"), 0o600); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/fs/complete?cwd="+root+"&q=src/ma", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("无 token 应 401，实际 %d", rec.Code)
	}

	outside := t.TempDir()
	req := httptest.NewRequest(http.MethodGet, "/api/fs/complete?cwd="+outside+"&q=ma", nil)
	req.Header.Set("Authorization", "Bearer secret")
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("未授权目录应 403，实际 %d: %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/fs/complete?cwd="+root+"&q=src/ma", nil)
	req.Header.Set("Authorization", "Bearer secret")
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
	var listing struct {
		Path    string `json:"path"`
		Entries []struct {
			Name string `json:"name"`
			Path string `json:"path"`
			Type string `json:"type"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listing); err != nil {
		t.Fatal(err)
	}
	if listing.Path != "src" || len(listing.Entries) != 1 || listing.Entries[0].Path != "src/main.go" {
		t.Fatalf("listing = %+v", listing)
	}

	// 越界查询只回空候选，不报错（用户还在打字）。
	req = httptest.NewRequest(http.MethodGet, "/api/fs/complete?cwd="+root+"&q=../../etc", nil)
	req.Header.Set("Authorization", "Bearer secret")
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("越界查询应 200 空候选，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listing); err != nil {
		t.Fatal(err)
	}
	if len(listing.Entries) != 0 {
		t.Fatalf("越界查询不该给候选: %+v", listing.Entries)
	}
}

func TestFsFileAndRawPreview(t *testing.T) {
	srv, _ := newTestServer(t, "")
	root := srv.d.ProjectsRoot
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "x.html"), []byte("<script>alert(1)</script>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "p.png"), []byte("\x89PNG\r\n\x1a\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/fs/file?cwd="+root+"&path=a.txt", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
	var file struct {
		Content string `json:"content"`
		Binary  bool   `json:"binary"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &file)
	if file.Content != "hello" || file.Binary {
		t.Fatalf("file = %+v", file)
	}

	// HTML 即使被请求为 raw 也不允许同源 inline，避免工作区文件执行脚本。
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/fs/raw?cwd="+root+"&path=x.html", nil))
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("HTML raw 应 415，实际 %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/fs/raw?cwd="+root+"&path=p.png", nil))
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("png raw: code=%d type=%q", rec.Code, rec.Header().Get("Content-Type"))
	}

	// 纯文本不走 raw：白名单只有图片/PDF，文本预览走 /api/fs/file 的 JSON。
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/fs/raw?cwd="+root+"&path=a.txt", nil))
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("txt raw 应 415，实际 %d", rec.Code)
	}
}

func TestGitStatusAPI(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("没有 git")
	}
	srv, _ := newTestServer(t, "")
	root := srv.d.ProjectsRoot
	runGit(t, root, "init", "-q")
	runGit(t, root, "config", "user.email", "test@example.com")
	runGit(t, root, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("a\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, root, "add", ".")
	runGit(t, root, "commit", "-qm", "init")
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("a\nb\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/git/status?cwd="+root, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
	var status struct {
		IsRepo  bool `json:"is_repo"`
		Entries []struct {
			Path     string `json:"path"`
			XY       string `json:"xy"`
			Unstaged *struct {
				Additions int `json:"additions"`
			} `json:"unstaged"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if !status.IsRepo || len(status.Entries) != 1 || status.Entries[0].XY != " M" {
		t.Fatalf("status = %+v", status)
	}

	// POST 必须鉴权、且 body 里的 cwd 也要过工作区校验。
	outside := t.TempDir()
	body := `{"cwd":"` + outside + `","path":"a.txt"}`
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/git/stage", strings.NewReader(body)))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("未授权 cwd 应 403，实际 %d: %s", rec.Code, rec.Body.String())
	}
}

func TestTerminalWSRejectsBeforeUpgrade(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	root := srv.d.ProjectsRoot

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ws/terminal?cwd="+root, nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("无 token 应 401，实际 %d", rec.Code)
	}

	outside := t.TempDir()
	req := httptest.NewRequest(http.MethodGet, "/ws/terminal?cwd="+outside+"&token=secret", nil)
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("未授权 cwd 应 403，实际 %d: %s", rec.Code, rec.Body.String())
	}
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "LC_ALL=C", "GIT_TERMINAL_PROMPT=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// 回归：工作区里的软链不能把右侧栏带出工作区。
//
// 授权判定曾经只做词法前缀比较，而 fsapi 又把 EvalSymlinks(cwd) 当围栏根，
// 于是 `<ws>/link -> 外部目录` 能过授权、围栏也认它，fs/git/terminal/skills
// 全部落到工作区外。现在 cwd 先解析真实路径再判授权。
func TestSidebarRejectsSymlinkEscape(t *testing.T) {
	srv, _ := newTestServer(t, "")
	root := srv.d.ProjectsRoot
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("无法创建符号链接: %v", err)
	}

	cases := []string{
		"/api/fs/tree?cwd=" + link,
		"/api/fs/file?cwd=" + link + "&path=secret.txt",
		"/api/fs/raw?cwd=" + link + "&path=secret.txt",
		"/api/git/status?cwd=" + link,
	}
	for _, u := range cases {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, u, nil))
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s: code = %d, want 403: %s", u, rec.Code, rec.Body.String())
		}
	}

	// 会话创建同理：软链 cwd 必须 403，而不是把 claude 拉起来。
	body := strings.NewReader(`{"cwd":"` + link + `"}`)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/session", body)
	req.Header.Set("Content-Type", "application/json")
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("软链 cwd 建会话: code = %d, want 403: %s", rec.Code, rec.Body.String())
	}

	// 工作区里的普通子目录仍然可用（别把围栏收得过紧）。
	sub := filepath.Join(root, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/fs/tree?cwd="+sub, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("子目录: code = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestFsDownloadFileAndFolder(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	root := srv.d.ProjectsRoot
	if err := os.MkdirAll(filepath.Join(root, "pkg", "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "pkg", "a.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "pkg", "sub", "b.txt"), []byte("world"), 0o600); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/fs/download?cwd="+root+"&path=pkg/a.txt", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("无 token 应 401，实际 %d", rec.Code)
	}

	outside := t.TempDir()
	req := httptest.NewRequest(http.MethodGet, "/api/fs/download?cwd="+outside+"&path=a.txt", nil)
	req.Header.Set("Authorization", "Bearer secret")
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("未授权目录应 403，实际 %d: %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/fs/download?cwd="+root+"&path=pkg/a.txt", nil)
	req.Header.Set("Authorization", "Bearer secret")
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("文件下载 code = %d: %s", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "hello" {
		t.Fatalf("body = %q", got)
	}
	if disposition := rec.Header().Get("Content-Disposition"); !strings.Contains(disposition, "attachment") || !strings.Contains(disposition, "a.txt") {
		t.Fatalf("Content-Disposition = %q", disposition)
	}

	// 目录下载是 zip：把响应体当 zip 读，条目名要带顶层目录。
	req = httptest.NewRequest(http.MethodGet, "/api/fs/download?cwd="+root+"&path=pkg", nil)
	req.Header.Set("Authorization", "Bearer secret")
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("目录下载 code = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Header().Get("Content-Disposition"), "pkg.zip") {
		t.Fatalf("目录下载的文件名 = %q", rec.Header().Get("Content-Disposition"))
	}
	body := rec.Body.Bytes()
	reader, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("响应不是合法 zip: %v", err)
	}
	var names []string
	for _, f := range reader.File {
		names = append(names, f.Name)
	}
	sort.Strings(names)
	want := []string{"pkg/", "pkg/a.txt", "pkg/sub/", "pkg/sub/b.txt"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("zip 条目 = %v，期望 %v", names, want)
	}

	// 越界路径：403。
	req = httptest.NewRequest(http.MethodGet, "/api/fs/download?cwd="+root+"&path=../etc/passwd", nil)
	req.Header.Set("Authorization", "Bearer secret")
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("路径穿越应 403，实际 %d: %s", rec.Code, rec.Body.String())
	}
}
