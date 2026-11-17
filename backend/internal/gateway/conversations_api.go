package gateway

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
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
		}
	}

	// 3) 当前存活会话：空对话（还没有转录）也要出现在列表里。
	for _, info := range s.d.Manager.List() {
		if deleted[info.ID] {
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
	// usage 先校验并落盘：它可能因为超长/非法 JSON 返回 400，而标题与归档的写盘
	// 是不回滚的 —— 把校验放在最前面，失败时文件里什么都没变。
	if len(req.Usage) > 0 {
		if err := s.d.Conversations.SetUsage(req.ID, req.Usage); err != nil {
			writeErr(w, err.Error(), http.StatusBadRequest)
			return
		}
	}
	if req.Title != nil {
		title := strings.Join(strings.Fields(*req.Title), " ")
		if len([]rune(title)) > 120 {
			writeErr(w, "标题过长（最多 120 字）", http.StatusBadRequest)
			return
		}
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
	writeJSON(w, map[string]any{"ok": true})
}

type forkConversationReq struct {
	ID    string `json:"id"`
	Title string `json:"title,omitempty"`
}

// forkTranscriptWait 是 fork 之后等转录落盘的上限。测试会调小/置零。
var forkTranscriptWait = 1500 * time.Millisecond

// waitTranscript 短暂等 fork 出来的转录出现：前端拿到 id 后立刻会回放它，
// 早于文件出现会先闪一下空对话。等不到也照常返回——CLI 稍后自己会写完。
func (s *Server) waitTranscript(id string) {
	deadline := time.Now().Add(forkTranscriptWait)
	for {
		if history.TranscriptExists(s.d.HistoryDir, id) {
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
	if title := strings.TrimSpace(req.Title); title != "" {
		_ = s.d.Conversations.Rename(info.ID, title)
	}
	s.waitTranscript(info.ID)
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
func (s *Server) touchConversation(info manager.Info) {
	if s.d.Conversations == nil || info.ID == "" {
		return
	}
	if err := s.d.Conversations.Touch(info.ID, info.Cwd); err != nil {
		return
	}
	_ = s.d.Conversations.UpdateMeta(info.ID, info.Provider, info.Model, info.Effort)
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
