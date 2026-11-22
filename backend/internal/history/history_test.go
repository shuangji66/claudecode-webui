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

// mustJSON 把一段文本编码成 JSON 字符串字面量（测试里要往 jsonl 里塞带换行的正文）。
func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
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

// 后台子代理的用量只在 stdout 的 task_notification 里；主转录那条 notification 不带
// <usage>。重启后只能从子代理自己的转录恢复「用了多少 token / 跑了多久」。
func TestSubagentStatesRecoverUsageFromTranscript(t *testing.T) {
	root := t.TempDir()
	id := "88888888-9999-4aaa-8bbb-cccccccccccc"
	proj := filepath.Join(root, "p")
	writeJSONL(t, filepath.Join(proj, id+".jsonl"),
		`{"type":"user","message":{"role":"user","content":"hi"}}`,
	)
	sub := filepath.Join(proj, id, "subagents")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	// 两次请求：只认**最后一条**带 usage 的 assistant（CLI 的 subagent_tokens 口径）。
	writeJSONL(t, filepath.Join(sub, "agent-usage.jsonl"),
		`{"type":"user","timestamp":"2026-01-02T00:00:00.000Z","message":{"role":"user","content":"think"}}`,
		`{"type":"assistant","timestamp":"2026-01-02T00:00:05.000Z","message":{"role":"assistant","usage":{"input_tokens":100,"cache_read_input_tokens":900,"cache_creation_input_tokens":0,"output_tokens":50},"content":[]}}`,
		`{"type":"assistant","timestamp":"2026-01-02T00:00:33.000Z","message":{"role":"assistant","usage":{"input_tokens":300,"cache_read_input_tokens":9000,"cache_creation_input_tokens":700,"output_tokens":500},"content":[]}}`,
	)
	writeFile(t, filepath.Join(sub, "agent-usage.meta.json"), `{"toolUseId":"tu-u","finished":true}`)

	tr, err := LoadTranscript(root, id)
	if err != nil {
		t.Fatalf("LoadTranscript: %v", err)
	}
	if len(tr.Subagents) != 1 {
		t.Fatalf("subagents = %+v", tr.Subagents)
	}
	got := tr.Subagents[0]
	if got.Tokens != 10500 {
		t.Fatalf("tokens = %d, want 10500", got.Tokens)
	}
	if got.EndedAt != 1767312033000 { // 2026-01-02T00:00:33Z
		t.Fatalf("ended_at = %d", got.EndedAt)
	}
	// 没有任何 timestamp / usage 的转录不编数。
	writeJSONL(t, filepath.Join(sub, "agent-empty.jsonl"),
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]}}`,
	)
	tr, err = LoadTranscript(root, id)
	if err != nil {
		t.Fatalf("LoadTranscript: %v", err)
	}
	for _, s := range tr.Subagents {
		if s.AgentID == "empty" && (s.Tokens != 0 || s.EndedAt != 0) {
			t.Fatalf("empty = %+v", s)
		}
	}
}

// 枚举以**转录文件**为准，不能只看 meta.json：meta 是 claude 收尾时才补全的，
// 进程被杀 / 会话被回收 / TaskStop 打断时可能只留下 jsonl——偏偏这些才是需要
// 「已结束」判定的（前端本来还挂在 running 上转圈）。
func TestSubagentStatesFromTranscriptWithoutMeta(t *testing.T) {
	root := t.TempDir()
	id := "77777777-8888-4999-8aaa-bbbbbbbbbbbb"
	proj := filepath.Join(root, "p")
	writeJSONL(t, filepath.Join(proj, id+".jsonl"),
		`{"type":"user","message":{"role":"user","content":"hi"}}`,
	)
	sub := filepath.Join(proj, id, "subagents")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	// 只有 jsonl，没有 meta.json：末尾是中断标记。
	writeJSONL(t, filepath.Join(sub, "agent-nometa.jsonl"),
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"在跑"}],"stop_reason":null}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}`,
	)
	// meta 坏掉的那条也要按转录算出来。
	writeJSONL(t, filepath.Join(sub, "agent-badmeta.jsonl"),
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"做完了"}],"stop_reason":"end_turn"}}`,
	)
	writeFile(t, filepath.Join(sub, "agent-badmeta.meta.json"), `{not json`)

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
	if got := byAgent["nometa"]; !got.Finished {
		t.Fatalf("没有 meta 但转录末尾是中断标记，应判收尾: %+v", got)
	}
	if got := byAgent["badmeta"]; !got.Finished {
		t.Fatalf("meta 坏掉时应回落到转录的 end_turn: %+v", got)
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

// 附图注解：CLI 把图片的尺寸与坐标换算系数写成一行 user 消息给模型看。
// 转录里它带 isMeta（scanTranscript 已经丢掉），但**实时流上的同一帧没有 isMeta**
// （实测 2.1.330），前端靠 isImageAnnotation 挡；后端这里只是双保险：
// 万一哪天它不带 isMeta 落盘，也不能让列表标题变成一段英文坐标系说明。
func TestIsImageAnnotation(t *testing.T) {
	yes := []string{
		"[Image: source: /tmp/claude-777/x/images/1.png]",
		"[Image: original 2042x1406, displayed at 2000x1377. Multiply coordinates by 1.02 to map to original image.]",
		"  [Image: source: /tmp/a.png]  ",
		// 一条消息里连着好几张图。
		"[Image: source: /tmp/a.png][Image: source: /tmp/b.png]",
	}
	no := []string{
		"",
		"hello",
		// 用户自己打的话：后面还有正文。
		"[Image: source: /tmp/a.png] 这张怎么是歪的？",
		"[Image: 随便写的]",
		"[Image: original 加一",
	}
	for _, v := range yes {
		if !isImageAnnotation(v) {
			t.Errorf("应判定为附图注解: %q", v)
		}
	}
	for _, v := range no {
		if isImageAnnotation(v) {
			t.Errorf("不应判定为附图注解: %q", v)
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

// 压缩之后 CLI 会把摘要写成一条 user 行（`isCompactSummary` / `isVisibleInTranscriptOnly`）。
// 不挡的话压缩过一轮的对话在侧栏里会叫
// "This session is being continued from a previous conversation that ran out of…"。
func TestSummarizeSkipsCompactSummaryForTitle(t *testing.T) {
	dir := t.TempDir()
	id := "55555555-6666-4777-8888-999999999999"
	path := filepath.Join(dir, "p", id+".jsonl")
	writeJSONL(t, path,
		`{"type":"user","sessionId":"`+id+`","message":{"role":"user","content":"压缩前的问题"},"timestamp":"2026-01-01T00:00:00Z"}`,
		`{"type":"user","isCompactSummary":true,"isVisibleInTranscriptOnly":true,"sessionId":"`+id+`","message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context. …"},"timestamp":"2026-01-01T00:00:01Z"}`,
		`{"type":"assistant","sessionId":"`+id+`","message":{"role":"assistant","content":[{"type":"text","text":"继续"}]},"timestamp":"2026-01-01T00:00:02Z"}`,
	)
	s := summarize(path, "p")
	if s.Title != "压缩前的问题" {
		t.Fatalf("标题 = %q, want 压缩前的那句提问", s.Title)
	}
	// 续接提示不算一条消息：一条提问 + 一条回答。
	if s.Messages != 2 {
		t.Fatalf("消息数 = %d, want 2（续接提示不该计数）", s.Messages)
	}
}

// 压缩正好赶上用户发消息时，CLI 把续接提示与用户那句话拼成一条 user 行。
// 整条丢掉会吞掉用户的提问，整条显示就是一大段英文摘要——只留后半截。
func TestSummarizeCutsContinuationPrefix(t *testing.T) {
	dir := t.TempDir()
	id := "66666666-7777-4888-9999-aaaaaaaaaaaa"
	path := filepath.Join(dir, "p", id+".jsonl")
	text := "This session is being continued from a previous conversation that ran out of context.\n\n" +
		"Summary:\n1. Primary Request: 一大堆英文摘要\n\n" +
		"Continue the conversation from where it left off without asking the user any further questions. " +
		"Resume directly — do not acknowledge the summary, do not recap what was happening, " +
		"do not preface with \"I'll continue\" or similar. Pick up the last task as if the break never happened.\n\n" +
		"The messages after this summary are the most recent messages from before compaction, kept verbatim. " +
		"The summary was written without seeing them, so something it says has not happened yet may already have happened in them. 压缩之后接着干"
	writeJSONL(t, path,
		`{"type":"user","sessionId":"`+id+`","message":{"role":"user","content":`+string(mustJSON(t, text))+`},"timestamp":"2026-01-01T00:00:00Z"}`,
	)
	s := summarize(path, "p")
	if s.Title != "压缩之后接着干" {
		t.Fatalf("标题 = %q, want 用户那半句", s.Title)
	}
	if s.Messages != 1 {
		t.Fatalf("消息数 = %d, want 1", s.Messages)
	}
}

// 消息数的口径不能被续接提示的过滤带偏：`tool_result` 与「只发了图片的提问」
// 抽出来的文本都是空串，但它们都是真实的一条消息。按「文本为空就不计数」写会把
// 它们一起抹掉——实测一份真实转录从 567 掉到 372。
func TestSummarizeCountsToolResultAndImageOnlyRows(t *testing.T) {
	dir := t.TempDir()
	id := "88888888-9999-4aaa-bbbb-cccccccccccc"
	path := filepath.Join(dir, "p", id+".jsonl")
	writeJSONL(t, path,
		// 用户提问
		`{"type":"user","sessionId":"`+id+`","message":{"role":"user","content":"看看这张图"},"timestamp":"2026-01-01T00:00:00Z"}`,
		// 只发了一张图（没有 text block，extractText 是空串）
		`{"type":"user","sessionId":"`+id+`","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAA"}}]},"timestamp":"2026-01-01T00:00:01Z"}`,
		// 工具回包（内容在 tool_result 里，extractText 取不到）
		`{"type":"user","sessionId":"`+id+`","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"工具输出"}]},"timestamp":"2026-01-01T00:00:02Z"}`,
		// 续接提示（这条才不该计数）
		`{"type":"user","isCompactSummary":true,"isVisibleInTranscriptOnly":true,"sessionId":"`+id+`","message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context. …"},"timestamp":"2026-01-01T00:00:03Z"}`,
		`{"type":"assistant","sessionId":"`+id+`","message":{"role":"assistant","content":[{"type":"text","text":"看到了"}]},"timestamp":"2026-01-01T00:00:04Z"}`,
	)
	s := summarize(path, "p")
	if s.Messages != 4 {
		t.Fatalf("消息数 = %d, want 4（提问/图片/工具回包/回答；只有续接提示不计数）", s.Messages)
	}
	if s.Title != "看看这张图" {
		t.Fatalf("标题 = %q", s.Title)
	}
}

func TestScanTranscriptDropsContinuationRows(t *testing.T) {
	root := t.TempDir()
	id := "77777777-8888-4999-aaaa-bbbbbbbbbbbb"
	writeJSONL(t, filepath.Join(root, "p", id+".jsonl"),
		`{"type":"user","cwd":"/tmp/work","message":{"role":"user","content":"你好"}}`,
		`{"type":"user","isCompactSummary":true,"isVisibleInTranscriptOnly":true,"message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context. …"}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"收到"}]}}`,
	)
	tr, err := LoadTranscript(root, id)
	if err != nil {
		t.Fatalf("LoadTranscript: %v", err)
	}
	// 续接提示有 16KB，不在这里丢掉的话每次压缩都白传一遍。
	if len(tr.Lines) != 2 {
		t.Fatalf("lines = %d, want 2（续接提示不该回放）", len(tr.Lines))
	}
}

// 列表摘要有缓存：文件没变就不重扫。
//
// 这条不是优化洁癖：`GET /api/conversations` 每次都把 projectsDir 下**每一份**
// jsonl 从头解一遍（单份上限 20000 行），而归档/取消归档、打开对话、跨设备同步
// 后面都挂着一次列表重建——实测 40 份 × 20000 行要 2.2s，NAS 上只会更慢。
func TestListCachesUnchangedTranscripts(t *testing.T) {
	root := t.TempDir()
	writeJSONL(t, filepath.Join(root, "p", "s1.jsonl"),
		`{"type":"user","cwd":"/tmp/work","sessionId":"s1","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"第一句"}}`)

	_, scansBefore := summaryStats()
	first, err := List(root)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	_, scansAfterFirst := summaryStats()
	if scansAfterFirst-scansBefore != 1 {
		t.Fatalf("首次应扫 1 份，实扫 %d", scansAfterFirst-scansBefore)
	}

	second, err := List(root)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if _, scansAfterSecond := summaryStats(); scansAfterSecond != scansAfterFirst {
		t.Fatalf("文件没变不该重扫：%d → %d", scansAfterFirst, scansAfterSecond)
	}
	if len(second) != 1 || second[0] != first[0] {
		t.Fatalf("命中缓存的结果应与首次一致：%+v vs %+v", second, first)
	}
}

// 转录是追加写的：追加一行之后 size 变了，必须重扫并反映出来。
func TestListRescansAfterAppend(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "p", "s1.jsonl")
	writeJSONL(t, path, `{"type":"user","sessionId":"s1","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"第一句"}}`)
	if _, err := List(root); err != nil {
		t.Fatalf("List: %v", err)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := f.WriteString(`{"type":"assistant","timestamp":"2026-02-02T00:00:00Z","message":{"role":"assistant","content":[{"type":"text","text":"回答"}]}}` + "\n"); err != nil {
		t.Fatalf("append: %v", err)
	}
	f.Close()

	_, scansBefore := summaryStats()
	got, err := List(root)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if _, scansAfter := summaryStats(); scansAfter-scansBefore != 1 {
		t.Fatalf("追加后应重扫 1 份，实扫 %d", scansAfter-scansBefore)
	}
	if len(got) != 1 || got[0].UpdatedAt.Year() != 2026 || got[0].UpdatedAt.Month() != time.February {
		t.Fatalf("摘要应重新算出新的更新时间：%+v", got)
	}
}

// 转录被删掉时缓存条目跟着清：否则同名文件重建（大小恰好相同）会拿到旧摘要。
func TestListPrunesCacheForMissingFiles(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "p", "s1.jsonl")
	writeJSONL(t, path, `{"type":"user","sessionId":"s1","message":{"role":"user","content":"第一句"}}`)
	if _, err := List(root); err != nil {
		t.Fatalf("List: %v", err)
	}
	if cached := cachedUnder(root); cached == 0 {
		t.Fatal("首次扫描后应有缓存")
	}
	if err := os.Remove(path); err != nil {
		t.Fatalf("remove: %v", err)
	}
	got, err := List(root)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("文件删掉后不应再列出：%+v", got)
	}
	if left := cachedUnder(root); left != 0 {
		t.Fatalf("删掉的文件应从缓存里清掉，还剩 %d 条", left)
	}
}

// cachedUnder 数这个目录下的缓存条目（同包测试用；别的用例的临时目录不算）。
func cachedUnder(dir string) int {
	prefix := filepath.Clean(dir) + string(filepath.Separator)
	summaryCache.mu.Lock()
	defer summaryCache.mu.Unlock()
	n := 0
	for p := range summaryCache.m {
		if strings.HasPrefix(p, prefix) {
			n++
		}
	}
	return n
}

// 保留 mtime 的整文件替换（`rsync -a` / `cp -p` / `tar -x -p` 从备份恢复同名转录）
// 会得到一个「看起来没变」的文件：mtime 与 size 都可能与旧内容一致。只按这两项判缓存，
// 侧栏那份标题与消息数会一直是旧的，直到文件再变或进程重启。
func TestListRescansWhenContentReplacedKeepingMtime(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "p", "s1.jsonl")
	first := `{"type":"user","sessionId":"s1","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"第一句"}}`
	writeJSONL(t, path, first)
	if _, err := List(root); err != nil {
		t.Fatalf("List: %v", err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	// 同一长度、把时间戳改回原样：这是备份恢复的典型形态。
	second := `{"type":"user","sessionId":"s1","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"第二句"}}`
	if len(second) != len(first) {
		t.Fatalf("测试前提：两段内容长度必须一致（%d vs %d）", len(second), len(first))
	}
	if err := os.WriteFile(path, []byte(second+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, st.ModTime(), st.ModTime()); err != nil {
		t.Fatal(err)
	}

	_, scansBefore := summaryStats()
	got, err := List(root)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if _, scansAfter := summaryStats(); scansAfter-scansBefore != 1 {
		t.Fatalf("mtime+size 相同但内容被换掉时必须重扫，实扫 %d", scansAfter-scansBefore)
	}
	if len(got) != 1 || got[0].Title != "第二句" {
		t.Fatalf("摘要应反映新内容：%+v", got)
	}
}
