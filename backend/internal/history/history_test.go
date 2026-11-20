package history

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

// writeFile 写一份非 jsonl 文本（子代理的 meta.json / 空转录）。
func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
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

// CLI 自己写进转录的标题行（终端 /rename、IDE 插件、--name）要比首条用户消息优先。
// 否则「在终端里改过名」的对话进了侧栏还是叫第一句话——用户会以为自己没改成。
func TestListPrefersCLICustomTitle(t *testing.T) {
	root := t.TempDir()
	writeJSONL(t, filepath.Join(root, "p", "s1.jsonl"),
		`{"type":"user","cwd":"/tmp/work","sessionId":"s1","message":{"role":"user","content":"第一句话"}}`,
		`{"type":"custom-title","customTitle":"终端里改的名字","sessionId":"s1"}`,
		`{"type":"user","message":{"role":"user","content":"第二句话"}}`,
	)
	got, _ := List(root)
	if len(got) != 1 {
		t.Fatalf("条数 = %d", len(got))
	}
	if got[0].Title != "终端里改的名字" {
		t.Fatalf("Title = %q, want 终端里改的名字", got[0].Title)
	}
}

// 同一份转录可能有多行标题，以最后一行为准；custom-title 优先于 ai-title。
func TestListUsesLastTitleLine(t *testing.T) {
	root := t.TempDir()
	writeJSONL(t, filepath.Join(root, "p", "s1.jsonl"),
		`{"type":"user","sessionId":"s1","message":{"role":"user","content":"第一句话"}}`,
		`{"type":"custom-title","customTitle":"改了一次","sessionId":"s1"}`,
		`{"type":"custom-title","customTitle":"又改了一次","sessionId":"s1"}`,
	)
	got, _ := List(root)
	if got[0].Title != "又改了一次" {
		t.Fatalf("Title = %q, want 又改了一次（取最后一行）", got[0].Title)
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

// 被中断（TaskStop）的子代理不写 <task-notification>，状态只留在 meta.json 的
// finished 里。不随转录下发的话，重开对话后它们永远停在「运行中」。
func TestLoadTranscriptIncludesSubagentStates(t *testing.T) {
	root := t.TempDir()
	id := "33333333-4444-4555-8666-777777777777"
	proj := filepath.Join(root, "p")
	writeJSONL(t, filepath.Join(proj, id+".jsonl"),
		`{"type":"user","message":{"role":"user","content":"hi"}}`,
	)
	sub := filepath.Join(proj, id, "subagents")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(sub, "agent-done.jsonl"), "")
	writeFile(t, filepath.Join(sub, "agent-done.meta.json"),
		`{"agentType":"general-purpose","description":"跑完了","toolUseId":"tu-1","finished":true}`)
	writeFile(t, filepath.Join(sub, "agent-killed.jsonl"), "")
	// 被中断的那份**没有 finished 字段**（不是 false，是压根不写）。
	writeFile(t, filepath.Join(sub, "agent-killed.meta.json"),
		`{"agentType":"general-purpose","description":"被打断","toolUseId":"tu-2"}`)
	// 坏文件只跳过它自己。
	writeFile(t, filepath.Join(sub, "agent-broken.meta.json"), `{not json`)

	tr, err := LoadTranscript(root, id)
	if err != nil {
		t.Fatalf("LoadTranscript: %v", err)
	}
	byAgent := map[string]SubagentState{}
	for _, s := range tr.Subagents {
		byAgent[s.AgentID] = s
	}
	if len(byAgent) != 2 {
		t.Fatalf("subagents = %+v", tr.Subagents)
	}
	if got := byAgent["done"]; !got.Finished || got.ToolUseID != "tu-1" || got.Description != "跑完了" {
		t.Fatalf("done = %+v", got)
	}
	if got := byAgent["killed"]; got.Finished || got.ToolUseID != "tu-2" {
		t.Fatalf("killed = %+v", got)
	}
}

// 没有 subagents 目录时不该报错（大多数对话都没有子代理）。
func TestLoadTranscriptWithoutSubagents(t *testing.T) {
	root := t.TempDir()
	id := "44444444-5555-4666-8777-888888888888"
	writeJSONL(t, filepath.Join(root, "p", id+".jsonl"),
		`{"type":"user","message":{"role":"user","content":"hi"}}`,
	)
	tr, err := LoadTranscript(root, id)
	if err != nil {
		t.Fatalf("LoadTranscript: %v", err)
	}
	if len(tr.Subagents) != 0 {
		t.Fatalf("subagents = %+v", tr.Subagents)
	}
}

// 被 TaskStop 打断的子代理**既不写 meta.finished、也不写 <task-notification>**，
// 只剩转录末尾那条 `[Request interrupted by user]`。只看 meta 会让它永远「运行中」。
func TestSubagentStateFromTranscriptTail(t *testing.T) {
	root := t.TempDir()
	id := "55555555-6666-4777-8888-999999999999"
	proj := filepath.Join(root, "p")
	writeJSONL(t, filepath.Join(proj, id+".jsonl"),
		`{"type":"user","message":{"role":"user","content":"hi"}}`,
	)
	sub := filepath.Join(proj, id, "subagents")
	cases := []struct {
		agent string
		meta  string
		tail  []string
		want  bool
	}{
		{
			agent: "interrupted",
			meta:  `{"toolUseId":"tu-i"}`, // 没有 finished
			tail: []string{
				`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"在跑"}],"stop_reason":null}}`,
				`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}`,
			},
			want: true,
		},
		{
			agent: "interruptedtool",
			meta:  `{"toolUseId":"tu-it"}`,
			tail: []string{
				`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}`,
			},
			want: true,
		},
		{
			agent: "naturally",
			meta:  `{"toolUseId":"tu-n"}`,
			tail: []string{
				`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"做完了"}],"stop_reason":"end_turn"}}`,
			},
			want: true,
		},
		{
			agent: "stillrunning",
			meta:  `{"toolUseId":"tu-r"}`,
			tail: []string{
				`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read"}],"stop_reason":"tool_use"}}`,
			},
			want: false,
		},
	}
	for _, c := range cases {
		writeFile(t, filepath.Join(sub, "agent-"+c.agent+".jsonl"), "")
		if len(c.tail) > 0 {
			writeJSONL(t, filepath.Join(sub, "agent-"+c.agent+".jsonl"), c.tail...)
		}
		writeFile(t, filepath.Join(sub, "agent-"+c.agent+".meta.json"), c.meta)
	}

	tr, err := LoadTranscript(root, id)
	if err != nil {
		t.Fatalf("LoadTranscript: %v", err)
	}
	got := map[string]bool{}
	for _, s := range tr.Subagents {
		got[s.AgentID] = s.Finished
	}
	for _, c := range cases {
		if got[c.agent] != c.want {
			t.Errorf("%s: finished = %v, want %v", c.agent, got[c.agent], c.want)
		}
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

func TestWriteSessionZipIncludesSidecars(t *testing.T) {
	root := t.TempDir()
	id := "66666666-7777-4888-8999-aaaaaaaaaaaa"
	writeJSONL(t, filepath.Join(root, "p", id+".jsonl"),
		`{"type":"user","message":{"role":"user","content":"hi"}}`,
	)
	sub := filepath.Join(root, "p", id, "subagents")
	writeJSONL(t, filepath.Join(sub, "agent-a1.jsonl"), `{"type":"assistant","isSidechain":true,"message":{"content":[]}}`)
	if err := os.WriteFile(filepath.Join(sub, "agent-a1.meta.json"), []byte(`{"description":"子任务"}`), 0o644); err != nil {
		t.Fatalf("write meta: %v", err)
	}
	// 符号链接不应进包（可能指向工作区外）。
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o644); err != nil {
		t.Fatalf("write outside: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(sub, "link.txt")); err != nil {
		t.Skipf("symlink 不可用: %v", err)
	}

	var buf bytes.Buffer
	if err := WriteSessionZip(&buf, root, id); err != nil {
		t.Fatalf("WriteSessionZip: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("zip: %v", err)
	}
	names := map[string]bool{}
	for _, f := range zr.File {
		names[f.Name] = true
	}
	for _, want := range []string{id + ".jsonl", id + "/subagents/agent-a1.jsonl", id + "/subagents/agent-a1.meta.json"} {
		if !names[want] {
			t.Fatalf("zip 缺少 %q，实际 %v", want, names)
		}
	}
	if names[id+"/subagents/link.txt"] {
		t.Fatal("符号链接不应进包")
	}
}

func TestSessionLogExists(t *testing.T) {
	root := t.TempDir()
	id := "77777777-8888-4999-8aaa-bbbbbbbbbbbb"
	writeJSONL(t, filepath.Join(root, "p", id+".jsonl"), `{"type":"user","message":{"content":"x"}}`)
	if !SessionLogExists(root, id) {
		t.Fatal("应判定存在")
	}
	if SessionLogExists(root, "88888888-9999-4aaa-8bbb-cccccccccccc") {
		t.Fatal("不存在的会话应返回 false")
	}
	if SessionLogExists(root, "../etc/passwd") {
		t.Fatal("非法 id 应返回 false")
	}
}

func TestLoadPreviewReadsTail(t *testing.T) {
	root := t.TempDir()
	id := "aaaaaaaa-1111-4222-8333-444444444444"
	writeJSONL(t, filepath.Join(root, "p", id+".jsonl"),
		`{"type":"user","message":{"role":"user","content":"第一个问题"}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"第一个回答"}]}}`,
		`{"type":"user","message":{"role":"user","content":"<local-command-stdout>Set model to x</local-command-stdout>"}}`,
		`{"type":"user","isSidechain":true,"message":{"role":"user","content":"子代理的问题"}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"工具输出"}]}}`,
		`{"type":"user","message":{"role":"user","content":"最后一个问题"}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"想"},{"type":"text","text":"最后一个回答"}]}}`,
	)
	p, err := LoadPreview(root, id)
	if err != nil {
		t.Fatalf("LoadPreview: %v", err)
	}
	if p.User != "最后一个问题" {
		t.Fatalf("User = %q", p.User)
	}
	if p.Assistant != "最后一个回答" {
		t.Fatalf("Assistant = %q", p.Assistant)
	}
}

func TestLoadPreviewOnlyReadsTail(t *testing.T) {
	root := t.TempDir()
	id := "bbbbbbbb-1111-4222-8333-444444444444"
	filler := strings.Repeat("x", 400)
	var lines []string
	lines = append(lines, `{"type":"user","message":{"content":"很早以前的问题"}}`)
	for i := 0; i < 400; i++ {
		lines = append(lines, `{"type":"assistant","message":{"content":[{"type":"text","text":"`+filler+`"}]}}`)
	}
	lines = append(lines, `{"type":"user","message":{"content":"最新的问题"}}`)
	writeJSONL(t, filepath.Join(root, "p", id+".jsonl"), lines...)

	p, err := LoadPreview(root, id)
	if err != nil {
		t.Fatalf("LoadPreview: %v", err)
	}
	if p.User != "最新的问题" {
		t.Fatalf("User = %q（应该来自尾部，不是开头）", p.User)
	}
	if p.Assistant == "" || strings.Contains(p.Assistant, "很早以前") {
		t.Fatalf("Assistant = %q", p.Assistant)
	}
}

func TestLoadPreviewMissing(t *testing.T) {
	root := t.TempDir()
	if _, err := LoadPreview(root, "cccccccc-1111-4222-8333-444444444444"); err != ErrTranscriptNotFound {
		t.Fatalf("err = %v", err)
	}
	if _, err := LoadPreview(root, "../etc/passwd"); err != ErrTranscriptNotFound {
		t.Fatalf("非法 id 应被拒绝，得到 %v", err)
	}
}

// 回归：单行超长不能让整次回放失败。
//
// 一次带 base64 图片的 tool_result 或读大文件的返回就能让某行超过 8MB；
// 旧实现用 bufio.Scanner，ErrTooLong 直接让 LoadTranscript 返回错误，
// 前端拿到 500，整段历史一行都渲染不出来。
func TestLoadTranscriptSkipsOversizedLine(t *testing.T) {
	root := t.TempDir()
	big := `{"type":"user","message":{"role":"user","content":"` + strings.Repeat("A", 9<<20) + `"}}`
	writeJSONL(t, filepath.Join(root, "-tmp-work", "sess-big.jsonl"),
		`{"type":"user","cwd":"/tmp/work","message":{"role":"user","content":"第一条"}}`,
		big,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"最后一条"}]}}`,
	)

	got, err := LoadTranscript(root, "sess-big")
	if err != nil {
		t.Fatalf("超长行不应让整次回放失败: %v", err)
	}
	if len(got.Lines) != 2 {
		t.Fatalf("可回放行数 = %d, want 2（超长行应跳过，其余保留）", len(got.Lines))
	}
	if got.Cwd != "/tmp/work" {
		t.Fatalf("Cwd = %q", got.Cwd)
	}
}

// 回归：列表摘要不能只看头部 5000 行，也不能把子代理/系统提醒当主消息。
func TestListUsesWholeTranscriptForActivity(t *testing.T) {
	root := t.TempDir()
	lines := []string{
		`{"type":"user","cwd":"/tmp/work","sessionId":"sess-long","timestamp":"2026-11-16T01:00:00Z","message":{"role":"user","content":"第一条"}}`,
		// 子代理与系统提醒：不计消息数，更不能当标题。
		`{"type":"user","isSidechain":true,"timestamp":"2026-11-16T01:01:00Z","message":{"role":"user","content":"子代理的悄悄话"}}`,
		`{"type":"user","isMeta":true,"timestamp":"2026-11-16T01:02:00Z","message":{"role":"user","content":"系统提醒"}}`,
	}
	for i := 0; i < maxTitleScanLines+200; i++ {
		lines = append(lines, `{"type":"assistant","timestamp":"2026-11-16T02:00:00Z","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}`)
	}
	// 第 5200+ 行的时间戳远晚于头部：只有扫完整个文件才能看到。
	lines = append(lines, `{"type":"user","timestamp":"2026-11-17T09:30:00Z","message":{"role":"user","content":"很久以后的一句话"}}`)
	writeJSONL(t, filepath.Join(root, "-tmp-work", "sess-long.jsonl"), lines...)

	got, err := List(root)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("条数 = %d", len(got))
	}
	s := got[0]
	if s.Title != "第一条" {
		t.Fatalf("Title = %q, want 第一条（sidechain/meta 行不能当标题）", s.Title)
	}
	want := "2026-11-17T09:30:00Z"
	if s.UpdatedAt.Format("2006-01-02T15:04:05Z") != want {
		t.Fatalf("UpdatedAt = %v, want %s（不能被前 5000 行截断）", s.UpdatedAt, want)
	}
	// 3 条真实主消息 + 5200 条 assistant + 1 条尾部 user，sidechain/meta 不计。
	if s.Messages != 2+maxTitleScanLines+200 {
		t.Fatalf("Messages = %d, want %d", s.Messages, 2+maxTitleScanLines+200)
	}
}

// 回归：旁路文件过大只该少一个条目，不能终止整次打包。
//
// 旧实现把「超过 64MB」当错误上抛，WalkDir 立刻中止，WriteSessionZip 返回错误 ——
// 而响应头已经发出去了，用户拿到的是 HTTP 200 + 一个没有中央目录的坏 zip。
func TestExportSkipsOversizedSidecar(t *testing.T) {
	root := t.TempDir()
	const id = "sess-export"
	writeJSONL(t, filepath.Join(root, "-tmp-work", id+".jsonl"),
		`{"type":"user","message":{"role":"user","content":"hi"}}`,
	)
	sidecarDir := filepath.Join(root, "-tmp-work", id, "subagents")
	if err := os.MkdirAll(sidecarDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sidecarDir, "agent-1.jsonl"), []byte(`{"type":"user"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// 稀疏文件：不真写 65MB，只把长度撑过上限。
	huge := filepath.Join(sidecarDir, "agent-2.jsonl")
	f, err := os.Create(huge)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(int64(maxExportFileBytes) + 1); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()

	var buf bytes.Buffer
	if err := WriteSessionZip(&buf, root, id); err != nil {
		t.Fatalf("超大旁路文件不应让导出失败: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("zip 不可读（中央目录缺失？）: %v", err)
	}
	names := map[string]bool{}
	for _, f := range zr.File {
		names[f.Name] = true
	}
	if !names[id+".jsonl"] {
		t.Fatal("主转录缺失")
	}
	if !names[id+"/subagents/agent-1.jsonl"] {
		t.Fatal("小旁路文件缺失")
	}
	if names[id+"/subagents/agent-2.jsonl"] {
		t.Fatal("超大旁路文件不应进包")
	}
}

// fork 之后要等新转录落盘：网关靠 TranscriptPath 找到旧文件所在的 project 目录，
// 再只盯旁边那一个文件名。同 id 多份时必须给出最新的那份。
func TestTranscriptPathPrefersNewest(t *testing.T) {
	root := t.TempDir()
	id := "77777777-8888-4999-8aaa-bbbbbbbbbbbb"
	older := filepath.Join(root, "p-old", id+".jsonl")
	newer := filepath.Join(root, "p-new", id+".jsonl")
	writeJSONL(t, older, `{"type":"user","message":{"content":"x"}}`)
	writeJSONL(t, newer, `{"type":"user","message":{"content":"y"}}`)
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(older, old, old); err != nil {
		t.Fatal(err)
	}

	got, err := TranscriptPath(root, id)
	if err != nil {
		t.Fatal(err)
	}
	if got != newer {
		t.Fatalf("TranscriptPath = %q, want %q", got, newer)
	}
	// 非法 id 不能拼路径（和 SessionLogExists 同一条白名单）。
	if _, err := TranscriptPath(root, "../etc/passwd"); !errors.Is(err, ErrTranscriptNotFound) {
		t.Fatalf("非法 id 应返回 ErrTranscriptNotFound，实际 %v", err)
	}
}

// 中断标记是 CLI 写的合成 user 行：既不是用户说的话，也不能当标题
// （否则「先按 Esc、再发消息」的对话在列表里叫 “[Request interrupted by user]”）。
func TestListSkipsInterruptMarker(t *testing.T) {
	root := t.TempDir()
	writeJSONL(t, filepath.Join(root, "-tmp-work", "it.jsonl"),
		`{"type":"user","cwd":"/tmp/work","sessionId":"it","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"[Request interrupted by user]"}}`,
		`{"type":"user","cwd":"/tmp/work","sessionId":"it","timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":"来点新闻"}}`,
		`{"type":"assistant","cwd":"/tmp/work","sessionId":"it","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"好的"}]}}`,
	)
	got, err := List(root)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("应只有一条会话: %v", got)
	}
	if got[0].Title != "来点新闻" {
		t.Fatalf("标题应跳过中断标记，实际 %q", got[0].Title)
	}
	if got[0].Messages != 2 {
		t.Fatalf("消息数应为 2（中断标记不计），实际 %d", got[0].Messages)
	}
}

func TestIsInterruptMarker(t *testing.T) {
	yes := []string{
		"[Request interrupted by user]",
		"[Request interrupted by user for tool use]",
		"[Request interrupted: the session ended before this agent finished.]",
		"[Agent call interrupted: the process stopped]",
		"  [Request interrupted by user]  ",
	}
	no := []string{
		"",
		"[Request interrupted by user] 为什么会出现这句？",
		"来点新闻",
		"<local-command-stdout>x</local-command-stdout>",
	}
	for _, s := range yes {
		if !isInterruptMarker(s) {
			t.Errorf("应识别为中断标记: %q", s)
		}
	}
	for _, s := range no {
		if isInterruptMarker(s) {
			t.Errorf("不应识别为中断标记: %q", s)
		}
	}
}

// 后台任务结束时 CLI 会写一条普通 user 行（isMeta 是 null，绕过 sidechain/meta 过滤）。
// 它既不该算一条消息，也不能当会话标题——否则列表里会出现一条叫
// `<task-notification> <task-id>…` 的对话。
func TestIsTaskNotification(t *testing.T) {
	yes := []string{
		// 实测原样（后台命令被停止）。
		"<task-notification>\n<task-id>bv3vaq2qk</task-id>\n<tool-use-id>call_00_ET_og59i9eP45vid7zHTkFU2465</tool-use-id>\n<output-file>/tmp/x.output</output-file>\n<status>killed</status>\n<summary>Background command \"Run 529 mock server\" was stopped</summary>\n<note>…</note>\n</task-notification>",
		// 子代理完成的通知（带 <result>）。
		"<task-notification>\n<task-id>afcc941f067953058</task-id>\n<status>completed</status>\n<result>ok</result>\n</task-notification>",
	}
	no := []string{
		"",
		"hello",
		// 用户在正文里贴了这段 XML：前后还有自己的话，不能吞掉。
		"帮我看下这个：\n<task-notification>\n<task-id>x</task-id>\n</task-notification>",
		"<task-notification>缺结束标签",
		"<div>hi</div>",
	}
	for _, v := range yes {
		if !isTaskNotification(v) {
			t.Fatalf("应判定为任务通知: %q", v)
		}
	}
	for _, v := range no {
		if isTaskNotification(v) {
			t.Fatalf("不应判定为任务通知: %q", v)
		}
	}
}

// 以任务通知开头的对话，标题必须继续往后找真正的用户提问，而不是被那段 XML 占住。
func TestSummarizeSkipsTaskNotificationForTitle(t *testing.T) {
	dir := t.TempDir()
	id := "44444444-5555-4666-8777-888888888888"
	path := filepath.Join(dir, "p", id+".jsonl")
	writeJSONL(t, path,
		`{"type":"user","sessionId":"`+id+`","message":{"role":"user","content":"<task-notification>\n<task-id>x</task-id>\n<status>killed</status>\n</task-notification>"},"timestamp":"2026-01-01T00:00:00Z"}`,
		`{"type":"user","sessionId":"`+id+`","message":{"role":"user","content":"这条才是用户说的话"},"timestamp":"2026-01-01T00:00:01Z"}`,
	)
	s := summarize(path, "p")
	if s.Title != "这条才是用户说的话" {
		t.Fatalf("标题 = %q, want 用户的真问题", s.Title)
	}
	// 通知不算一条消息：只数后面那条提问。
	if s.Messages != 1 {
		t.Fatalf("消息数 = %d, want 1（任务通知不该计数）", s.Messages)
	}
}
