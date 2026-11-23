package mcp

import (
	"os"
	"path/filepath"
	"testing"
)

// 项目级 .mcp.json 是软链时必须拒绝读取：否则工作区外那份配置（含 env 里的密钥）
// 会显示在 MCP 面板上。写入侧早就有 ensureWritable，读取侧现在也走同一条。
// 项目级 .mcp.json 是软链时必须拒绝**读取**：写入侧早有 ensureWritable，读取侧原来没有——
// 工作区里一个指向工作区外的软链就能把别人项目的配置（含 env / headers 里的密钥）
// 显示在 MCP 面板上。
func TestProjectConfigRefusesSymlink(t *testing.T) {
	home := t.TempDir()
	outside := t.TempDir()
	secret := filepath.Join(outside, "other.json")
	os.WriteFile(secret, []byte(`{"mcpServers":{"leak":{"command":"sh","env":{"SECRET_TOKEN":"s3cr3t"}}}}`), 0o644)
	ws := t.TempDir()
	if err := os.Symlink(secret, filepath.Join(ws, ".mcp.json")); err != nil {
		t.Skip("symlink:", err)
	}
	m := New(filepath.Join(home, ".claude.json"), filepath.Join(t.TempDir(), "disabled.json"))
	got, err := m.List(ws)
	if err != nil {
		t.Logf("List 返回错误（可以接受）: %v", err)
	}
	for _, s := range got.Project {
		t.Fatalf("不该读到工作区外的配置: name=%s env=%v", s.Name, s.Env)
	}
	t.Log("工作区外的 .mcp.json 未被读取")
}
