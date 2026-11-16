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
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// maxScanLines 是单个转录文件参与解析的最大行数，避免超大文件拖慢列表接口。
const maxScanLines = 5000

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
	Type      string `json:"type"`
	Cwd       string `json:"cwd"`
	SessionID string `json:"sessionId"`
	Timestamp string `json:"timestamp"`
	Message   struct {
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
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4<<20)
	for i := 0; i < maxScanLines && sc.Scan(); i++ {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var l transcriptLine
		if err := json.Unmarshal(line, &l); err != nil {
			continue
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
				continue
			}
			s.Messages++
			if l.Type == "user" && !titleDone {
				if txt := extractText(l.Message.Content); txt != "" {
					s.Title = truncate(txt, 80)
					titleDone = true
				}
			}
		}
	}
	if s.Title == "" {
		s.Title = strings.TrimSuffix(filepath.Base(path), ".jsonl")
	}
	return s
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

	out := Transcript{ID: id, Lines: make([]json.RawMessage, 0, 128)}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8<<20)
	total := 0
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var meta struct {
			Type        string `json:"type"`
			IsSidechain bool   `json:"isSidechain"`
			IsMeta      bool   `json:"isMeta"`
			Cwd         string `json:"cwd"`
		}
		if err := json.Unmarshal(line, &meta); err != nil {
			continue
		}
		if out.Cwd == "" && meta.Cwd != "" {
			out.Cwd = meta.Cwd
		}
		if meta.IsSidechain || meta.IsMeta {
			continue
		}
		switch meta.Type {
		case "user", "assistant", "system", "result":
		default:
			continue
		}
		// Scanner 复用底层数组，必须复制后再保留。
		copied := append(json.RawMessage(nil), line...)
		out.Lines = append(out.Lines, copied)
		total += len(copied)
		for len(out.Lines) > maxTranscriptLines || (total > maxTranscriptBytes && len(out.Lines) > 1) {
			total -= len(out.Lines[0])
			out.Lines = out.Lines[1:]
			out.Truncated = true
		}
	}
	if err := sc.Err(); err != nil {
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
