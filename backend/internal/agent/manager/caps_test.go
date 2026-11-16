package manager

import (
	"os"
	"path/filepath"
	"testing"
)

// 探测结果按二进制路径缓存：同一个路径第二次调用不再起进程。
func TestSupportsFlagCachesByBinary(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "claude")
	script := "#!/bin/sh\necho 'usage: claude --forward-subagent-text --other'\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatalf("write: %v", err)
	}
	m := &Manager{caps: make(map[string]bool)}

	if !m.supportsFlag(bin, "--forward-subagent-text") {
		t.Fatal("帮助里有的参数应判为支持")
	}
	if m.supportsFlag(bin, "--no-such-flag") {
		t.Fatal("帮助里没有的参数应判为不支持")
	}

	// 缓存：把二进制换掉也不影响已探测的结果。
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	if !m.supportsFlag(bin, "--forward-subagent-text") {
		t.Fatal("结果应命中缓存")
	}
}

func TestSupportsFlagMissingBinary(t *testing.T) {
	m := &Manager{caps: make(map[string]bool)}
	if m.supportsFlag(filepath.Join(t.TempDir(), "nope"), "--forward-subagent-text") {
		t.Fatal("二进制不存在时应判为不支持")
	}
}
