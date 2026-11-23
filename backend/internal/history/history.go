// Package history 读取 claude 的会话转录文件，供「会话列表 / 历史回放」使用。
//
// 转录文件位置（claude 自己写入，本应用只读）：
//
//	~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl
//
// 一行一个 JSON 对象。会话标题取 CLI 自己写的标题行（`custom-title` / `ai-title`），
// 没有才退回首条 user 消息的文本。
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
	"sync"
	"time"
)

// maxScanLines 是列表摘要单次扫描的行数上限（与回放上限同量级），
// maxTitleScanLines 是「取标题」只看头部多少行——标题来自 CLI 的标题行或首条用户消息，
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
	// 上下文压缩后 CLI 把摘要当一条 user 行塞回上下文（见 isCompactSummary）。
	IsCompactSummary          bool `json:"isCompactSummary"`
	IsVisibleInTranscriptOnly bool `json:"isVisibleInTranscriptOnly"`
	// CustomTitle / AiTitle 是 CLI 自己写进转录的标题行（`type: "custom-title"` /
	// `"ai-title"`）：终端 `/rename`、IDE 插件、`--name` 与它自己的自动标题都落在
	// 这里。同一份转录里可能有多行，**最后一行才是当前名字**。
	CustomTitle string `json:"customTitle"`
	AiTitle     string `json:"aiTitle"`
	Message     struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

// summaryEntry 是某份转录在上次扫描时的「身份 + 摘要」。
//
// 转录只会被追加，所以「路径 + mtime + size」不变就等于内容不变；命中时直接复用
// 摘要，不再把整份 jsonl 从头解一遍。
type summaryEntry struct {
	modTime time.Time
	size    int64
	// inode/ctime 见 `fileIdentity`：mtime+size 不足以识别「内容被整份换掉」。
	inode uint64
	ctime int64
	sess  Session
}

// summaryCache 按路径缓存列表摘要。列表接口（`GET /api/conversations` /
// `GET /api/history`）每次都把 projectsDir 下**每一份** jsonl 扫一遍（逐行 JSON
// 解码，单份上限 maxScanLines 行），在 NAS 上随对话数量与转录长度线性变贵——
// 实测 40 份 × 20000 行约 2.2s，而归档/取消归档这类操作后面就挂着一次列表重建。
// 键是绝对路径，条目在一份转录消失时随 List 一起清掉（按目录前缀 + 本次是否见到）。
var summaryCache = struct {
	mu    sync.Mutex
	m     map[string]summaryEntry
	hits  int
	scans int
}{m: map[string]summaryEntry{}}

// cachedSummary 命中复用，未命中返回 false（调用方自己 summarize）。
func cachedSummary(path string, info os.FileInfo) (Session, bool) {
	summaryCache.mu.Lock()
	defer summaryCache.mu.Unlock()
	e, ok := summaryCache.m[path]
	if !ok || !e.modTime.Equal(info.ModTime()) || e.size != info.Size() {
		return Session{}, false
	}
	// mtime+size 相同还不够：保留 mtime 的整文件替换（rsync -a / cp -p / tar -x -p）
	// 会得到一个「看起来没变」的文件，侧栏那份标题与消息数会一直是旧的。
	if inode, ctime := fileIdentity(info); e.inode != inode || e.ctime != ctime {
		return Session{}, false
	}
	summaryCache.hits++
	return e.sess, true
}

func storeSummary(path string, info os.FileInfo, sess Session) {
	summaryCache.mu.Lock()
	defer summaryCache.mu.Unlock()
	inode, ctime := fileIdentity(info)
	summaryCache.m[path] = summaryEntry{modTime: info.ModTime(), size: info.Size(), inode: inode, ctime: ctime, sess: sess}
	summaryCache.scans++
}

// pruneSummaryCache 清掉本次没见到的条目（转录被删 / 目录被改名）。
//
// 只清 dir 下的：同一进程里 List 可能被多个目录调用（测试、历史页），
// 按别的目录的扫描结果删本目录的缓存等于每次都重扫。
func pruneSummaryCache(dir string, seen map[string]bool) {
	prefix := filepath.Clean(dir) + string(filepath.Separator)
	summaryCache.mu.Lock()
	defer summaryCache.mu.Unlock()
	for p := range summaryCache.m {
		if strings.HasPrefix(p, prefix) && !seen[p] {
			delete(summaryCache.m, p)
		}
	}
}

// summaryStats 给测试用：命中与实扫次数。
func summaryStats() (hits, scans int) {
	summaryCache.mu.Lock()
	defer summaryCache.mu.Unlock()
	return summaryCache.hits, summaryCache.scans
}

// List 扫描 projectsDir 下所有转录，返回按更新时间倒序的会话摘要。
//
// 摘要按「路径 + mtime + size」缓存（见 summaryCache）：文件没变就不重扫。
func List(projectsDir string) ([]Session, error) {
	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []Session{}, nil
		}
		return nil, err
	}
	var out []Session
	seen := make(map[string]bool)
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
			// mtime/size 要在读文件**之前**取：读的过程中文件还在长（claude 正在写），
			// 取晚一步会把这个偏新的键配上不完整的内容，之后就一直返回半截摘要。
			info, statErr := f.Info()
			var s Session
			if statErr == nil {
				seen[path] = true
				if cached, ok := cachedSummary(path, info); ok {
					s = cached
				} else {
					s = summarize(path, e.Name())
					storeSummary(path, info, s)
				}
			} else {
				// 刚被删掉 / 权限变了：照旧现读一次，读不出来就是空摘要。
				s = summarize(path, e.Name())
			}
			if s.ID == "" {
				s.ID = strings.TrimSuffix(f.Name(), ".jsonl")
			}
			out = append(out, s)
		}
	}
	pruneSummaryCache(projectsDir, seen)
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
	// cliTitle 是转录里 CLI 自己写的名字（custom-title 优先于 ai-title）。
	// 它比首条用户消息更权威：用户在终端里 /rename 过之后，列表里就该叫那个名字。
	// 同一份转录可能出现多行，按出现顺序取最后一个。
	var cliCustom, cliAI string
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
		if l.CustomTitle != "" {
			cliCustom = l.CustomTitle
		}
		if l.AiTitle != "" {
			cliAI = l.AiTitle
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
			// 后台任务通知（`<task-notification>`）也是 CLI 注入的 user 行：
			// 它既不是提问，也不能当标题——否则一条以「后台命令跑完了」开头的对话
			// 在列表里会叫 `<task-notification> <task-id>…`。
			if l.Type == "user" && isTaskNotification(extractText(l.Message.Content)) {
				return true
			}
			// 附图注解（`[Image: source: …]`）同样是 CLI 加的：转录里它带 isMeta，
			// 这里根本读不到（scanTranscript 已经丢了），但**同一帧到了实时流上
			// 没有 isMeta**（实测 2.1.330）。计数与标题在这条路上是转录算的，
			// 所以这一步只是双保险；真正的修复在前端 `isImageAnnotation`。
			if l.Type == "user" && isImageAnnotation(extractText(l.Message.Content)) {
				return true
			}
			// 压缩后的续接提示同理（见 isInjectedUserRow / stripContinuation）：
			// 整条是微缩摘要就直接跳过；与用户那句话拼在一起时只留用户那半句。
			// 不挡的话压缩过一轮的对话在侧栏里会叫
			// "This session is being continued from a previous conversation…"。
			//
			// **只决定「能不能当标题」，不决定「算不算一条消息」**：`tool_result` 与
			// 只有图片/PDF 的提问 `extractText` 同样是空串，按空串就跳过会把它们从
			// 消息数里一起抹掉（实测一份真实转录从 567 掉到 372）。这里只有续接提示
			// 本身不该计数，它与上面几个 `return true` 是同一类注入行。
			userText := ""
			if l.Type == "user" {
				if isInjectedUserRow(l.IsCompactSummary, l.IsVisibleInTranscriptOnly) {
					return true
				}
				userText = stripContinuation(extractText(l.Message.Content))
			}
			s.Messages++
			if l.Type == "user" && !titleDone && lines <= maxTitleScanLines {
				if txt := userText; txt != "" {
					s.Title = truncate(txt, 80)
					titleDone = true
				}
			}
		}
		return true
	})
	if cliCustom != "" {
		// CLI 自己记下的名字（终端 /rename、IDE 插件、--name）优先：
		// 它是唯一能代表「这条对话现在叫什么」的权威来源。
		s.Title = truncate(cliCustom, 80)
	} else if cliAI != "" {
		s.Title = truncate(cliAI, 80)
	}
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

// taskNotificationRE 匹配 CLI 注入的后台任务通知。
//
// 后台命令 / 子代理结束时，CLI 会往对话里写一条**普通 user 行**（`isMeta` 是
// null，不是 true，所以绕过了 sidechain/meta 过滤）：
//
//	<task-notification>
//	<task-id>…</task-id><status>killed</status><summary>…</summary>
//	…
//	</task-notification>
//
// 它既不是用户说的话，也不该算一条消息、更不能当会话标题。前端 `lib/normalize.ts`
// 的 `isTaskNotification` 是同一条规则的镜像（两边都要改）。
//
// 只认「整条消息就是这一个块」：用户正文里顺口贴了这段 XML 时前后还有自己的文字，
// 不会命中。
var taskNotificationRE = regexp.MustCompile(`(?s)^<task-notification>\s*<task-id>[\s\S]*</task-notification>$`)

// isTaskNotification 判断一条 user 文本是否是 CLI 注入的后台任务通知。
func isTaskNotification(text string) bool {
	t := strings.TrimSpace(text)
	if !strings.HasPrefix(t, "<task-notification>") {
		return false
	}
	return taskNotificationRE.MatchString(t)
}

// imageAnnotationRE 匹配 CLI 给附图加的坐标系注解（整条消息就是注解，可能连着几个）。
//
// 用户发图 / 模型 Read 一张图时，CLI 会额外写一行
//
//	[Image: source: /tmp/…/1.png]
//	[Image: original 2748x1542, displayed at 2000x1122. Multiply coordinates by 1.37 to map to original image.]
//
// 把尺寸与换算系数告诉模型。转录里这一行带 `isMeta: true`，`scanTranscript` 已经丢掉；
// 但**实时流上的同一帧没有 isMeta**（实测 2.1.330），前端 `lib/normalize.ts` 的
// `isImageAnnotation` 是同一条规则的镜像（两边都要改）。
//
// 只认「整条消息就是这些注解」：用户自己打一句以 `[Image:` 开头的话时后面还有正事，
// 且不会恰好以注解格式收尾。
var imageAnnotationRE = regexp.MustCompile(
	`^(?:\[Image: (?:source: [^\]]+|original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by [\d.]+ to map to original image\.)\])+$`,
)

// isImageAnnotation 判断一条 user 文本是否只是 CLI 加的附图注解。
func isImageAnnotation(text string) bool {
	t := strings.TrimSpace(text)
	if !strings.HasPrefix(t, "[Image:") {
		return false
	}
	return imageAnnotationRE.MatchString(t)
}

// isInjectedUserRow 判断一条 user 行是不是上下文压缩后 CLI 塞回上下文的续接提示。
//
// 压缩完成后 CLI 把摘要写成一条 **user 行**（`isCompactSummary: true`，转录里还多一个
// `isVisibleInTranscriptOnly: true`）：它只该出现在模型上下文里，不该当成用户说的话。
// 认不出来的后果是列表里那一行的标题变成
//
//	This session is being continued from a previous conversation that ran out of…
//
// 消息数也多一格。前端 `lib/continuation.ts` 是同一条规则的镜像（两边都要改）。
func isInjectedUserRow(compactSummary, transcriptOnly bool) bool {
	return compactSummary || transcriptOnly
}

// continuationPrefix 是续接提示的固定开头（与前端 lib/continuation.ts 一致）。
const continuationPrefix = "This session is being continued from a previous conversation"

// stripContinuation 去掉「续接提示 + 用户那句话」拼在一起时前面的摘要。
//
// 压缩正好赶上用户发消息时，CLI 把两者拼成同一条 user 行的正文，这时不能整条丢掉
// （用户的提问在末尾）。认不出结尾时按整条丢弃：宁可少显示一句提问，也不要把 16KB
// 英文摘要当气泡画出来。
func stripContinuation(text string) string {
	if !strings.HasPrefix(text, continuationPrefix) {
		return text
	}
	// 三种收尾语（见前端 CONTINUATION_TRAILERS），取最靠后的那一个。
	last := -1
	for _, tail := range []string{
		"may already have happened in them.",
		"as if the break never happened.",
		"read only in the terminal session where it was written. If you need details from the earlier conversation, ask the user.",
	} {
		if i := strings.LastIndex(text, tail); i >= 0 {
			if end := i + len(tail); end > last {
				last = end
			}
		}
	}
	if last < 0 {
		return ""
	}
	return strings.TrimSpace(text[last:])
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
	// Subagents 是本次对话的子代理状态（`subagents/*.meta.json` 的摘要）。
	//
	// 主转录里**没有** `system/task_*` 行，后台子代理的结论只靠 `<task-notification>`
	// 那条 user 行；而被中断（TaskStop）的子代理**根本不写通知**——重开对话后它们
	// 就永远停在「运行中」，页头上一直转圈（踩过）。meta.json 的 `finished` 是唯一
	// 权威的收尾标记，所以随转录一起下发。
	Subagents []SubagentState `json:"subagents,omitempty"`
	// InterjectedUUIDs 是「哪些 user 行是插话」的 uuid 名单（宿主机记账）。
	//
	// 转录本身**没有任何字段能区分插话**：实测 2.1.330，`priority=now` 的消息与排队
	// 投递的消息在 jsonl 里字段完全相同（连 `queue-operation`、`turnPosition`、
	// `origin` 都一样）。所以这个事实只能在写 stdin 的那一刻、靠 CLI 的回显帧拿到
	// （见 session.KindInterjection），落到 `<session>/interjections.jsonl`，回放时取回。
	//
	// 老会话没有这份文件时为空——那时插话会被当成新一轮（宁可少认，也不要把两轮
	// 折成一整轮、把上一轮的回答藏掉）。
	InterjectedUUIDs []string `json:"interjected_uuids,omitempty"`
}

// interjectionsFile 是插话记账文件的名字，与转录同目录（`<project>/<session>/`）。
const interjectionsFile = "interjections.jsonl"

// interjectionRecord 是 interjections.jsonl 的一行。
type interjectionRecord struct {
	UUID string `json:"uuid"`
	At   string `json:"at,omitempty"`
}

// AppendInterjection 往 `<project>/<id>/interjections.jsonl` 追加一条插话记录。
//
// 由网关在收到 session.KindInterjection 时调用。**只追加、不重写**：这条链路很热
// （每条插话一次），重写整份文件没必要，而且转录本身也是追加的。
//
// 失败只返回错误、不影响会话：最坏情况是这次插话在回放时被当成新一轮。
func AppendInterjection(projectsDir, id, uuid string) error {
	if !validSessionID(id) || strings.TrimSpace(uuid) == "" {
		return nil
	}
	path, err := findTranscript(projectsDir, id)
	if err != nil {
		return err
	}
	dir := filepath.Join(filepath.Dir(path), id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(dir, interjectionsFile), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	b, _ := json.Marshal(interjectionRecord{UUID: uuid, At: time.Now().UTC().Format(time.RFC3339Nano)})
	if _, err := f.Write(append(b, '\n')); err != nil {
		return err
	}
	return nil
}

// loadInterjections 读回插话 uuid 名单；文件不存在时返回空（老会话的常态）。
func loadInterjections(projectDir, sessionID string) []string {
	f, err := os.Open(filepath.Join(projectDir, sessionID, interjectionsFile))
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []string
	seen := make(map[string]bool)
	_ = scanLines(f, 64<<10, func(line []byte) bool {
		var rec interjectionRecord
		if json.Unmarshal(line, &rec) != nil {
			return true
		}
		id := strings.TrimSpace(rec.UUID)
		if id == "" || seen[id] {
			return true
		}
		seen[id] = true
		out = append(out, id)
		return true
	})
	return out
}

// SubagentState 是子代理收尾状态的摘要，只带前端回放要用的字段。
type SubagentState struct {
	AgentID string `json:"agent_id"`
	// ToolUseID 是发起它的那次 Agent 调用——前端靠它把状态折回对应的工具卡片。
	ToolUseID   string `json:"tool_use_id,omitempty"`
	Description string `json:"description,omitempty"`
	// Finished 表示这个子代理**已经不会再产出内容了**。
	//
	// 两个来源取或：`meta.json` 的 `finished`（claude 正常收尾时写）与转录尾部
	// （见 subagentEnded）。被 TaskStop 打断的子代理**不写 finished 也不写
	// <task-notification>**，只剩转录末尾那条 `[Request interrupted by user…]`，
	// 只看 meta 会把它永远留在「运行中」（截图复现过）。
	//
	// **收尾 ≠ 成功**：真实成败要看通知里的 status，拿不到时按「已结束但原因未知」
	// 处理，不能想当然地标成完成。
	Finished bool `json:"finished"`
	// Tokens 是这个子代理**最后一次请求**的 token 总量（prompt + output，CLI 的
	// `subagent_tokens` 口径），从它自己的转录里读出来。
	//
	// 为什么要从旁路转录补：后台子代理（`run_in_background`）的用量只出现在 stdout 的
	// `system/task_notification` 里，而写进主转录的那条 `<task-notification>` **不带
	// `<usage>`**（CLI 的模板只有 task-id / tool-use-id / task-type / output-file /
	// status / summary）。重启后主转录回放拿不到它，列表上的 token 就整条丢了。
	// 子代理自己的 jsonl 一直带着 assistant 消息的 `message.usage`，同源同口径。
	Tokens int `json:"tokens,omitempty"`
	// EndedAt 是子代理转录最后一行的时刻（unix 毫秒），用来在重启后算「跑了多久」。
	//
	// 后台子代理的 tool_result 只是启动回执，拿它当结束时刻会算出 0 秒；主转录里也
	// 没有 task_* 帧。转录尾部的时刻是磁盘上唯一还留着的收尾时间。
	EndedAt int64 `json:"ended_at,omitempty"`
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
	tr, err := scanTranscript(f, id, false)
	if err != nil {
		return Transcript{}, err
	}
	tr.Subagents = subagentStates(filepath.Dir(path), id)
	tr.InterjectedUUIDs = loadInterjections(filepath.Dir(path), id)
	return tr, nil
}

// subagentStates 读 <project>/<session>/subagents/ 下每个子代理的收尾状态。
//
// 以**转录文件**为准枚举（`agent-<id>.jsonl`），meta.json 只用来补 tool_use_id /
// 描述 / `finished`。只按 meta 枚举会漏掉没写出 meta 的那些：meta 是 claude 收尾时
// 才补全的，进程被杀、会话被回收、TaskStop 打断都可能只留下 jsonl——它们恰恰是最
// 需要「已结束」判定的（前端本来还挂在 running 上）。
//
// best-effort：目录不存在、单个文件坏掉都只跳过那一条，不能让整份转录读不出来。
func subagentStates(projectDir, sessionID string) []SubagentState {
	dir := filepath.Join(projectDir, sessionID, "subagents")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	out := make([]SubagentState, 0, len(entries))
	seen := make(map[string]bool, len(entries))
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasPrefix(name, "agent-") || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		agentID := strings.TrimSuffix(strings.TrimPrefix(name, "agent-"), ".jsonl")
		if !validAgentID(agentID) || seen[agentID] {
			continue
		}
		seen[agentID] = true
		var m SubagentMeta
		// meta 可能不存在或写了一半：读不到时结构体是零值，仍按转录判收尾。
		if b, err := os.ReadFile(filepath.Join(dir, "agent-"+agentID+".meta.json")); err == nil {
			_ = json.Unmarshal(b, &m)
		}
		path := filepath.Join(dir, name)
		tokens, endedAt := subagentTailStats(path)
		out = append(out, SubagentState{
			AgentID:     agentID,
			ToolUseID:   m.ToolUseID,
			Description: m.Description,
			Finished:    m.Finished || subagentEnded(path),
			Tokens:      tokens,
			EndedAt:     endedAt,
		})
	}
	return out
}

// subagentTailStats 从子代理转录的尾部读两样东西：用量与收尾时刻。
//
//   - tokens：**最后一条带 usage 的 assistant 消息**的 `input + cache_creation +
//     cache_read + output`。这就是 CLI 的 `subagent_tokens` 口径（它取「最后一次请求」，
//     不是累加），所以与结束通知里的数字同源。
//   - endedAt：最后一条能解析出 `timestamp` 的行的时刻（unix 毫秒）。
//
// 只读文件尾部（64KB），几百 KB 的子代理转录不会整份进内存；被截断的半行直接丢掉。
// 任何一步失败都返回零值——调用方只在拿得到时补，不能因此读不出整份转录。
func subagentTailStats(path string) (tokens int, endedAt int64) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	const tailBytes = 64 << 10
	st, err := f.Stat()
	if err != nil {
		return 0, 0
	}
	offset := st.Size() - tailBytes
	if offset < 0 {
		offset = 0
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return 0, 0
	}
	buf, err := io.ReadAll(f)
	if err != nil {
		return 0, 0
	}
	// 从文件中间开始时，第一行多半是半截 JSON。
	if offset > 0 {
		if i := bytes.IndexByte(buf, '\n'); i >= 0 {
			buf = buf[i+1:]
		}
	}
	for _, line := range bytes.Split(buf, []byte("\n")) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var rec struct {
			Type      string `json:"type"`
			Timestamp string `json:"timestamp"`
			Message   struct {
				Usage *struct {
					Input       int `json:"input_tokens"`
					CacheCreate int `json:"cache_creation_input_tokens"`
					CacheRead   int `json:"cache_read_input_tokens"`
					Output      int `json:"output_tokens"`
				} `json:"usage"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &rec) != nil {
			continue
		}
		if ts, err := time.Parse(time.RFC3339Nano, rec.Timestamp); err == nil {
			endedAt = ts.UnixMilli()
		}
		if rec.Type != "assistant" || rec.Message.Usage == nil {
			continue
		}
		u := rec.Message.Usage
		// output 为 0 的是流式中间态/工具预填充，不是一次完成的请求。
		if u.Output <= 0 {
			continue
		}
		tokens = u.Input + u.CacheCreate + u.CacheRead + u.Output
	}
	return tokens, endedAt
}

// subagentEnded 判断一个子代理的转录是否已经收尾。
//
// `meta.json` 的 `finished` **不是唯一信号**：子代理被 TaskStop 打断时，claude
// 既不写 `finished`、也不写 `<task-notification>`，只在转录末尾留一条合成的
// `[Request interrupted by user]` / `… for tool use`。只看 meta 的话，这些被中断
// 的子代理重开对话后会永远停在「运行中」（实测复现）。
//
// 判据取「最后一条 user/assistant 行」：中断标记 → 收尾；assistant 的
// `stop_reason` 非空（`end_turn` / `tool_use` 之外的真收尾）→ 收尾。
// 只读文件尾部一段，不把整份子代理转录（可能几百 KB）读进内存。
func subagentEnded(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	const tailBytes = 64 << 10
	st, err := f.Stat()
	if err != nil {
		return false
	}
	offset := st.Size() - tailBytes
	if offset < 0 {
		offset = 0
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return false
	}
	buf, err := io.ReadAll(f)
	if err != nil {
		return false
	}
	lines := strings.Split(string(buf), "\n")
	// 从后往前找第一条真正的内容行（sidechain 文件里也有 queue-operation 之类）。
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		// offset>0 时第一条可能是被截断的半行，解析失败就跳过。
		var rec struct {
			Type    string `json:"type"`
			Message struct {
				Content    json.RawMessage `json:"content"`
				StopReason string          `json:"stop_reason"`
			} `json:"message"`
		}
		if json.Unmarshal([]byte(line), &rec) != nil {
			continue
		}
		switch rec.Type {
		case "assistant":
			return rec.Message.StopReason == "end_turn"
		case "user":
			return isInterruptMarker(extractText(rec.Message.Content))
		}
	}
	return false
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
			// 压缩后的续接提示（一条 16KB 的 user 行）不参与回放：前端有同一条过滤，
			// 但先在这里丢掉能省下每次压缩 16KB 的传输与解析。
			IsCompactSummary          bool `json:"isCompactSummary"`
			IsVisibleInTranscriptOnly bool `json:"isVisibleInTranscriptOnly"`
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
		if meta.Type == "user" && isInjectedUserRow(meta.IsCompactSummary, meta.IsVisibleInTranscriptOnly) {
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
