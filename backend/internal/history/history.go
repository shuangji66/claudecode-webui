// Package history 读取 claude 的会话转录文件，供「会话列表 / 历史回放」使用。
//
// 转录文件位置（claude 自己写入，本应用只读）：
//
//	~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl
//
// 一行一个 JSON 对象。首条 user 消息的文本用作会话标题。
package history

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// maxScanLines 是列表摘要单次扫描的行数上限（与回放上限同量级），
// maxTitleScanLines 是「取标题」只看头部多少行——标题来自首条用户消息，
// 而时间戳与消息数必须覆盖整份转录。
const (
	maxScanLines      = 20000
	maxTitleScanLines = 5000
)

// Session 是一条历史会话的摘要。
type Session struct {
	ID        string    `json:"id"`
	Cwd       string    `json:"cwd"`
	Title     string    `json:"title"`
	UpdatedAt time.Time `json:"updated_at"`
	Messages  int       `json:"messages"`
	Project   string    `json:"project"`
}

type transcriptLine struct {
	Type        string `json:"type"`
	Cwd         string `json:"cwd"`
	SessionID   string `json:"sessionId"`
	Timestamp   string `json:"timestamp"`
	IsSidechain bool   `json:"isSidechain"`
	IsMeta      bool   `json:"isMeta"`
	Message     struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

// List 扫描 projectsDir 下所有转录，返回按更新时间倒序的会话摘要。
func List(projectsDir string) ([]Session, error) {
	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []Session{}, nil
		}
		return nil, err
	}
	var out []Session
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		projectDir := filepath.Join(projectsDir, e.Name())
		files, err := os.ReadDir(projectDir)
		if err != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}
			path := filepath.Join(projectDir, f.Name())
			s := summarize(path, e.Name())
			if s.ID == "" {
				s.ID = strings.TrimSuffix(f.Name(), ".jsonl")
			}
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out, nil
}

func summarize(path, project string) Session {
	s := Session{Project: project}
	f, err := os.Open(path)
	if err != nil {
		return s
	}
	defer f.Close()

	titleDone := false
	lines := 0
	// 时间戳与消息数要看整份转录：只读头部 5000 行会让长对话的「最近活跃」
	// 停在第 5000 行那一刻，侧栏排序与自动预热都会选错。
	_ = scanLines(f, 4<<20, func(line []byte) bool {
		lines++
		if lines > maxScanLines {
			return false
		}
		var l transcriptLine
		if err := json.Unmarshal(line, &l); err != nil {
			return true
		}
		// 子代理消息与系统提醒不算主消息，也不能当标题——回放那边同样过滤。
		if l.IsSidechain || l.IsMeta {
			return true
		}
		if l.Cwd != "" && s.Cwd == "" {
			s.Cwd = l.Cwd
		}
		if l.SessionID != "" && s.ID == "" {
			s.ID = l.SessionID
		}
		if ts, err := time.Parse(time.RFC3339Nano, l.Timestamp); err == nil {
			if ts.After(s.UpdatedAt) {
				s.UpdatedAt = ts
			}
		}
		switch l.Type {
		case "user", "assistant":
			// 本地斜杠命令的回显（/model 的 `<local-command-stdout>`、`<command-name>`
			// 包装）也被写成 user 行。它们既不该计数，更不能当会话标题——否则列表里
			// 会出现一条叫 "Set model to `x`" 的对话。
			if l.Type == "user" && isLocalCommandEcho(extractText(l.Message.Content)) {
				return true
			}
			// 中断标记同理：它不是用户说的话（「先中断、再发消息」的对话会被命名成
			// “[Request interrupted by user]”），也不该算一条消息。
			if l.Type == "user" && isInterruptMarker(extractText(l.Message.Content)) {
				return true
			}
			s.Messages++
			if l.Type == "user" && !titleDone && lines <= maxTitleScanLines {
				if txt := extractText(l.Message.Content); txt != "" {
					s.Title = truncate(txt, 80)
					titleDone = true
				}
			}
		}
		return true
	})
	if s.Title == "" {
		s.Title = strings.TrimSuffix(filepath.Base(path), ".jsonl")
	}
	return s
}

// scanLines 逐行读取并回调 fn；fn 返回 false 时停止。
//
// 单行超过 limit 时只丢弃这一行、继续读后面的行。原先用 bufio.Scanner：
// 一条带 base64 图片的 tool_result 或一次大文件 Read 就能让某行超过 8MB，
// Scanner 直接返回 ErrTooLong，整次回放变成 500 —— 明明只有一行读不了。
func scanLines(r io.Reader, limit int, fn func(line []byte) bool) error {
	br := bufio.NewReaderSize(r, 64*1024)
	var buf []byte
	dropping := false
	for {
		chunk, err := br.ReadSlice('\n')
		if len(chunk) > 0 {
			switch {
			case dropping:
				// 超长行的剩余部分，直接丢。
			case len(buf)+len(chunk) > limit:
				buf = nil
				dropping = true
			default:
				buf = append(buf, chunk...)
			}
		}
		switch {
		case err == nil:
			line := bytes.TrimRight(buf, "\r\n")
			if !dropping && len(line) > 0 && !fn(line) {
				return nil
			}
			buf = nil
			dropping = false
		case errors.Is(err, bufio.ErrBufferFull):
			// 这一行还没读完，继续。
		case errors.Is(err, io.EOF):
			if !dropping && len(buf) > 0 {
				_ = fn(bytes.TrimRight(buf, "\r\n"))
			}
			return nil
		default:
			return err
		}
	}
}

// extractText 从 content（字符串或内容块数组）里取出纯文本。
func extractText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var str string
	if err := json.Unmarshal(raw, &str); err == nil {
		return strings.TrimSpace(str)
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err == nil {
		var sb strings.Builder
		for _, b := range blocks {
			if b.Type == "text" && b.Text != "" {
				if sb.Len() > 0 {
					sb.WriteByte(' ')
				}
				sb.WriteString(b.Text)
			}
		}
		return strings.TrimSpace(sb.String())
	}
	return ""
}

// localCommandEchoRE 与前端 lib/normalize.ts 的规则保持一致：整条消息只由
// `<local-command-*>` / `<command-*>` 标签组成时才算本地命令回显。
var localCommandEchoRE = regexp.MustCompile(`(?s)^<(local-command-(?:stdout|stderr|caveat)|command-(?:name|message|args))[\s\S]*</(local-command-(?:stdout|stderr|caveat)|command-(?:name|message|args))>$`)

// isLocalCommandEcho 判断一条 user 文本是否是本地斜杠命令的回显。
func isLocalCommandEcho(text string) bool {
	t := strings.TrimSpace(text)
	if !strings.HasPrefix(t, "<") {
		return false
	}
	return localCommandEchoRE.MatchString(t)
}

// interruptMarkerRE 与前端 lib/normalize.ts 的规则保持一致：回合被中断时 CLI 会往
// 转录里写一条合成的 user 行（`[Request interrupted by user]`，工具执行中是
// `[Request interrupted by user for tool use]`，进程/会话被结束时是
// `[Request interrupted: …]` / `[Agent call interrupted: …]`）。
var interruptMarkerRE = regexp.MustCompile(`^\[(?:Request interrupted|Agent call interrupted)(?: by user|:)[^\]]*\]$`)

// isInterruptMarker 判断一条 user 文本是否是 CLI 的中断标记。
//
// 它不是用户说的话：既不该计入消息数，更不能当会话标题——否则「先中断、再发消息」
// 的对话在列表里会叫 “[Request interrupted by user]”。
func isInterruptMarker(text string) bool {
	return interruptMarkerRE.MatchString(strings.TrimSpace(text))
}

func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// ErrTranscriptNotFound 表示按 id 找不到转录文件。
var ErrTranscriptNotFound = errors.New("history: 找不到该对话的转录")

// Transcript 是一次对话的原始事件行，供前端按与实时 CLI 相同的
// normalize 逻辑回放。Lines 已过滤 sidechain / meta 行，按原始顺序排列。
type Transcript struct {
	ID        string            `json:"id"`
	Cwd       string            `json:"cwd,omitempty"`
	Lines     []json.RawMessage `json:"lines"`
	Truncated bool              `json:"truncated,omitempty"`
}

// 回放上限：太长会把浏览器和 JSON 响应一起拖垮，只保留最近的一段。
var (
	maxTranscriptLines = 20000
	maxTranscriptBytes = 16 << 20
)

// LoadTranscript 按会话 id 找到转录并读取可回放的行。
//
// id 来自历史列表 / 对话元数据，只接受字母数字与 '-' '_'，不能拼路径。
func LoadTranscript(projectsDir, id string) (Transcript, error) {
	if !validSessionID(id) {
		return Transcript{}, ErrTranscriptNotFound
	}
	path, err := findTranscript(projectsDir, id)
	if err != nil {
		return Transcript{}, err
	}
	f, err := os.Open(path)
	if err != nil {
		return Transcript{}, err
	}
	defer f.Close()
	// 主转录里丢掉 sidechain 行：子代理的消息不能混进主消息流。
	return scanTranscript(f, id, false)
}

// scanTranscript 读一份 jsonl 里可回放的行。
//
// keepSidechain 在两种调用里相反：主转录要丢掉 sidechain（那是子代理的话），
// 而子代理自己的转录文件里每一行都带 isSidechain，正是要保留的内容。
func scanTranscript(r io.Reader, id string, keepSidechain bool) (Transcript, error) {
	out := Transcript{ID: id, Lines: make([]json.RawMessage, 0, 128)}
	total := 0
	err := scanLines(r, 8<<20, func(line []byte) bool {
		var meta struct {
			Type        string `json:"type"`
			IsSidechain bool   `json:"isSidechain"`
			IsMeta      bool   `json:"isMeta"`
			Cwd         string `json:"cwd"`
		}
		if err := json.Unmarshal(line, &meta); err != nil {
			return true
		}
		if out.Cwd == "" && meta.Cwd != "" {
			out.Cwd = meta.Cwd
		}
		if meta.IsMeta || (meta.IsSidechain && !keepSidechain) {
			return true
		}
		switch meta.Type {
		case "user", "assistant", "system", "result":
		default:
			return true
		}
		// line 的底层数组会被复用，必须复制后再保留。
		copied := append(json.RawMessage(nil), line...)
		out.Lines = append(out.Lines, copied)
		total += len(copied)
		for len(out.Lines) > maxTranscriptLines || (total > maxTranscriptBytes && len(out.Lines) > 1) {
			total -= len(out.Lines[0])
			out.Lines = out.Lines[1:]
			out.Truncated = true
		}
		return true
	})
	if err != nil {
		return Transcript{}, err
	}
	return out, nil
}

// findTranscript 在 projectsDir/<project>/<id>.jsonl 中查找；同 id 有多份时取最新。
func findTranscript(projectsDir, id string) (string, error) {
	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return "", ErrTranscriptNotFound
		}
		return "", err
	}
	var best string
	var bestMod time.Time
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		cand := filepath.Join(projectsDir, e.Name(), id+".jsonl")
		st, err := os.Stat(cand)
		if err != nil || st.IsDir() {
			continue
		}
		if best == "" || st.ModTime().After(bestMod) {
			best = cand
			bestMod = st.ModTime()
		}
	}
	if best == "" {
		return "", ErrTranscriptNotFound
	}
	return best, nil
}

// TranscriptPath 返回某个会话转录文件的绝对路径（同 id 有多份时取最新）。
//
// 网关 fork 之后要等新转录落盘：新文件与旧会话写在**同一个 project 目录**下
// （cwd 相同 → 目录名相同），拿到旧文件的路径就能只盯旁边那一个候选，
// 不必每 50ms 重扫整个 projects 树。
func TranscriptPath(projectsDir, id string) (string, error) {
	if !validSessionID(id) {
		return "", ErrTranscriptNotFound
	}
	return findTranscript(projectsDir, id)
}

// TranscriptExists 报告某个会话的转录文件是否已经落盘。
func TranscriptExists(projectsDir, id string) bool {
	_, err := TranscriptPath(projectsDir, id)
	return err == nil
}

func validSessionID(id string) bool {
	if len(id) < 8 || len(id) > 64 {
		return false
	}
	for _, r := range id {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return false
	}
	return true
}

// SubagentMeta 是子代理转录旁的 meta.json（best-effort：读不到不算错）。
type SubagentMeta struct {
	AgentType   string `json:"agentType,omitempty"`
	Description string `json:"description,omitempty"`
	ToolUseID   string `json:"toolUseId,omitempty"`
	SpawnDepth  int    `json:"spawnDepth,omitempty"`
	Finished    bool   `json:"finished,omitempty"`
}

// SubagentTranscript 是一个子代理的对话回放。
type SubagentTranscript struct {
	Transcript
	// Agent 是 claude 给这个子代理的 id（也是任务 id）。
	Agent string        `json:"agent"`
	Meta  *SubagentMeta `json:"meta,omitempty"`
}

// LoadSubagentTranscript 读取子代理的转录。
//
// 子代理的对话**不在主转录里**：主 jsonl 没有 sidechain 行，claude 把它单独写在
// <project>/<session>/subagents/agent-<agent>.jsonl（嵌套子代理再深一层，本函数
// 只取直接子级）。所以「查看子代理对话」必须走这条旁路，不能靠回放主转录。
func LoadSubagentTranscript(projectsDir, sessionID, agentID string) (SubagentTranscript, error) {
	if !validSessionID(sessionID) || !validAgentID(agentID) {
		return SubagentTranscript{}, ErrTranscriptNotFound
	}
	path, err := findTranscript(projectsDir, sessionID)
	if err != nil {
		return SubagentTranscript{}, err
	}
	dir := filepath.Join(filepath.Dir(path), sessionID, "subagents")
	f, err := os.Open(filepath.Join(dir, "agent-"+agentID+".jsonl"))
	if err != nil {
		if os.IsNotExist(err) {
			return SubagentTranscript{}, ErrTranscriptNotFound
		}
		return SubagentTranscript{}, err
	}
	defer f.Close()

	tr, err := scanTranscript(f, agentID, true)
	if err != nil {
		return SubagentTranscript{}, err
	}
	out := SubagentTranscript{Transcript: tr, Agent: agentID}
	if b, err := os.ReadFile(filepath.Join(dir, "agent-"+agentID+".meta.json")); err == nil {
		var meta SubagentMeta
		if json.Unmarshal(b, &meta) == nil {
			out.Meta = &meta
		}
	}
	return out, nil
}

// validAgentID 只接受字母数字与 '-' '_'：agent id 来自前端，不能拼路径。
func validAgentID(id string) bool {
	if len(id) < 1 || len(id) > 128 {
		return false
	}
	for _, r := range id {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return false
	}
	return true
}
