package gateway

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"ccweb/backend/internal/agent/manager"
	"ccweb/backend/internal/conversation"
	"ccweb/backend/internal/history"
)

// conversationEntry 是侧栏对话列表的一行：history（转录） + 应用元数据 + 实时会话。
type conversationEntry struct {
	ID         string    `json:"id"`
	Cwd        string    `json:"cwd"`
	Title      string    `json:"title"`
	CreatedAt  time.Time `json:"created_at"`
	LastActive time.Time `json:"last_active"`
	Messages   int       `json:"messages"`
	Archived   bool      `json:"archived"`
	// Pinned 只是侧栏排序偏好：前端把置顶的排在同组最前，后端不替它排序。
	Pinned   bool   `json:"pinned"`
	Live     bool   `json:"live"`
	State    string `json:"state,omitempty"`
	Provider string `json:"provider,omitempty"`
	Model    string `json:"model,omitempty"`
	Effort   string `json:"effort,omitempty"`
	// Usage 是前端存的用量快照（上下文 / 缓存命中 / tok/s），重开对话时用来还原底部统计。
	Usage json.RawMessage `json:"usage,omitempty"`
}

// handleListConversations 合并 claude 转录、应用元数据和当前存活会话。
//
// 这是左侧栏的唯一数据源：即使后端重启、所有进程都没了，转录与元数据仍然
// 能列出历史对话；live/state 只是附加信息。
func (s *Server) handleListConversations(w http.ResponseWriter, r *http.Request) {
	byID := make(map[string]*conversationEntry)
	deleted := make(map[string]bool)
	// superseded 是「被 /clear 取代的旧历史」：记录还在（历史记录里能翻到），
	// 但侧栏不列——旧转录仍在磁盘上，不挡的话会与清空后的那条并列出现。
	superseded := make(map[string]bool)
	// withTranscript 记住哪些 id 是 claude 真的写过转录的（第 1 步扫出来的）。
	withTranscript := make(map[string]bool)
	ensure := func(id string) *conversationEntry {
		if e, ok := byID[id]; ok {
			return e
		}
		e := &conversationEntry{ID: id}
		byID[id] = e
		return e
	}

	// 1) claude 转录：标题、消息数、最后更新时间。
	if hist, err := history.List(s.d.HistoryDir); err == nil {
		for _, h := range hist {
			e := ensure(h.ID)
			e.Cwd = h.Cwd
			e.Title = h.Title
			e.Messages = h.Messages
			e.CreatedAt = h.UpdatedAt
			e.LastActive = h.UpdatedAt
			withTranscript[h.ID] = true
		}
	}

	// 2) 应用元数据：自定义标题、归档/删除、最近打开时间、模型信息。
	if s.d.Conversations != nil {
		for _, rec := range s.d.Conversations.List() {
			e := ensure(rec.ID)
			if e.Cwd == "" {
				e.Cwd = rec.Cwd
			}
			if rec.Title != "" {
				e.Title = rec.Title
			}
			if rec.CreatedAt.After(e.CreatedAt) || e.CreatedAt.IsZero() {
				e.CreatedAt = rec.CreatedAt
			}
			if rec.LastActive.After(e.LastActive) {
				e.LastActive = rec.LastActive
			}
			e.Archived = rec.Archived
			e.Pinned = rec.Pinned
			e.Provider = rec.Provider
			e.Model = rec.Model
			e.Effort = rec.Effort
			e.Usage = rec.Usage
			if rec.Deleted {
				deleted[rec.ID] = true
				delete(byID, rec.ID)
			}
			// 被 `/clear` 取代的旧历史：记录留着（历史记录里还能翻到），但不再
			// 出现在侧栏。不留这一步的话，旧转录仍在磁盘上、标题也还在，第 1 步
			// 扫转录会把「清空前」那条重新列出来，侧栏同时出现两条。
			if rec.SupersededBy != "" {
				superseded[rec.ID] = true
				delete(byID, rec.ID)
			}
		}
	}

	// 3) 当前存活会话：空对话（还没有转录）也要出现在列表里。
	for _, info := range s.d.Manager.List() {
		if deleted[info.ID] || superseded[info.ID] {
			continue
		}
		e := ensure(info.ID)
		if e.Cwd == "" {
			e.Cwd = info.Cwd
		}
		e.Live = true
		e.State = info.State
		if info.Provider != "" {
			e.Provider = info.Provider
		}
		if info.Model != "" {
			e.Model = info.Model
		}
		if info.Effort != "" {
			e.Effort = info.Effort
		}
		if info.LastActive.After(e.LastActive) {
			e.LastActive = info.LastActive
		}
		if e.CreatedAt.IsZero() {
			e.CreatedAt = info.CreatedAt
		}
	}

	out := make([]conversationEntry, 0, len(byID))
	for _, e := range byID {
		// 4) 不展示「幽灵条目」：既没有转录、也没有标题、还没有活进程的空对话，
		// 又没有任何用户状态（置顶/归档都算用户动过它）。
		// 这类条目是历史上 resume 时 touch 出来的（空对话没有 jsonl），永远
		// --resume 不起来——留在侧栏里就是点一次报一次「No conversation found」。
		// 只是不展示：记录本身还在，真写了转录或改了名就会自己回来。
		if !e.Live && !withTranscript[e.ID] && e.Messages == 0 &&
			strings.TrimSpace(e.Title) == "" && !e.Pinned && !e.Archived {
			continue
		}
		if e.CreatedAt.IsZero() {
			e.CreatedAt = e.LastActive
		}
		if e.LastActive.IsZero() {
			e.LastActive = e.CreatedAt
		}
		out = append(out, *e)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].LastActive.Equal(out[j].LastActive) {
			return out[i].LastActive.After(out[j].LastActive)
		}
		return out[i].ID < out[j].ID
	})
	writeJSON(w, map[string]any{"conversations": out})
}

// maxTitleRunes 是对话标题的长度上限（按字符算，不是字节）。
const maxTitleRunes = 120

// normalizeTitle 折叠空白并校验长度；超长由调用方转成 400。
//
// 重命名（PATCH）与分叉（fork）共用：分叉的标题是前端拼的「原名（分叉）」，
// 不校验的话它就成了一条绕过 120 字上限的后门。
func normalizeTitle(raw string) (string, error) {
	title := strings.Join(strings.Fields(raw), " ")
	if len([]rune(title)) > maxTitleRunes {
		return "", fmt.Errorf("标题过长（最多 %d 字）", maxTitleRunes)
	}
	return title, nil
}

type patchConversationReq struct {
	ID       string  `json:"id"`
	Title    *string `json:"title,omitempty"`
	Archived *bool   `json:"archived,omitempty"`
	Pinned   *bool   `json:"pinned,omitempty"`
	Touch    bool    `json:"touch,omitempty"`
	// Usage 是前端算好的用量快照；给了就存，不影响其它字段。
	Usage json.RawMessage `json:"usage,omitempty"`
}

// handlePatchConversation 处理重命名 / 归档 / 打开时刷新最近活跃。
func (s *Server) handlePatchConversation(w http.ResponseWriter, r *http.Request) {
	if s.d.Conversations == nil {
		writeErr(w, "对话存储未启用", http.StatusServiceUnavailable)
		return
	}
	var req patchConversationReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	req.ID = strings.TrimSpace(req.ID)
	if req.ID == "" {
		writeErr(w, "missing id", http.StatusBadRequest)
		return
	}
	rec, ok := s.ensureConversation(req.ID)
	if !ok {
		writeErr(w, "对话不存在", http.StatusNotFound)
		return
	}
	// 标题与 usage 的校验都放在写盘之前：两者的写盘都不回滚，任何一处失败都
	// 不该留下「标题改了、usage 没存」这样的半截修改。
	title := ""
	if req.Title != nil {
		var err error
		if title, err = normalizeTitle(*req.Title); err != nil {
			writeErr(w, err.Error(), http.StatusBadRequest)
			return
		}
	}
	if len(req.Usage) > 0 {
		if err := s.d.Conversations.SetUsage(req.ID, req.Usage); err != nil {
			writeErr(w, err.Error(), http.StatusBadRequest)
			return
		}
	}
	if req.Title != nil {
		if err := s.d.Conversations.Rename(req.ID, title); err != nil {
			writeErr(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	if req.Archived != nil {
		if err := s.d.Conversations.SetArchived(req.ID, *req.Archived); err != nil {
			writeErr(w, err.Error(), http.StatusInternalServerError)
			return
		}
		// 归档等价于「从当前视图收起」：顺手结束进程，避免它在后台继续占内存。
		if *req.Archived {
			_ = s.d.Manager.Close(req.ID)
		}
	}
	// 置顶：纯列表偏好，不结束进程、不动归档状态。
	if req.Pinned != nil {
		if err := s.d.Conversations.SetPinned(req.ID, *req.Pinned); err != nil {
			writeErr(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	if req.Touch {
		if err := s.d.Conversations.Touch(req.ID, rec.Cwd); err != nil {
			writeErr(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	// 标题 / 置顶 / 归档都会改变别人侧栏里那一行的样子（甚至它属于哪个分组），
	// 别的设备要跟着刷新一次。
	//
	// **usage 与 touch 不推**：usage 只是重开对话时还原底部统计的快照（每回合一次），
	// touch 只改 last_active（每次切换对话都会发生）——两者都不改列表里那一行的内容，
	// 而每次推送都让所有连接重扫一遍全部转录。排序偏差由各自的本地刷新兜着。
	listVisible := req.Title != nil || req.Archived != nil || req.Pinned != nil
	writeJSON(w, map[string]any{"ok": true})
	if listVisible {
		s.BroadcastConversationsChanged()
	}
}

type forkConversationReq struct {
	ID    string `json:"id"`
	Title string `json:"title,omitempty"`
}

// forkTranscriptWait 是 fork 之后等转录落盘的上限。测试会调小/置零。
var forkTranscriptWait = 1500 * time.Millisecond

// waitForkTranscript 短暂等 fork 出来的转录出现：前端拿到 id 后立刻会回放它，
// 早于文件出现会先闪一下空对话。等不到也照常返回——CLI 稍后自己会写完。
//
// 只盯旧转录旁边那一个文件名：fork 的 cwd 与原会话相同，claude 把它们写在同一个
// project 目录下；以前每 50ms 重扫整个 projects 树（每个 project 一次 stat），
// 在这台 NAS 上等于给一个 HTTP 请求陪跑几十次目录遍历。
func (s *Server) waitForkTranscript(oldID, newID string) {
	old, err := history.TranscriptPath(s.d.HistoryDir, oldID)
	if err != nil {
		return
	}
	dest := filepath.Join(filepath.Dir(old), newID+".jsonl")
	deadline := time.Now().Add(forkTranscriptWait)
	for {
		if st, err := os.Stat(dest); err == nil && !st.IsDir() {
			return
		}
		if !time.Now().Before(deadline) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// handleForkConversation 从一条对话复制出一个新会话（对齐 DSH 的「分叉会话」）。
//
// 落点必须是**我们生成的新 UUID**：`--resume 旧 --fork-session --session-id 新`
// （2.1.326 实测可用），这样转录文件名、conversations.json、前端 activeId 仍然同源，
// 不需要「收养 CLI 自造 id」那一层。原会话完全不受影响；fork 出去的是独立进程，
// session 级授权不会继承（用户重新审批）。fork 读的是原转录的当前内容，
// 原会话正在跑时结尾可能少最新一两条。
func (s *Server) handleForkConversation(w http.ResponseWriter, r *http.Request) {
	if s.d.Conversations == nil {
		writeErr(w, "对话存储未启用", http.StatusServiceUnavailable)
		return
	}
	var req forkConversationReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	req.ID = strings.TrimSpace(req.ID)
	if req.ID == "" {
		writeErr(w, "missing id", http.StatusBadRequest)
		return
	}
	// 标题先校验再动手：fork 之后才发现超长，就只剩两种坏选择——回 400 骗人
	// （新对话其实已经建好并起了进程），或者把超长标题写进元数据。
	title := ""
	if strings.TrimSpace(req.Title) != "" {
		var err error
		if title, err = normalizeTitle(req.Title); err != nil {
			writeErr(w, err.Error(), http.StatusBadRequest)
			return
		}
	}
	rec, ok := s.ensureConversation(req.ID)
	if !ok {
		writeErr(w, "对话不存在", http.StatusNotFound)
		return
	}
	if rec.Deleted {
		writeErr(w, "该对话已删除，无法分叉", http.StatusConflict)
		return
	}
	if rec.Cwd == "" {
		writeErr(w, "这条对话没有工作目录，无法分叉", http.StatusBadRequest)
		return
	}
	// 没有转录就没有可复制的东西：`--resume` 找不到会话时 CLI 会直接退出，
	// 而我们那时已经落下一条永远 resume 不了的元数据（AGENTS 里的「幽灵对话」）。
	// 挡在起进程之前，错误信息也才说得清。
	if !history.TranscriptExists(s.d.HistoryDir, req.ID) {
		writeErr(w, "这条对话还没有任何消息，无法分叉", http.StatusBadRequest)
		return
	}
	// 工作区可能已经被移除：fork 会在这里真起一个 claude 进程，必须和新建会话走同一道门
	// （含软链解析，否则软链目录能绕过 `/api/session` 的围栏）。
	if err := s.ensureCwdAuthorizedReal(rec.Cwd); err != nil {
		writeErr(w, err.Error(), http.StatusForbidden)
		return
	}
	info, err := s.d.Manager.Fork(req.ID, rec.Cwd, rec.Model, "")
	if err != nil {
		// 版本太旧不认识 --fork-session：这是用户可修的事（去部署页升级），别报 500。
		if errors.Is(err, manager.ErrForkUnsupported) {
			writeErr(w, err.Error(), http.StatusBadRequest)
			return
		}
		// 和 POST /api/session 一样：会话上限、进程起不来都是「当前状态冲突」，
		// 不是内部错误——报 500 只会让前端弹「服务器内部错误」，看不出该关几个空闲会话。
		writeErr(w, err.Error(), http.StatusConflict)
		return
	}
	// 先落元数据再等转录：列表接口靠它让新对话立刻出现（转录可能还没写完）。
	_ = s.d.Conversations.Touch(info.ID, rec.Cwd)
	_ = s.d.Conversations.UpdateMeta(info.ID, info.Provider, info.Model, info.Effort)
	if title != "" {
		_ = s.d.Conversations.Rename(info.ID, title)
	}
	s.waitForkTranscript(req.ID, info.ID)
	// 新对话已经能列出来了：别的设备也要看到这一行（它此刻还没有转录，
	// 靠 Touch 落下的元数据 + live 会话进列表）。
	s.BroadcastConversationsChanged()
	writeJSON(w, map[string]any{"ok": true, "id": info.ID, "cwd": rec.Cwd})
}

// handleDeleteConversation 软删除对话（写墓碑，保留转录文件）。
func (s *Server) handleDeleteConversation(w http.ResponseWriter, r *http.Request) {
	if s.d.Conversations == nil {
		writeErr(w, "对话存储未启用", http.StatusServiceUnavailable)
		return
	}
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		writeErr(w, "missing id", http.StatusBadRequest)
		return
	}
	if _, ok := s.ensureConversation(id); !ok {
		writeErr(w, "对话不存在", http.StatusNotFound)
		return
	}
	if err := s.d.Conversations.Delete(id); err != nil {
		writeErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = s.d.Manager.Close(id)
	// 删除是软删除，但列表里那一行必须立刻消失（别的设备不知道用户刚删了它）。
	s.BroadcastConversationsChanged()
	writeJSON(w, map[string]any{"ok": true})
}

// ensureConversation 把历史转录或存活会话收养进应用元数据。
func (s *Server) ensureConversation(id string) (conversation.Record, bool) {
	if s.d.Conversations == nil {
		return conversation.Record{}, false
	}
	if rec, ok := s.d.Conversations.Get(id); ok {
		return rec, true
	}
	if hist, err := history.List(s.d.HistoryDir); err == nil {
		for _, h := range hist {
			if h.ID != id {
				continue
			}
			rec := conversation.Record{
				ID:         id,
				Cwd:        h.Cwd,
				Title:      h.Title,
				CreatedAt:  h.UpdatedAt,
				LastActive: h.UpdatedAt,
			}
			if err := s.d.Conversations.Ensure(rec); err != nil {
				return conversation.Record{}, false
			}
			return rec, true
		}
	}
	for _, info := range s.d.Manager.List() {
		if info.ID != id {
			continue
		}
		rec := conversation.Record{
			ID:         id,
			Cwd:        info.Cwd,
			CreatedAt:  info.CreatedAt,
			LastActive: info.LastActive,
			Provider:   info.Provider,
			Model:      info.Model,
			Effort:     info.Effort,
		}
		if err := s.d.Conversations.Ensure(rec); err != nil {
			return conversation.Record{}, false
		}
		return rec, true
	}
	return conversation.Record{}, false
}

// touchConversation 记录一次打开/发送：创建元数据（如果还没有）并刷新时间。
//
// 返回值报告「这次调用新建了元数据」，也就是这条对话第一次进入列表：调用方据此
// 决定要不要通知其它设备（见 ws.go 的 prompt 分支）。已有记录的对话每次发消息
// 都只改 last_active——为它广播等于让每个连接的每个回合都去重扫一遍全部转录。
func (s *Server) touchConversation(info manager.Info) (created bool) {
	if s.d.Conversations == nil || info.ID == "" {
		return false
	}
	_, existed := s.d.Conversations.Get(info.ID)
	if err := s.d.Conversations.Touch(info.ID, info.Cwd); err != nil {
		return false
	}
	_ = s.d.Conversations.UpdateMeta(info.ID, info.Provider, info.Model, info.Effort)
	return !existed
}

// conversationInfo 从 manager 的列表里取一个会话（touch 用）。
func (s *Server) conversationInfo(id string) (manager.Info, bool) {
	for _, info := range s.d.Manager.List() {
		if info.ID == id {
			return info, true
		}
	}
	return manager.Info{}, false
}

// handleHistoryPreview 返回会话的最近几句，供侧栏悬浮预览。
//
// 只读转录尾部，不进列表接口：列表要快，预览是按需的。
func (s *Server) handleHistoryPreview(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		writeErr(w, "missing id", http.StatusBadRequest)
		return
	}
	preview, err := history.LoadPreview(s.d.HistoryDir, id)
	if err != nil {
		if errors.Is(err, history.ErrTranscriptNotFound) {
			writeErr(w, err.Error(), http.StatusNotFound)
			return
		}
		writeErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, preview)
}

// handleHistoryExport 把一次会话的原始日志打包成 zip 下载。
//
// 内容是 claude 自己写的文件（主转录 + 子代理转录 + meta），原样打包不解析：
// 用户要的是「原始日志」，能拿去别处复盘。
func (s *Server) handleHistoryExport(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		writeErr(w, "missing id", http.StatusBadRequest)
		return
	}
	// 先判存在再写响应头：否则 404 会变成「下载了一个坏 zip」。
	if !history.SessionLogExists(s.d.HistoryDir, id) {
		writeErr(w, history.ErrTranscriptNotFound.Error(), http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", "claude-session-"+id+".zip"))
	w.Header().Set("Cache-Control", "no-store")
	if err := history.WriteSessionZip(w, s.d.HistoryDir, id); err != nil {
		// 响应头已经发出去了，只能记日志；前端会拿到一个不完整的 zip。
		s.log.Printf("history: 导出会话 %s 失败: %v", id, err)
	}
}

// handleHistoryTranscript 返回一次对话的原始事件行，前端用与实时流相同的
// normalize 逻辑回放。id 只允许 UUID 字符，不能拼路径。
func (s *Server) handleHistoryTranscript(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		writeErr(w, "missing id", http.StatusBadRequest)
		return
	}
	tr, err := history.LoadTranscript(s.d.HistoryDir, id)
	if err != nil {
		if errors.Is(err, history.ErrTranscriptNotFound) {
			writeErr(w, err.Error(), http.StatusNotFound)
			return
		}
		writeErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, tr)
}
