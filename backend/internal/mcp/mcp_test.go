package mcp

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 假 MCP server：由测试二进制自己充当 stdio 子进程（TestMain 里拦下来），
// 这样探测逻辑有真实的对端可读，又不依赖任何外部命令。
func TestMain(m *testing.M) {
	if os.Getenv("GO_WANT_MCP_HELPER") == "1" {
		sc := bufio.NewScanner(os.Stdin)
		if sc.Scan() {
			fmt.Println(`{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"fake","version":"9.9"}}}`)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// 一套「用户级 + 项目级 + 停用暂存」的临时目录。
func newManager(t *testing.T) (*Manager, string, string) {
	t.Helper()
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	ws := filepath.Join(dir, "ws")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatalf("建工作区: %v", err)
	}
	m := New(filepath.Join(home, ".claude.json"), filepath.Join(dir, "mcp-disabled.json"))
	return m, ws, dir
}

func readJSON(t *testing.T, path string) map[string]json.RawMessage {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读 %s: %v", path, err)
	}
	out := map[string]json.RawMessage{}
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("解析 %s: %v", path, err)
	}
	return out
}

func TestSaveUserServerKeepsOtherKeys(t *testing.T) {
	m, _, dir := newManager(t)
	path := filepath.Join(dir, "home", ".claude.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("建 HOME: %v", err)
	}
	// 模拟 claude 自己的状态文件：带 projects、大整数与嵌套结构。
	original := `{
  "numStartups": 42,
  "projects": {"/data/ws": {"history": [{"display": "hi"}]}},
  "mcpServers": {"old": {"command": "node", "args": ["a.js"]}}
}`
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatalf("写初始配置: %v", err)
	}

	if _, err := m.Save("", Server{Name: "github", Scope: ScopeUser, Command: "npx", Args: []string{"-y", "server-github"}}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	top := readJSON(t, path)
	if string(top["numStartups"]) != "42" {
		t.Fatalf("numStartups 被改写了: %s", top["numStartups"])
	}
	var projects map[string]any
	if err := json.Unmarshal(top["projects"], &projects); err != nil || projects["/data/ws"] == nil {
		t.Fatalf("projects 丢了: %s (%v)", top["projects"], err)
	}
	servers, err := serversOf(top)
	if err != nil {
		t.Fatalf("serversOf: %v", err)
	}
	if len(servers) != 2 {
		t.Fatalf("server 数 = %d，期望 2", len(servers))
	}
	// stdio 不写 type，与 claude 自己写出来的形状一致。
	if got := string(servers["github"]); strings.Contains(got, `"type"`) {
		t.Fatalf("stdio 不该写 type: %s", got)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("权限 = %o，期望 600", perm)
	}
}

func TestSaveProjectServerRoundTrip(t *testing.T) {
	m, ws, _ := newManager(t)
	if _, err := m.Save(ws, Server{Name: "docs", Scope: ScopeProject, Type: TypeHTTP, URL: "https://example.com/mcp", Headers: map[string]string{"Authorization": "Bearer x"}}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	payload, err := m.List(ws)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(payload.Project) != 1 {
		t.Fatalf("项目级 server 数 = %d，期望 1", len(payload.Project))
	}
	got := payload.Project[0]
	if got.Type != TypeHTTP || got.URL != "https://example.com/mcp" || got.Headers["Authorization"] != "Bearer x" {
		t.Fatalf("读回来的配置不对: %+v", got)
	}
	if payload.ProjectPath != filepath.Join(ws, ".mcp.json") {
		t.Fatalf("ProjectPath = %q", payload.ProjectPath)
	}
	// 项目级配置是仓库文件，权限跟普通文件走。
	fi, err := os.Stat(filepath.Join(ws, ".mcp.json"))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := fi.Mode().Perm(); perm != 0o644 {
		t.Fatalf("权限 = %o，期望 644", perm)
	}
}

func TestNormalizeValidation(t *testing.T) {
	cases := []struct {
		name string
		in   Server
		want error
	}{
		{"空名字", Server{Name: "", Command: "x"}, ErrInvalidName},
		{"带斜杠", Server{Name: "a/b", Command: "x"}, ErrInvalidName},
		{"stdio 缺命令", Server{Name: "s", Type: TypeStdio}, ErrInvalidSpec},
		{"远程缺地址", Server{Name: "s", Type: TypeHTTP}, ErrInvalidSpec},
		{"非 http 地址", Server{Name: "s", Type: TypeSSE, URL: "ftp://x"}, ErrInvalidSpec},
		{"未知类型", Server{Name: "s", Type: "grpc", URL: "https://x"}, ErrInvalidSpec},
		{"非法环境变量名", Server{Name: "s", Command: "x", Env: map[string]string{"A B": "1"}}, ErrInvalidSpec},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := Normalize(c.in); err == nil {
				t.Fatalf("期望失败，实际通过")
			} else if c.want != nil && !strings.Contains(err.Error(), c.want.Error()) {
				t.Fatalf("错误 = %v，期望包含 %v", err, c.want)
			}
		})
	}
}

func TestDeleteRemovesOnlyTarget(t *testing.T) {
	m, ws, _ := newManager(t)
	for _, n := range []string{"a", "b"} {
		if _, err := m.Save(ws, Server{Name: n, Scope: ScopeProject, Command: "node"}); err != nil {
			t.Fatalf("Save %s: %v", n, err)
		}
	}
	if err := m.Delete(ws, ScopeProject, "a"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	payload, err := m.List(ws)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(payload.Project) != 1 || payload.Project[0].Name != "b" {
		t.Fatalf("删错了: %+v", payload.Project)
	}
	if err := m.Delete(ws, ScopeProject, "nope"); err != ErrNotFound {
		t.Fatalf("删不存在的: %v，期望 ErrNotFound", err)
	}
}

func TestDisableThenEnable(t *testing.T) {
	m, ws, dir := newManager(t)
	if _, err := m.Save(ws, Server{Name: "pw", Scope: ScopeProject, Command: "npx", Args: []string{"@playwright/mcp"}}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := m.SetEnabled(ws, ScopeProject, "pw", false); err != nil {
		t.Fatalf("停用: %v", err)
	}
	// 停用后必须真的不在 claude 的配置里。
	top := readJSON(t, filepath.Join(ws, ".mcp.json"))
	if servers, _ := serversOf(top); len(servers) != 0 {
		t.Fatalf("停用后配置里还有: %v", servers)
	}
	payload, err := m.List(ws)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(payload.Project) != 1 || !payload.Project[0].Disabled {
		t.Fatalf("停用项没列出来: %+v", payload.Project)
	}
	if _, err := os.Stat(filepath.Join(dir, "mcp-disabled.json")); err != nil {
		t.Fatalf("没有落停用暂存: %v", err)
	}

	if err := m.SetEnabled(ws, ScopeProject, "pw", true); err != nil {
		t.Fatalf("启用: %v", err)
	}
	top = readJSON(t, filepath.Join(ws, ".mcp.json"))
	if servers, _ := serversOf(top); len(servers) != 1 {
		t.Fatalf("启用后配置里没有: %v", servers)
	}
	payload, err = m.List(ws)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if payload.Project[0].Disabled {
		t.Fatalf("启用后仍标记停用")
	}
}

func TestSaveDisabledServerStaysDisabled(t *testing.T) {
	m, ws, _ := newManager(t)
	if _, err := m.Save(ws, Server{Name: "x", Scope: ScopeProject, Command: "node", Args: []string{"old.js"}}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := m.SetEnabled(ws, ScopeProject, "x", false); err != nil {
		t.Fatalf("停用: %v", err)
	}
	// 编辑一个停用中的服务：只改暂存副本，不该顺手把它启用。
	if _, err := m.Save(ws, Server{Name: "x", Scope: ScopeProject, Command: "node", Args: []string{"new.js"}}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	top := readJSON(t, filepath.Join(ws, ".mcp.json"))
	if servers, _ := serversOf(top); len(servers) != 0 {
		t.Fatalf("编辑停用项时被写回配置了: %v", servers)
	}
	payload, err := m.List(ws)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(payload.Project) != 1 || !payload.Project[0].Disabled {
		t.Fatalf("停用项丢了: %+v", payload.Project)
	}
	if got := strings.Join(payload.Project[0].Args, " "); got != "new.js" {
		t.Fatalf("暂存副本没更新: %q", got)
	}
}

func TestSymlinkConfigRejected(t *testing.T) {
	m, ws, dir := newManager(t)
	outside := filepath.Join(dir, "outside.json")
	if err := os.WriteFile(outside, []byte(`{"mcpServers":{}}`), 0o644); err != nil {
		t.Fatalf("写外部文件: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(ws, ".mcp.json")); err != nil {
		t.Skipf("无法创建符号链接: %v", err)
	}
	if _, err := m.Save(ws, Server{Name: "x", Scope: ScopeProject, Command: "node"}); err == nil {
		t.Fatalf("软链应该被拒绝")
	} else if !strings.Contains(err.Error(), ErrSymlink.Error()) {
		t.Fatalf("错误 = %v，期望 ErrSymlink", err)
	}
}

func TestProjectScopeRequiresCwd(t *testing.T) {
	m, _, _ := newManager(t)
	if _, err := m.Save("", Server{Name: "x", Scope: ScopeProject, Command: "node"}); err == nil {
		t.Fatalf("缺 cwd 应该失败")
	}
	if _, err := m.List(""); err != nil {
		t.Fatalf("List 无 cwd 应只返回用户级: %v", err)
	}
}

func TestProbeStdio(t *testing.T) {
	m, ws, _ := newManager(t)
	if _, err := m.Save(ws, Server{
		Name:    "fake",
		Scope:   ScopeProject,
		Command: os.Args[0],
		Args:    []string{"-test.run=TestHelperProcess"},
		Env:     map[string]string{"GO_WANT_MCP_HELPER": "1"},
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	res, err := m.Probe(ws, ScopeProject, "fake")
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if !res.OK {
		t.Fatalf("探测失败: %+v", res)
	}
	if res.ServerName != "fake" || res.ServerVersion != "9.9" {
		t.Fatalf("serverInfo = %+v", res)
	}
}

// TestHelperProcess 只是占位：真正的假 server 逻辑在 TestMain 里。
func TestHelperProcess(t *testing.T) {}

func TestProbeUnknownAndDisabled(t *testing.T) {
	m, ws, _ := newManager(t)
	if _, err := m.Probe(ws, ScopeProject, "nope"); err != ErrNotFound {
		t.Fatalf("未知服务: %v，期望 ErrNotFound", err)
	}
	if _, err := m.Save(ws, Server{Name: "x", Scope: ScopeProject, Command: "node"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := m.SetEnabled(ws, ScopeProject, "x", false); err != nil {
		t.Fatalf("停用: %v", err)
	}
	if _, err := m.Probe(ws, ScopeProject, "x"); err != ErrDisabled {
		t.Fatalf("停用项: %v，期望 ErrDisabled", err)
	}
}

func TestProbeRemote(t *testing.T) {
	m, ws, _ := newManager(t)
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer t" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"remote","version":"1.2"}}}`))
	}))
	defer ok.Close()
	if _, err := m.Save(ws, Server{Name: "r", Scope: ScopeProject, Type: TypeHTTP, URL: ok.URL, Headers: map[string]string{"Authorization": "Bearer t"}}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	res, err := m.Probe(ws, ScopeProject, "r")
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if !res.OK || res.ServerName != "remote" || res.ServerVersion != "1.2" {
		t.Fatalf("远端探测结果 = %+v", res)
	}

	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusBadGateway)
	}))
	defer bad.Close()
	if _, err := m.Save(ws, Server{Name: "bad", Scope: ScopeProject, Type: TypeHTTP, URL: bad.URL}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	res, err = m.Probe(ws, ScopeProject, "bad")
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if res.OK || !strings.Contains(res.Error, "502") {
		t.Fatalf("坏端点应当失败: %+v", res)
	}

	sse := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
	}))
	defer sse.Close()
	if _, err := m.Save(ws, Server{Name: "s", Scope: ScopeProject, Type: TypeSSE, URL: sse.URL}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if res, err = m.Probe(ws, ScopeProject, "s"); err != nil || !res.OK {
		t.Fatalf("SSE 探测: %+v %v", res, err)
	}
}
