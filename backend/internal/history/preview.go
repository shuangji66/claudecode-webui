package history

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
)

// 预览只读转录尾部这么多字节：文件可能几 MB，但悬浮预览只要最后几句。
const previewTailBytes = 64 << 10

// 预览文本上限（按 rune 计）。
const (
	previewUserMax      = 160
	previewAssistantMax = 240
)

// Preview 是一条会话的最近几句，用于侧栏悬浮预览。
type Preview struct {
	User      string `json:"user,omitempty"`
	Assistant string `json:"assistant,omitempty"`
}

// LoadPreview 从转录尾部读最近一条用户消息与最后一条 assistant 回复。
//
// 只读尾部 64KB：预览不需要全量解析，大转录也能秒回。从中间切开的首行
// 解析失败会被跳过；sidechain / meta 行（子代理与系统提醒）不算数。
func LoadPreview(projectsDir, id string) (Preview, error) {
	if !validSessionID(id) {
		return Preview{}, ErrTranscriptNotFound
	}
	path, err := findTranscript(projectsDir, id)
	if err != nil {
		return Preview{}, err
	}
	f, err := os.Open(path)
	if err != nil {
		return Preview{}, err
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		return Preview{}, err
	}
	var offset int64
	if st.Size() > previewTailBytes {
		offset = st.Size() - previewTailBytes
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return Preview{}, err
	}
	buf, err := io.ReadAll(f)
	if err != nil {
		return Preview{}, err
	}

	lines := bytes.Split(buf, []byte("\n"))
	if offset > 0 && len(lines) > 0 {
		lines = lines[1:] // 首行是从中间切开的，丢掉
	}
	var out Preview
	for _, line := range lines {
		if len(line) == 0 {
			continue
		}
		var l previewLine
		if err := json.Unmarshal(line, &l); err != nil {
			continue
		}
		if l.IsSidechain || l.IsMeta {
			continue
		}
		if l.Type == "user" && isInjectedUserRow(l.IsCompactSummary, l.IsVisibleInTranscriptOnly) {
			continue
		}
		switch l.Type {
		case "user":
			// 压缩续接提示与用户那句话拼在一起时只要后半截（见 history.stripContinuation）。
			text := stripContinuation(extractText(l.Message.Content))
			// 中断标记也是 CLI 写的合成 user 行，不是用户说的话。
			if text == "" || isLocalCommandEcho(text) || isInterruptMarker(text) {
				continue
			}
			out.User = truncate(text, previewUserMax)
		case "assistant":
			text := extractText(l.Message.Content)
			if text == "" {
				continue
			}
			out.Assistant = truncate(text, previewAssistantMax)
		}
	}
	return out, nil
}

// previewLine 只解析预览需要的字段。
type previewLine struct {
	Type                      string `json:"type"`
	IsSidechain               bool   `json:"isSidechain"`
	IsMeta                    bool   `json:"isMeta"`
	IsCompactSummary          bool   `json:"isCompactSummary"`
	IsVisibleInTranscriptOnly bool   `json:"isVisibleInTranscriptOnly"`
	Message                   struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}
