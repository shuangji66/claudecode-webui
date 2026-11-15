package history

import (
	"os"
	"path/filepath"
	"testing"
)

func writeJSONL(t *testing.T, path string, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer f.Close()
	for _, l := range lines {
		if _, err := f.WriteString(l + "\n"); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
}

func TestListEmptyDirWhenMissing(t *testing.T) {
	got, err := List(filepath.Join(t.TempDir(), "nope"))
	if err != nil {
		t.Fatalf("目录不存在应返回空而不是错误: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("应为空: %v", got)
	}
}

func TestListSummarizesTranscript(t *testing.T) {
	root := t.TempDir()
	writeJSONL(t, filepath.Join(root, "-tmp-work", "abc.jsonl"),
		`{"type":"queue-operation","operation":"enqueue"}`,
		`{"type":"user","cwd":"/tmp/work","sessionId":"sess-1","timestamp":"2026-11-16T01:00:00Z","message":{"role":"user","content":"帮我加个功能"}}`,
		`{"type":"assistant","timestamp":"2026-11-16T01:05:00Z","message":{"role":"assistant","content":[{"type":"text","text":"好的"}]}}`,
	)

	got, err := List(root)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("条数 = %d, want 1", len(got))
	}
	s := got[0]
	if s.ID != "sess-1" {
		t.Fatalf("ID = %q, want sess-1", s.ID)
	}
	if s.Cwd != "/tmp/work" {
		t.Fatalf("Cwd = %q", s.Cwd)
	}
	if s.Title != "帮我加个功能" {
		t.Fatalf("Title = %q", s.Title)
	}
	if s.Messages != 2 {
		t.Fatalf("Messages = %d, want 2", s.Messages)
	}
	if s.Project != "-tmp-work" {
		t.Fatalf("Project = %q", s.Project)
	}
}

func TestListSortsByUpdatedAtDesc(t *testing.T) {
	root := t.TempDir()
	writeJSONL(t, filepath.Join(root, "p1", "old.jsonl"),
		`{"type":"user","sessionId":"old","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"旧"}}`)
	writeJSONL(t, filepath.Join(root, "p1", "new.jsonl"),
		`{"type":"user","sessionId":"new","timestamp":"2026-11-01T00:00:00Z","message":{"role":"user","content":"新"}}`)

	got, err := List(root)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("条数 = %d", len(got))
	}
	if got[0].ID != "new" {
		t.Fatalf("应按更新时间倒序，首条 = %q", got[0].ID)
	}
}

func TestListFallsBackToFileNameForTitle(t *testing.T) {
	root := t.TempDir()
	writeJSONL(t, filepath.Join(root, "p", "only-id.jsonl"),
		`{"type":"assistant","timestamp":"2026-11-01T00:00:00Z","message":{"role":"assistant","content":"只有助手消息"}}`)

	got, _ := List(root)
	if len(got) != 1 {
		t.Fatalf("条数 = %d", len(got))
	}
	if got[0].Title != "only-id" {
		t.Fatalf("Title = %q, 应回退为文件名", got[0].Title)
	}
}

func TestExtractTextVariants(t *testing.T) {
	cases := []struct{ name, raw, want string }{
		{"string", `"hello"`, "hello"},
		{"blocks", `[{"type":"text","text":"a"},{"type":"tool_use"}]`, "a"},
		{"multi", `[{"type":"text","text":"a"},{"type":"text","text":"b"}]`, "a b"},
		{"empty", ``, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := extractText([]byte(tc.raw)); got != tc.want {
				t.Fatalf("extractText = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestTruncate(t *testing.T) {
	if got := truncate("一二三四五", 3); got != "一二三…" {
		t.Fatalf("truncate = %q", got)
	}
	if got := truncate("短", 10); got != "短" {
		t.Fatalf("不应截断: %q", got)
	}
}
