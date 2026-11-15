package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
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

	// 纯文本允许 inline（nosniff + CSP sandbox），方便「新窗口打开」。
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/fs/raw?cwd="+root+"&path=a.txt", nil))
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "text/plain; charset=utf-8" {
		t.Fatalf("txt raw: code=%d type=%q", rec.Code, rec.Header().Get("Content-Type"))
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
