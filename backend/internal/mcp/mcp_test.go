package mcp

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// 假 MCP server：由测试二进制自己充当 stdio 子进程（TestMain 里拦下来），
// 这样探测逻辑有真实的对端可读，又不依赖任何外部命令。
func TestMain(m *testing.M) {
	switch os.Getenv("GO_WANT_MCP_HELPER") {
	case "1":
		sc := bufio.NewScanner(os.Stdin)
		if sc.Scan() {
			fmt.Println(`{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"fake","version":"9.9"}}}`)
		}
		os.Exit(0)
	case "noise":
		// 往 stdout 打日志（常见于 shell 包装脚本）：不是 JSON-RPC，也不能算握手。
		fmt.Println("starting fake server ...")
		os.Exit(0)
	case "crash":
		// 模拟「命令写错 / 缺依赖」：握手前就退出，原因只在 stderr 里。
		fmt.Fprintln(os.Stderr, "boom: 找不到依赖 @modelcontextprotocol/server-x")
		os.Exit(3)
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

// alwaysLoad 是「工具常驻工具表」的开关：写进去、读回来、被停用再启用都要保住。
// 丢了它，模型就退回「只看到工具名」的状态，界面上勾了也白勾。
func TestAlwaysLoadRoundTrip(t *testing.T) {
	m, _, dir := newManager(t)
	cfgPath := filepath.Join(dir, "home", ".claude.json")
	if _, err := m.Save("", Server{Name: "ccweb-web", Scope: ScopeUser, Type: TypeStdio, Command: "ccweb", Args: []string{"mcp-web"}, AlwaysLoad: true}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// 配置里的键名必须是 claude 认的 camelCase，写错等于没写。
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("读配置: %v", err)
	}
	var spec struct {
		AlwaysLoad bool `json:"alwaysLoad"`
	}
	rawServers := readJSON(t, cfgPath)[serversKey]
	var byName map[string]json.RawMessage
	if err := json.Unmarshal(rawServers, &byName); err != nil {
		t.Fatalf("解析 mcpServers: %v", err)
	}
	if err := json.Unmarshal(byName["ccweb-web"], &spec); err != nil {
		t.Fatalf("解析 ccweb-web: %v", err)
	}
	if !spec.AlwaysLoad {
		t.Fatalf("配置里没有 alwaysLoad: %s", raw)
	}

	payload, err := m.List("")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(payload.User) != 1 || !payload.User[0].AlwaysLoad {
		t.Fatalf("读回来丢了 alwaysLoad: %+v", payload.User)
	}

	// 停用会把整条配置挪进暂存文件，再启用要原样回来。
	if err := m.SetEnabled("", ScopeUser, "ccweb-web", false); err != nil {
		t.Fatalf("停用: %v", err)
	}
	if err := m.SetEnabled("", ScopeUser, "ccweb-web", true); err != nil {
		t.Fatalf("启用: %v", err)
	}
	payload, err = m.List("")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(payload.User) != 1 || !payload.User[0].AlwaysLoad {
		t.Fatalf("停用再启用后丢了 alwaysLoad: %+v", payload.User)
	}
}

// 默认不写这个键：false 就是 claude 的默认语义，写进去只会让人以为配置更特别。
func TestAlwaysLoadOmittedWhenFalse(t *testing.T) {
	m, _, dir := newManager(t)
	cfgPath := filepath.Join(dir, "home", ".claude.json")
	if _, err := m.Save("", Server{Name: "plain", Scope: ScopeUser, Type: TypeStdio, Command: "npx"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("读配置: %v", err)
	}
	if strings.Contains(string(raw), "alwaysLoad") {
		t.Fatalf("未开启时不该写 alwaysLoad: %s", raw)
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

// 探测要让用户看到真原因：进程握手前退出时，stderr 里的报错比
// 「JSON 解析失败: unexpected end of JSON input」有用得多。
func TestProbeStdioReportsStderrWhenItExitsEarly(t *testing.T) {
	m, ws, _ := newManager(t)
	if _, err := m.Save(ws, Server{
		Name:    "broken",
		Scope:   ScopeProject,
		Command: os.Args[0],
		Args:    []string{"-test.run=TestHelperProcess"},
		Env:     map[string]string{"GO_WANT_MCP_HELPER": "crash"},
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	res, err := m.Probe(ws, ScopeProject, "broken")
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if res.OK {
		t.Fatalf("握手前退出不该算成功: %+v", res)
	}
	if !strings.Contains(res.Error, "找不到依赖") {
		t.Fatalf("应把 stderr 报出来，实际 = %q", res.Error)
	}
}

// 进程没回握手帧、但往 stdout 打了东西：把那行报出来，而不是「解析失败」。
func TestProbeStdioReportsStdoutNoise(t *testing.T) {
	m, ws, _ := newManager(t)
	if _, err := m.Save(ws, Server{
		Name:    "noisy",
		Scope:   ScopeProject,
		Command: os.Args[0],
		Args:    []string{"-test.run=TestHelperProcess"},
		Env:     map[string]string{"GO_WANT_MCP_HELPER": "noise"},
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	res, err := m.Probe(ws, ScopeProject, "noisy")
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if res.OK {
		t.Fatalf("没有握手帧不该算成功: %+v", res)
	}
	if !strings.Contains(res.Error, "starting fake server") {
		t.Fatalf("应把 stdout 上的那行报出来，实际 = %q", res.Error)
	}
}

// 200 但不是 JSON-RPC（地址填成了普通网页）：不能报「连接正常」，
// 否则用户要等到会话里工具全不可用才发现。
func TestProbeRemoteRejectsNonJSONRPCBody(t *testing.T) {
	m, ws, _ := newManager(t)
	page := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html><body>欢迎光临</body></html>"))
	}))
	defer page.Close()
	if _, err := m.Save(ws, Server{Name: "page", Scope: ScopeProject, Type: TypeHTTP, URL: page.URL}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	res, err := m.Probe(ws, ScopeProject, "page")
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if res.OK {
		t.Fatalf("HTML 页面不该被当成 MCP: %+v", res)
	}
	if !strings.Contains(res.Error, "JSON-RPC") || !strings.Contains(res.Error, "欢迎光临") {
		t.Fatalf("错误信息应带上响应片段: %q", res.Error)
	}
}

// 软链要在「建目录」之前就被拒：工作区里一个 sub -> /某处，
// 先 MkdirAll 会把目录建到工作区外面去（写入虽然被拒，副作用已经发生）。
func TestEnsureWritableRejectsBeforeCreatingDirs(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, "ws")
	outside := filepath.Join(dir, "outside")
	for _, p := range []string{base, outside} {
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatalf("建目录 %s: %v", p, err)
		}
	}
	if err := os.Symlink(outside, filepath.Join(base, "sub")); err != nil {
		t.Skipf("无法创建符号链接: %v", err)
	}
	err := ensureWritable(base, filepath.Join(base, "sub", "deep", ".mcp.json"))
	if !errors.Is(err, ErrSymlink) {
		t.Fatalf("错误 = %v，期望 ErrSymlink", err)
	}
	if _, statErr := os.Stat(filepath.Join(outside, "deep")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("软链检查之前就在工作区外建了目录: %v", statErr)
	}
}

// 「启用」写配置成功、清暂存失败时，配置与暂存会各有一份同名条目：
// 列表以配置为准，不能显示成两条同名服务。
func TestListSkipsStashEntryAlreadyInConfig(t *testing.T) {
	m, _, _ := newManager(t)
	if _, err := m.Save("", Server{Name: "dup", Scope: ScopeUser, Command: "node"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := m.writeStash(stashFile{Servers: []stashEntry{
		{Scope: ScopeUser, Name: "dup", Spec: json.RawMessage(`{"command":"old"}`)},
	}}); err != nil {
		t.Fatalf("写暂存: %v", err)
	}
	payload, err := m.List("")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	names := make([]string, 0, len(payload.User))
	for _, srv := range payload.User {
		names = append(names, srv.Name)
	}
	if len(names) != 1 || names[0] != "dup" {
		t.Fatalf("用户级列表 = %v，期望只有一条 dup", names)
	}
	if payload.User[0].Disabled {
		t.Fatalf("配置里存在的条目不该标成停用: %+v", payload.User[0])
	}
}

// 写入是「读整份配置 → 改 → 写回」：并发时不串行化就会丢条目
// （两个标签页各删/加一条，结果只剩一条）。这里 16 个并发保存必须一个不丢。
func TestConcurrentSavesDoNotLoseEntries(t *testing.T) {
	m, _, _ := newManager(t)
	const n = 16
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if _, err := m.Save("", Server{Name: fmt.Sprintf("s%02d", i), Scope: ScopeUser, Command: "node"}); err != nil {
				errs <- err
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("并发保存失败: %v", err)
	}
	payload, err := m.List("")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(payload.User) != n {
		t.Fatalf("用户级条目 = %d，期望 %d（有写入被覆盖了）", len(payload.User), n)
	}
}
