package skills

import (
	"os"
	"path/filepath"
	"testing"
)

// 读取侧必须与写入侧同一套口径：SKILL.md 是软链时不允许把链接目标的内容读回来。
// 工作区里一个恶意仓库自带 `.claude/skills/x/SKILL.md -> /任意文件` 就能把工作区外的
// 内容读进面板与模型上下文。
func TestReadRefusesSymlinkedSkillDoc(t *testing.T) {
	ws := t.TempDir()
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.md")
	os.WriteFile(secret, []byte("---\nname: evil\n---\nTOP-SECRET\n"), 0o644)
	dir := filepath.Join(ws, ".claude", "skills", "evil")
	os.MkdirAll(dir, 0o755)
	if err := os.Symlink(secret, filepath.Join(dir, "SKILL.md")); err != nil {
		t.Skip("symlink:", err)
	}
	m := New(filepath.Join(t.TempDir(), "personal"))
	list, err := m.List(ScopeProject, ws)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range list {
		t.Logf("List: name=%s invalid=%q", s.Name, s.Invalid)
		if s.Invalid == "" {
			t.Errorf("软链技能不该被正常列出")
		}
	}
	doc, err := m.Read(ScopeProject, ws, "evil")
	if err == nil {
		t.Fatalf("Read 不该成功，拿到 %q", doc.Content)
	}
	t.Logf("Read 被拒绝: %v", err)
}
