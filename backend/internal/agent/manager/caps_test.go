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

// 回归：探测本身失败时不能缓存 false。
//
// 旧实现把 `--help` 的超时/ETXTBSY/权限失败也记成「该版本不支持」，
// 于是子代理正文从此静默不转发，直到进程重启才恢复。
func TestSupportsFlagDoesNotCacheProbeFailure(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "claude")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatalf("write: %v", err)
	}
	m := &Manager{caps: make(map[string]bool)}
	if m.supportsFlag(bin, "--forward-subagent-text") {
		t.Fatal("--help 失败时先按不支持处理")
	}
	if len(m.caps) != 0 {
		t.Fatalf("探测失败不应写入缓存: %v", m.caps)
	}

	// 环境恢复后（同一路径）应重新探测成功。
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho '--forward-subagent-text'\n"), 0o755); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	if !m.supportsFlag(bin, "--forward-subagent-text") {
		t.Fatal("探测失败被永久缓存了：重试仍判不支持")
	}
}
