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

// Git 命令实际执行的工作目录是**仓库根**（gitctl.repoRoot 用
// `rev-parse --show-toplevel` 把 -C 提上去），而网关只校验请求里的 cwd。
// 工作区只授权到仓库的某个子目录时，两者不是一回事：不挡的话 status / diff /
// stage / discard / commit / checkout 全都在工作区**外面**操作。
//
// 这是「读出工作区外文件的 diff」与「丢掉工作区外未提交改动」两条的真实入口。
func TestGitRejectsRepoRootOutsideWorkspace(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("没有 git")
	}
	srv, _ := newTestServer(t, "")

	// 布局：workspace/repo/app 是工作区，repo 是仓库根（在工作区之外）。
	repo := t.TempDir()
	app := filepath.Join(repo, "app")
	if err := os.MkdirAll(app, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"init", "-q", "."},
		{"config", "user.email", "a@b.c"},
		{"config", "user.name", "t"},
	} {
		c := exec.Command("git", args...)
		c.Dir = repo
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	// 只授权 app（仓库根之外）。
	if _, err := srv.d.Workspaces.Add(app); err != nil {
		t.Fatalf("Add: %v", err)
	}

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(
		http.MethodGet, "/api/git/status?cwd="+app, nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("仓库根在工作区外时应 403，实际 %d (%s)", rec.Code, rec.Body.String())
	}

	// 对照：把仓库根也授权之后就应放行（面板照常可用）。
	if _, err := srv.d.Workspaces.Add(repo); err != nil {
		t.Fatalf("Add repo: %v", err)
	}
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(
		http.MethodGet, "/api/git/status?cwd="+app, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("仓库根已授权时应 200，实际 %d (%s)", rec.Code, rec.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
}

// 写操作的请求体路径（decodeGitReq）走的是同一个围栏，这里钉住 stage / discard。
func TestGitWriteOpsRejectRepoRootOutsideWorkspace(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("没有 git")
	}
	srv, _ := newTestServer(t, "")
	repo := t.TempDir()
	app := filepath.Join(repo, "app")
	if err := os.MkdirAll(app, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"init", "-q", "."},
		{"config", "user.email", "a@b.c"},
		{"config", "user.name", "t"},
	} {
		c := exec.Command("git", args...)
		c.Dir = repo
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	if _, err := srv.d.Workspaces.Add(app); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct{ path, body string }{
		{"/api/git/stage", `{"cwd":"` + app + `","path":""}`},
		{"/api/git/discard", `{"cwd":"` + app + `","path":"outside.txt"}`},
		{"/api/git/commit", `{"cwd":"` + app + `","message":"x"}`},
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
		srv.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s 应 403，实际 %d (%s)", tc.path, rec.Code, rec.Body.String())
		}
	}
}
