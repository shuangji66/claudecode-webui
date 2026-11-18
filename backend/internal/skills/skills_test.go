package skills

import (
	"bytes"
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

// 中间层是符号链接时（工作区里的恶意仓库把 `.claude` 或 `.claude/skills` 换成软链），
// 保存与删除都不能跟出去：只查叶子目录挡不住 MkdirAll / RemoveAll。
func TestSaveAndDeleteRefuseSymlinkedParent(t *testing.T) {
	outside := t.TempDir()
	content := "---\ndescription: x\n---\n"

	for _, tc := range []struct {
		name  string
		setup func(t *testing.T, ws string)
	}{
		{
			name: "claude 目录是软链",
			setup: func(t *testing.T, ws string) {
				if err := os.Symlink(outside, filepath.Join(ws, ".claude")); err != nil {
					t.Skipf("当前环境不支持符号链接: %v", err)
				}
			},
		},
		{
			name: "skills 目录是软链",
			setup: func(t *testing.T, ws string) {
				if err := os.MkdirAll(filepath.Join(ws, ".claude"), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, filepath.Join(ws, ".claude", "skills")); err != nil {
					t.Skipf("当前环境不支持符号链接: %v", err)
				}
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, _ := newManager(t)
			ws := t.TempDir()
			tc.setup(t, ws)

			if _, err := m.Save(ScopeProject, ws, "evil", content); !errors.Is(err, ErrSymlink) {
				t.Fatalf("Save 应 ErrSymlink，实际 %v", err)
			}
			if _, err := os.Stat(filepath.Join(outside, "evil", "SKILL.md")); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("不应写到工作区外: %v", err)
			}

			// 先在工作区外造一个「含 SKILL.md」的目录，删除也不能够到它。
			target := filepath.Join(outside, "victim")
			if err := os.MkdirAll(target, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(target, "SKILL.md"), []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := m.Delete(ScopeProject, ws, "victim"); !errors.Is(err, ErrSymlink) {
				t.Fatalf("Delete 应 ErrSymlink，实际 %v", err)
			}
			if _, err := os.Stat(target); err != nil {
				t.Fatalf("不应删到工作区外: %v", err)
			}
		})
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

// 导入的来源只认 SKILL.md：目录取其下的 SKILL.md，文件必须自己就叫 SKILL.md。
func TestImportFromDirAndFile(t *testing.T) {
	m, root := newManager(t)
	src := t.TempDir()
	mk := func(rel, body string) string {
		path := filepath.Join(src, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("建来源目录: %v", err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatalf("写来源: %v", err)
		}
		return path
	}
	mk("alpha/SKILL.md", "---\ndescription: alpha\n---\nA\n")
	mk("beta/SKILL.md", "---\ndescription: beta\n---\nB\n")
	mk("notes.md", "not a skill\n")

	res, err := m.ImportFrom(ScopePersonal, "", []string{
		filepath.Join(src, "alpha"),               // 目录
		filepath.Join(src, "beta", "SKILL.md"),    // SKILL.md 文件
		filepath.Join(src, "notes.md"),            // 普通 md：拒绝
		filepath.Join(src, "missing", "SKILL.md"), // 不存在
	})
	if err != nil {
		t.Fatalf("ImportFrom: %v", err)
	}
	if len(res) != 4 {
		t.Fatalf("结果数 = %d，期望 4", len(res))
	}
	if !res[0].OK || res[0].Name != "alpha" {
		t.Fatalf("目录导入失败: %+v", res[0])
	}
	if !res[1].OK || res[1].Name != "beta" {
		t.Fatalf("文件导入失败: %+v", res[1])
	}
	if res[2].OK || !strings.Contains(res[2].Error, ErrNotSkill.Error()) {
		t.Fatalf("普通 md 应被拒: %+v", res[2])
	}
	if res[3].OK {
		t.Fatalf("不存在的路径应失败: %+v", res[3])
	}

	for _, name := range []string{"alpha", "beta"} {
		b, err := os.ReadFile(filepath.Join(root, name, "SKILL.md"))
		if err != nil {
			t.Fatalf("读导入结果 %s: %v", name, err)
		}
		if !strings.Contains(string(b), "description: "+name) {
			t.Fatalf("%s 内容不对: %s", name, b)
		}
	}
}

func TestImportFromProjectScopeAndSymlink(t *testing.T) {
	m, _ := newManager(t)
	cwd := t.TempDir()
	src := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "SKILL.md"), []byte("x\n"), 0o644); err != nil {
		t.Fatalf("写来源: %v", err)
	}
	res, err := m.ImportFrom(ScopeProject, cwd, []string{src})
	if err != nil {
		t.Fatalf("ImportFrom: %v", err)
	}
	if len(res) != 1 || !res[0].OK {
		t.Fatalf("项目级导入失败: %+v", res)
	}
	got := filepath.Join(cwd, ".claude", "skills", filepath.Base(src), "SKILL.md")
	if _, err := os.Stat(got); err != nil {
		t.Fatalf("没有写到工作区: %v", err)
	}

	// 来源是软链：拒绝（否则等于读一个随便指向哪里的文件）。
	link := filepath.Join(t.TempDir(), "SKILL.md")
	if err := os.Symlink(filepath.Join(src, "SKILL.md"), link); err != nil {
		t.Skipf("无法创建符号链接: %v", err)
	}
	res, err = m.ImportFrom(ScopePersonal, "", []string{link})
	if err != nil {
		t.Fatalf("ImportFrom: %v", err)
	}
	if len(res) != 1 || res[0].OK || !strings.Contains(res[0].Error, ErrSymlink.Error()) {
		t.Fatalf("软链来源应被拒: %+v", res)
	}

	if _, err := m.ImportFrom(ScopeSynced, "", []string{src}); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("synced 导入: %v，期望 ErrReadOnly", err)
	}
}

// 导入是「读宿主上的文件」，大小上限必须在**读的时候**也成立：
// 先 Lstat 再 ReadFile 的话，两步之间文件被写大就会整个读进内存。
func TestImportRejectsOversizedSource(t *testing.T) {
	m, _ := newManager(t)
	src := t.TempDir()
	big := filepath.Join(src, "SKILL.md")
	// 1 MiB + 1 字节：超过 maxContent。
	if err := os.WriteFile(big, bytes.Repeat([]byte("a"), 1<<20+1), 0o644); err != nil {
		t.Fatalf("写来源: %v", err)
	}
	res, err := m.ImportFrom(ScopePersonal, "", []string{big})
	if err != nil {
		t.Fatalf("ImportFrom: %v", err)
	}
	if len(res) != 1 || res[0].OK || !strings.Contains(res[0].Error, ErrTooLarge.Error()) {
		t.Fatalf("超大来源应被拒: %+v", res)
	}
	// 什么都没写进去
	if got, err := os.ReadDir(m.PersonalRoot()); err == nil && len(got) != 0 {
		t.Fatalf("失败的导入不应落盘: %v", got)
	}
}
