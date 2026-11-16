package skills

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newManager(t *testing.T) (*Manager, string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "skills")
	return New(root), root
}

func TestSaveListReadDelete(t *testing.T) {
	m, root := newManager(t)
	content := "---\ndescription: Summarizes the diff. Use when asked what changed.\n---\n\n## Steps\n"

	doc, err := m.Save(ScopePersonal, "", "summarize", content)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if doc.Path != filepath.Join(root, "summarize", "SKILL.md") {
		t.Fatalf("path = %q", doc.Path)
	}
	if doc.Description != "Summarizes the diff. Use when asked what changed." {
		t.Fatalf("description = %q", doc.Description)
	}
	if doc.ReadOnly {
		t.Fatal("个人技能不应只读")
	}

	list, err := m.List(ScopePersonal, "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 || list[0].Name != "summarize" {
		t.Fatalf("list = %+v", list)
	}

	got, err := m.Read(ScopePersonal, "", "summarize")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got.Content != content {
		t.Fatalf("content = %q", got.Content)
	}

	if err := m.Delete(ScopePersonal, "", "summarize"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "summarize")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("目录应已删除: %v", err)
	}
	if _, err := m.Read(ScopePersonal, "", "summarize"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Read 删除后应 ErrNotFound，实际 %v", err)
	}
}

func TestListSkipsDirsWithoutSkillFileAndSeparatesSynced(t *testing.T) {
	m, root := newManager(t)
	for _, dir := range []string{"alpha", "empty", "synced/pdf"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "alpha", "SKILL.md"), []byte("---\ndescription: A\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "synced", "pdf", "SKILL.md"), []byte("---\ndescription: P\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	personal, err := m.List(ScopePersonal, "")
	if err != nil {
		t.Fatalf("List personal: %v", err)
	}
	if len(personal) != 1 || personal[0].Name != "alpha" {
		t.Fatalf("personal = %+v", personal)
	}

	synced, err := m.List(ScopeSynced, "")
	if err != nil {
		t.Fatalf("List synced: %v", err)
	}
	if len(synced) != 1 || synced[0].Name != "pdf" || !synced[0].ReadOnly {
		t.Fatalf("synced = %+v", synced)
	}
}

func TestProjectScopeUsesCwdAndAllowsNestedSkillsDir(t *testing.T) {
	m, _ := newManager(t)
	cwd := t.TempDir()
	if _, err := m.Save(ScopeProject, cwd, "deploy", "---\ndescription: D\n---\n"); err != nil {
		t.Fatalf("Save: %v", err)
	}
	want := filepath.Join(cwd, ".claude", "skills", "deploy", "SKILL.md")
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("项目技能应落在 %s: %v", want, err)
	}
	// 个人列表不能被项目技能污染。
	personal, err := m.List(ScopePersonal, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(personal) != 0 {
		t.Fatalf("personal = %+v", personal)
	}
	if _, err := m.Save(ScopeProject, "", "x", "---\n---\n"); !errors.Is(err, ErrInvalidName) {
		t.Fatalf("缺 cwd 应 ErrInvalidName，实际 %v", err)
	}
}

func TestRejectsBadNames(t *testing.T) {
	m, _ := newManager(t)
	for _, name := range []string{"", ".", "..", "../etc", "a/b", `a\b`, ".hidden", "a<b", "zero\u200bwidth", "synced", "SYNCED"} {
		if _, err := m.Save(ScopePersonal, "", name, "---\ndescription: x\n---\n"); !errors.Is(err, ErrInvalidName) {
			t.Fatalf("%q 应被拒绝，实际 %v", name, err)
		}
	}
}

func TestSyncedIsReadOnly(t *testing.T) {
	m, root := newManager(t)
	if err := os.MkdirAll(filepath.Join(root, "synced", "pdf"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "synced", "pdf", "SKILL.md"), []byte("---\ndescription: P\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Save(ScopeSynced, "", "pdf", "---\ndescription: x\n---\n"); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("Save 应 ErrReadOnly，实际 %v", err)
	}
	if err := m.Delete(ScopeSynced, "", "pdf"); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("Delete 应 ErrReadOnly，实际 %v", err)
	}
	// 读不受影响。
	if _, err := m.Read(ScopeSynced, "", "pdf"); err != nil {
		t.Fatalf("Read: %v", err)
	}
}

func TestSaveRefusesSymlinkedDir(t *testing.T) {
	m, root := newManager(t)
	outside := t.TempDir()
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Skipf("当前环境不支持符号链接: %v", err)
	}
	if _, err := m.Save(ScopePersonal, "", "escape", "---\ndescription: x\n---\n"); !errors.Is(err, ErrSymlink) {
		t.Fatalf("应 ErrSymlink，实际 %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "SKILL.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("不应写到链接目标: %v", err)
	}
}

func TestDeleteOnlyRemovesDirectChildWithSkillFile(t *testing.T) {
	m, root := newManager(t)
	// 只有 SKILL.md 的目录才允许删；空目录/普通文件一律 ErrNotFound。
	if err := os.MkdirAll(filepath.Join(root, "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := m.Delete(ScopePersonal, "", "empty"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("空目录应 ErrNotFound，实际 %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "file.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := m.Delete(ScopePersonal, "", "file.md"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("普通文件应 ErrNotFound，实际 %v", err)
	}
}

func TestSaveRejectsEmptyAndOversize(t *testing.T) {
	m, _ := newManager(t)
	if _, err := m.Save(ScopePersonal, "", "x", "   \n"); !errors.Is(err, ErrEmpty) {
		t.Fatalf("空内容应 ErrEmpty，实际 %v", err)
	}
	big := strings.Repeat("a", maxContent+1)
	if _, err := m.Save(ScopePersonal, "", "x", big); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("超限应 ErrTooLarge，实际 %v", err)
	}
}

func TestSaveNormalizesCRLF(t *testing.T) {
	m, _ := newManager(t)
	doc, err := m.Save(ScopePersonal, "", "crlf", "---\r\ndescription: x\r\n---\r\n")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(doc.Content, "\r") {
		t.Fatalf("应统一为 LF: %q", doc.Content)
	}
}

func TestParseFrontmatter(t *testing.T) {
	cases := []struct {
		name    string
		content string
		wantNam string
		wantDes string
	}{
		{
			name:    "简单标量",
			content: "---\nname: deploy\ndescription: 部署到生产\n---\n正文",
			wantNam: "deploy",
			wantDes: "部署到生产",
		},
		{
			name:    "引号",
			content: "---\ndescription: \"Use when: diff\"\n---\n",
			wantDes: "Use when: diff",
		},
		{
			name:    "折叠块",
			content: "---\ndescription: >\n  第一行\n  第二行\nallowed-tools: Bash\n---\n",
			wantDes: "第一行 第二行",
		},
		{
			name:    "字面块",
			content: "---\ndescription: |\n  第一行\n  第二行\n---\n",
			wantDes: "第一行\n第二行",
		},
		{
			name:    "没有 frontmatter",
			content: "# 只有正文\n",
		},
		{
			name:    "BOM 与空行",
			content: "\ufeff\n---\ndescription: ok\n---\n",
			wantDes: "ok",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			name, desc := ParseFrontmatter(c.content)
			if name != c.wantNam || desc != c.wantDes {
				t.Fatalf("name=%q desc=%q，期望 %q / %q", name, desc, c.wantNam, c.wantDes)
			}
		})
	}
}
