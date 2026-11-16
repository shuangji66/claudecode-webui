package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func skillsReq(t *testing.T, srv *Server, method, target, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, target, nil)
	} else {
		req = httptest.NewRequest(method, target, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

func TestSkillsRequireAuth(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	rec := skillsReq(t, srv, http.MethodGet, "/api/skills", "", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("无 token 应 401，实际 %d", rec.Code)
	}
}

func TestSkillsProjectListRequiresWorkspace(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	outside := t.TempDir()

	rec := skillsReq(t, srv, http.MethodGet, "/api/skills?cwd="+outside, "secret", "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("未授权 cwd 应 403，实际 %d: %s", rec.Code, rec.Body.String())
	}

	// 不带 cwd 也要能列出个人技能。
	rec = skillsReq(t, srv, http.MethodGet, "/api/skills", "secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Personal     []struct{ Name string } `json:"personal"`
		Project      []struct{ Name string } `json:"project"`
		PersonalRoot string                  `json:"personal_root"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Personal == nil || payload.Project == nil {
		t.Fatalf("空列表必须是 []，实际 %s", rec.Body.String())
	}
	if payload.PersonalRoot == "" {
		t.Fatal("应返回 personal_root")
	}
}

func TestSkillsRoundTrip(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	root := srv.d.ProjectsRoot

	body, _ := json.Marshal(map[string]string{
		"cwd":     root,
		"scope":   "project",
		"name":    "deploy",
		"content": "---\ndescription: 部署到生产\n---\n\n跑 make release\n",
	})
	rec := skillsReq(t, srv, http.MethodPut, "/api/skills/doc", "secret", string(body))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT code = %d: %s", rec.Code, rec.Body.String())
	}
	var doc struct {
		Description string `json:"description"`
		Content     string `json:"content"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Description != "部署到生产" {
		t.Fatalf("description = %q", doc.Description)
	}

	rec = skillsReq(t, srv, http.MethodGet, "/api/skills?cwd="+root, "secret", "")
	var list struct {
		Project []struct{ Name string } `json:"project"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Project) != 1 || list.Project[0].Name != "deploy" {
		t.Fatalf("project = %+v", list.Project)
	}

	rec = skillsReq(t, srv, http.MethodGet, "/api/skills/doc?scope=project&cwd="+root+"&name=deploy", "secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET doc code = %d: %s", rec.Code, rec.Body.String())
	}

	rec = skillsReq(t, srv, http.MethodDelete, "/api/skills/doc?scope=project&cwd="+root+"&name=deploy", "secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE code = %d: %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, ".claude", "skills", "deploy")); !os.IsNotExist(err) {
		t.Fatalf("目录应已删除: %v", err)
	}
}

func TestSkillsRejectsBadInput(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	root := srv.d.ProjectsRoot

	cases := []struct {
		name   string
		method string
		target string
		body   string
		code   int
	}{
		{
			name:   "名字带路径分隔符",
			method: http.MethodPut,
			target: "/api/skills/doc",
			body:   `{"scope":"personal","name":"../evil","content":"---\ndescription: x\n---\n"}`,
			code:   http.StatusBadRequest,
		},
		{
			name:   "同步技能只读",
			method: http.MethodPut,
			target: "/api/skills/doc",
			body:   `{"scope":"synced","name":"pdf","content":"---\ndescription: x\n---\n"}`,
			code:   http.StatusForbidden,
		},
		{
			name:   "未知来源",
			method: http.MethodGet,
			target: "/api/skills/doc?scope=enterprise&name=pdf",
			code:   http.StatusBadRequest,
		},
		{
			name:   "项目技能缺 cwd",
			method: http.MethodGet,
			target: "/api/skills/doc?scope=project&name=deploy",
			code:   http.StatusBadRequest,
		},
		{
			name:   "读不存在的技能",
			method: http.MethodGet,
			target: "/api/skills/doc?scope=project&cwd=" + root + "&name=missing",
			code:   http.StatusNotFound,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := skillsReq(t, srv, c.method, c.target, "secret", c.body)
			if rec.Code != c.code {
				t.Fatalf("code = %d，期望 %d: %s", rec.Code, c.code, rec.Body.String())
			}
		})
	}
}

func TestSkillsDisabledReturns503(t *testing.T) {
	srv, _ := newTestServer(t, "")
	srv.d.Skills = nil
	rec := skillsReq(t, srv, http.MethodGet, "/api/skills", "", "")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
}
