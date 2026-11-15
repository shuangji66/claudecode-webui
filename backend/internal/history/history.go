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
	"os"
	"path/filepath"
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

func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
