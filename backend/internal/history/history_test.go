package history

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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

func TestLoadTranscriptFiltersAndOrders(t *testing.T) {
	root := t.TempDir()
	id := "11111111-2222-4333-8444-555555555555"
	writeJSONL(t, filepath.Join(root, "p", id+".jsonl"),
		`{"type":"summary","summary":"s"}`,
		`{"type":"user","cwd":"/tmp/work","isSidechain":true,"message":{"role":"user","content":"subagent"}}`,
		`{"type":"user","isMeta":true,"message":{"role":"user","content":"meta"}}`,
		`{"type":"user","cwd":"/tmp/work","message":{"role":"user","content":"你好"}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"收到"}]}}`,
		`{"type":"file-history-snapshot","snapshot":{}}`,
	)
	tr, err := LoadTranscript(root, id)
	if err != nil {
		t.Fatalf("LoadTranscript: %v", err)
	}
	if tr.Cwd != "/tmp/work" {
		t.Fatalf("Cwd = %q", tr.Cwd)
	}
	if len(tr.Lines) != 2 {
		t.Fatalf("lines = %d: %s", len(tr.Lines), tr.Lines)
	}
	if !json.Valid(tr.Lines[0]) || !json.Valid(tr.Lines[1]) {
		t.Fatal("返回行必须是合法 JSON")
	}
	if _, err := LoadTranscript(root, "../etc/passwd"); err == nil {
		t.Fatal("非法 id 应报错")
	}
}

func TestLoadTranscriptKeepsTail(t *testing.T) {
	root := t.TempDir()
	id := "22222222-3333-4444-8555-666666666666"
	oldLines, oldBytes := maxTranscriptLines, maxTranscriptBytes
	maxTranscriptLines, maxTranscriptBytes = 2, 1<<20
	t.Cleanup(func() { maxTranscriptLines, maxTranscriptBytes = oldLines, oldBytes })
	writeJSONL(t, filepath.Join(root, "p", id+".jsonl"),
		`{"type":"user","message":{"content":"one"}}`,
		`{"type":"user","message":{"content":"two"}}`,
		`{"type":"user","message":{"content":"three"}}`,
	)
	tr, err := LoadTranscript(root, id)
	if err != nil {
		t.Fatal(err)
	}
	if len(tr.Lines) != 2 || !tr.Truncated {
		t.Fatalf("lines=%d truncated=%v", len(tr.Lines), tr.Truncated)
	}
	if !strings.Contains(string(tr.Lines[1]), "three") {
		t.Fatalf("应保留最后一行: %s", tr.Lines)
	}
}

// /model 这类本地命令的回显会以 user 行落盘：不能当标题，也不该计入消息数。
func TestListSkipsLocalCommandEcho(t *testing.T) {
	root := t.TempDir()
	writeJSONL(t, filepath.Join(root, "-tmp-work", "cmd.jsonl"),
		`{"type":"user","cwd":"/tmp/work","sessionId":"cmd","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":[{"type":"text","text":"<local-command-stdout>Set model to `+"`cn:glm-5.3-flash`"+`</local-command-stdout>"}]}}`,
		`{"type":"user","cwd":"/tmp/work","sessionId":"cmd","timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":"帮我看看这个报错"}}`,
		`{"type":"assistant","cwd":"/tmp/work","sessionId":"cmd","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"好的"}]}}`,
	)
	got, err := List(root)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("应只有一条会话: %v", got)
	}
	if got[0].Title != "帮我看看这个报错" {
		t.Fatalf("标题应跳过本地命令回显，实际 %q", got[0].Title)
	}
	if got[0].Messages != 2 {
		t.Fatalf("消息数应为 2（命令回显不计），实际 %d", got[0].Messages)
	}
}

func TestIsLocalCommandEcho(t *testing.T) {
	yes := []string{
		"<local-command-stdout>Set model to `x`</local-command-stdout>",
		"<local-command-stderr>boom</local-command-stderr>",
		"<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>",
	}
	no := []string{
		"",
		"hello",
		"<div>hi</div>",
		"帮我看下 <local-command-stdout> 这个标签",
		"<command-name>/model</command-name>\n这条是我想问的",
	}
	for _, v := range yes {
		if !isLocalCommandEcho(v) {
			t.Fatalf("应判定为命令回显: %q", v)
		}
	}
	for _, v := range no {
		if isLocalCommandEcho(v) {
			t.Fatalf("不应判定为命令回显: %q", v)
		}
	}
}

func TestLoadSubagentTranscriptReadsSidecar(t *testing.T) {
	root := t.TempDir()
	id := "33333333-4444-4555-8666-777777777777"
	writeJSONL(t, filepath.Join(root, "p", id+".jsonl"),
		`{"type":"user","message":{"role":"user","content":"delegate"}}`,
	)
	sub := filepath.Join(root, "p", id, "subagents")
	writeJSONL(t, filepath.Join(sub, "agent-abc123.jsonl"),
		`{"type":"user","isSidechain":true,"message":{"role":"user","content":[{"type":"text","text":"say hi"}]}}`,
		`{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}`,
		`{"type":"attachment","isSidechain":true,"message":{"content":""}}`,
	)
	meta := `{"agentType":"general-purpose","description":"probe child","toolUseId":"toolu_01","spawnDepth":1,"finished":true}`
	if err := os.WriteFile(filepath.Join(sub, "agent-abc123.meta.json"), []byte(meta), 0o644); err != nil {
		t.Fatalf("write meta: %v", err)
	}

	tr, err := LoadSubagentTranscript(root, id, "abc123")
	if err != nil {
		t.Fatalf("LoadSubagentTranscript: %v", err)
	}
	// sidechain 行是子代理转录的正文，必须保留（主转录则相反，要丢掉）。
	if len(tr.Lines) != 2 {
		t.Fatalf("lines = %d: %s", len(tr.Lines), tr.Lines)
	}
	if tr.Agent != "abc123" {
		t.Fatalf("Agent = %q", tr.Agent)
	}
	if tr.Meta == nil || tr.Meta.Description != "probe child" || !tr.Meta.Finished {
		t.Fatalf("meta = %+v", tr.Meta)
	}
}

func TestLoadSubagentTranscriptRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	id := "44444444-5555-4666-8777-888888888888"
	writeJSONL(t, filepath.Join(root, "p", id+".jsonl"), `{"type":"user","message":{"content":"x"}}`)
	for _, agent := range []string{"../etc/passwd", "a/b", "", "a b", strings.Repeat("x", 129)} {
		if _, err := LoadSubagentTranscript(root, id, agent); err == nil {
			t.Fatalf("agent=%q 应被拒绝", agent)
		}
	}
	// 会话 id 也要过白名单。
	if _, err := LoadSubagentTranscript(root, "../etc/passwd", "abc"); err == nil {
		t.Fatal("非法会话 id 应被拒绝")
	}
}

func TestLoadSubagentTranscriptMissingFile(t *testing.T) {
	root := t.TempDir()
	id := "55555555-6666-4777-8888-999999999999"
	writeJSONL(t, filepath.Join(root, "p", id+".jsonl"), `{"type":"user","message":{"content":"x"}}`)
	if _, err := LoadSubagentTranscript(root, id, "nope"); err != ErrTranscriptNotFound {
		t.Fatalf("err = %v, want ErrTranscriptNotFound", err)
	}
}
