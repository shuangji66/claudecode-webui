package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeSettings 造一份 settings.json 并让 mcp-web 读它。
func writeSettings(t *testing.T, enabled bool, base, key string) {
	t.Helper()
	dir := t.TempDir()
	body := map[string]any{
		"search_base_url": base,
		"search_api_key":  key,
		"search_count":    5,
		"search_enabled":  enabled,
	}
	b, _ := json.Marshal(body)
	path := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatalf("写设置: %v", err)
	}
	t.Setenv("CCWEB_SETTINGS_FILE", path)
}

func call(t *testing.T, name string, args map[string]any) toolContent {
	t.Helper()
	raw, _ := json.Marshal(args)
	resp, hasResp := handleRPC(rpcRequest{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`1`),
		Method:  "tools/call",
		Params:  mustJSON(map[string]any{"name": name, "arguments": json.RawMessage(raw)}),
	})
	if !hasResp {
		t.Fatalf("tools/call 必须有回包")
	}
	out, ok := resp.Result.(toolContent)
	if !ok {
		t.Fatalf("回包类型 = %T", resp.Result)
	}
	return out
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func textOf(res toolContent) string {
	if len(res.Content) == 0 {
		return ""
	}
	s, _ := res.Content[0]["text"].(string)
	return s
}

func TestHandshakeAndToolList(t *testing.T) {
	resp, hasResp := handleRPC(rpcRequest{JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: "initialize"})
	if !hasResp {
		t.Fatalf("initialize 必须有回包")
	}
	res, _ := resp.Result.(map[string]any)
	info, _ := res["serverInfo"].(map[string]any)
	if info["name"] != "ccweb-web" {
		t.Fatalf("serverInfo = %v", info)
	}

	resp, _ = handleRPC(rpcRequest{JSONRPC: "2.0", ID: json.RawMessage(`2`), Method: "tools/list"})
	list, _ := resp.Result.(map[string]any)
	tools, _ := list["tools"].([]map[string]any)
	names := make([]string, 0, len(tools))
	for _, tool := range tools {
		names = append(names, tool["name"].(string))
	}
	if len(names) != 2 || names[0] != toolWebSearch || names[1] != toolWebFetch {
		t.Fatalf("工具列表 = %v", names)
	}
}

func TestNotificationsAndUnknownMethods(t *testing.T) {
	// 通知没有 id，不能回包（回了会被 claude 当成未请求的响应）。
	if _, hasResp := handleRPC(rpcRequest{Method: "notifications/initialized"}); hasResp {
		t.Fatalf("初始化通知不应回包")
	}
	resp, hasResp := handleRPC(rpcRequest{JSONRPC: "2.0", ID: json.RawMessage(`3`), Method: "nope"})
	if !hasResp || resp.Error == nil || resp.Error.Code != -32601 {
		t.Fatalf("未知方法应回 -32601: %+v", resp)
	}
}

func TestSearchToolDisabled(t *testing.T) {
	writeSettings(t, false, "http://127.0.0.1:1", "k")
	res := call(t, toolWebSearch, map[string]any{"query": "x"})
	if !res.IsError || !strings.Contains(textOf(res), "未启用") {
		t.Fatalf("未启用时应给出可读错误: %+v", res)
	}
}

func TestSearchToolSuccess(t *testing.T) {
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth = r.URL.Path, r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"results":[
			{"title":"DeepSeek 发布","url":"https://example.com/a","summary":"摘要一","date":"2026-01-02"},
			{"title":"第二条","url":"https://example.com/b"}
		]}`))
	}))
	defer srv.Close()
	writeSettings(t, true, srv.URL, "secret")

	res := call(t, toolWebSearch, map[string]any{"query": "deepseek 新闻"})
	if res.IsError {
		t.Fatalf("不该失败: %s", textOf(res))
	}
	if gotPath != "/search" || gotAuth != "Bearer secret" {
		t.Fatalf("请求 path=%q auth=%q", gotPath, gotAuth)
	}
	text := textOf(res)
	for _, want := range []string{"查询：deepseek 新闻", "https://example.com/a", "摘要一", "2026-01-02", "https://example.com/b"} {
		if !strings.Contains(text, want) {
			t.Fatalf("结果里缺少 %q：\n%s", want, text)
		}
	}
}

func TestFetchToolReturnsMarkdown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/fetch" {
			t.Errorf("path = %q", r.URL.Path)
		}
		_, _ = w.Write([]byte("# 标题\n\n正文"))
	}))
	defer srv.Close()
	writeSettings(t, true, srv.URL, "k")

	res := call(t, toolWebFetch, map[string]any{"url": "https://example.com/a"})
	if res.IsError || !strings.Contains(textOf(res), "正文") {
		t.Fatalf("抓取结果 = %+v", res)
	}
}

func TestMissingKeyExplainsItself(t *testing.T) {
	writeSettings(t, true, "http://127.0.0.1:1", "")
	res := call(t, toolWebSearch, map[string]any{"query": "x"})
	if !res.IsError || !strings.Contains(textOf(res), "密钥") {
		t.Fatalf("缺密钥应说明: %+v", res)
	}
}
