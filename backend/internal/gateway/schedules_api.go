// 自动化任务：HTTP 接口 + 真正的投递实现。
//
// 调度规则、存储、循环都在 internal/schedule；这一层负责两件只有网关能做的事：
//   - REST：列表 / 创建 / 修改 / 暂停恢复 / 立即执行 / 删除 / 运行记录；
//   - 投递：按任务的 Target 决定投进哪个对话（必要时新建），校验工作区围栏，
//     起会话（已在跑就复用）并把指令写进 stdin。
package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"ccweb/backend/internal/agent/manager"
	"ccweb/backend/internal/agent/session"
	"ccweb/backend/internal/conversation"
	"ccweb/backend/internal/mcp"
	"ccweb/backend/internal/project"
	"ccweb/backend/internal/schedule"
)

// mcpScheduleServer 是写进 claude 的 mcpServers 的键名。
const mcpScheduleServer = "ccweb-schedule"

// ScheduleMCPServer 是对外暴露的服务名（装配层用它判断「自动化任务工具是否已注册」）。
const ScheduleMCPServer = mcpScheduleServer

// builtinUserMcpServers 是本应用自己注册、由启动流程维护的用户级 MCP 服务。
//
// 它们的配置由 EnsureScheduleMCP 在每次启动时写回，所以「删除」是一件自相矛盾的事：
// 接口上删掉之后模型立刻看不到那三个工具，下次启动又被原样写回来。
// 界面不给删除按钮，DELETE /api/mcp 也拒绝（理由见 mcp_api.go）。
// 只收自动化任务这一条：内置搜索的「解除」本来就要靠删配置（search_api.go 的 Detach）。
var builtinUserMcpServers = map[string]bool{mcpScheduleServer: true}

// isBuiltinMcp 报告某条服务是否由 ccweb 自己维护（只有用户级的这几条）。
func isBuiltinMcp(scope, name string) bool {
	return scope == mcp.ScopeUser && builtinUserMcpServers[name]
}

// 自动化任务的三个模型工具（`ccweb mcp-schedule` 暴露）。
var scheduleAllowedTools = []string{
	"mcp__" + mcpScheduleServer + "__schedule_create",
	"mcp__" + mcpScheduleServer + "__schedule_list",
	"mcp__" + mcpScheduleServer + "__schedule_edit",
}

// ScheduleToolRules 返回注册后该预先放行的工具名。
//
// 和内置搜索同一个理由：MCP 工具默认要过 can_use_tool，每建一条提醒弹一次审批，
// 模型很快就学会不碰它。它们只写数据目录下的 schedules.json，不碰工作区。
func ScheduleToolRules() []string { return scheduleAllowedTools }

// EnsureScheduleMCP 把 `ccweb mcp-schedule` 注册成用户级 MCP 服务（幂等）。
//
// 这样「帮我每天早上 9 点提醒我」在对话框里就能落地，不用先让用户去设置页点开关。
// 已经是同一份配置时直接跳过，避免每次启动都重写 .claude.json（那是 claude 自己的
// 状态文件，写一次就多一次风险）。
func (s *Server) EnsureScheduleMCP() error {
	if s.d.Mcp == nil {
		return nil
	}
	exe := selfPath()
	if exe == "" {
		return errors.New("无法确定 ccweb 可执行文件路径")
	}
	env := map[string]string{"CCWEB_DATA_DIR": s.d.Cfg.DataDir}
	if s.d.Cfg.SchedulesFile != "" {
		env["CCWEB_SCHEDULES_FILE"] = s.d.Cfg.SchedulesFile
	}
	want := mcp.Server{
		Name:    mcpScheduleServer,
		Scope:   mcp.ScopeUser,
		Type:    mcp.TypeStdio,
		Command: exe,
		Args:    []string{"mcp-schedule"},
		Env:     env,
		// 与内置搜索同一处理：延迟加载只把裸名字发给模型，模型认不出这是「建提醒」。
		AlwaysLoad: true,
	}
	if cur, err := s.d.Mcp.Find("", mcp.ScopeUser, mcpScheduleServer); err == nil {
		if cur.Command == want.Command && sameStrings(cur.Args, want.Args) && sameEnv(cur.Env, want.Env) {
			return nil
		}
	}
	_, err := s.d.Mcp.Save("", want)
	return err
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func sameEnv(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

// 任务字段上限：和 DSH 的编辑器同量级，太长的指令塞进对话只会挤占上下文。
const (
	maxScheduleName   = 120
	maxSchedulePrompt = 4000
)

// SetScheduleRunner 接上调度循环（装配层创建后调用）。
//
// runner 只用于「立即执行」：常规投递由它自己的循环驱动，网关不主动 tick。
func (s *Server) SetScheduleRunner(r *schedule.Runner) { s.runner = r }

// scheduleReq 是创建/修改任务的请求体。
type scheduleReq struct {
	ID                string          `json:"id"`
	Name              string          `json:"name"`
	Prompt            string          `json:"prompt"`
	Target            schedule.Target `json:"target"`
	Workspace         string          `json:"workspace"`
	Rule              schedule.Rule   `json:"rule"`
	ExpectedUpdatedAt string          `json:"expected_updated_at,omitempty"`
}

func (s *Server) handleListSchedules(w http.ResponseWriter, _ *http.Request) {
	if s.d.Schedules == nil {
		writeErr(w, "自动化任务未启用", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, map[string]any{
		"tasks": s.d.Schedules.List(),
		"limits": map[string]any{
			"min_gap_seconds": int(schedule.MinDeliveryGap / time.Second),
			"max_deliveries":  schedule.MaxDeliveries,
		},
	})
}

func (s *Server) handleCreateSchedule(w http.ResponseWriter, r *http.Request) {
	if s.d.Schedules == nil {
		writeErr(w, "自动化任务未启用", http.StatusServiceUnavailable)
		return
	}
	var req scheduleReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	task, code, err := s.buildSchedule(req, nil)
	if err != nil {
		writeErr(w, err.Error(), code)
		return
	}
	created, err := s.d.Schedules.Create(task)
	if err != nil {
		writeErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, created)
}

func (s *Server) handleUpdateSchedule(w http.ResponseWriter, r *http.Request) {
	if s.d.Schedules == nil {
		writeErr(w, "自动化任务未启用", http.StatusServiceUnavailable)
		return
	}
	var req scheduleReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	req.ID = strings.TrimSpace(req.ID)
	if req.ID == "" {
		writeErr(w, "missing id", http.StatusBadRequest)
		return
	}
	prev, ok := s.d.Schedules.Get(req.ID)
	if !ok {
		writeErr(w, schedule.ErrNotFound.Error(), http.StatusNotFound)
		return
	}
	// 乐观并发：界面上带的是它读到的那一版；对不上说明这条任务在别处改过，
	// 直接覆盖会把对方的修改静默抹掉。
	if req.ExpectedUpdatedAt != "" && !strings.EqualFold(req.ExpectedUpdatedAt, prev.UpdatedAt.Format(time.RFC3339Nano)) {
		writeErr(w, "这条任务已被修改，请刷新后重试", http.StatusConflict)
		return
	}
	updated, code, err := s.buildSchedule(req, &prev)
	if err != nil {
		writeErr(w, err.Error(), code)
		return
	}
	saved, err := s.d.Schedules.Update(req.ID, func(t *schedule.Task) error {
		t.Name = updated.Name
		t.Prompt = updated.Prompt
		t.Target = updated.Target
		t.Workspace = updated.Workspace
		t.Rule = updated.Rule
		t.NextRun = updated.NextRun
		// 改了规则就重新激活：已结束的任务说明旧规则跑完了，新规则要能跑。
		if t.Status == schedule.StatusEnded {
			t.Status = schedule.StatusActive
		}
		if t.Status == schedule.StatusPaused {
			// 暂停中的任务只换规则，不偷偷恢复。
			t.NextRun = updated.NextRun
		}
		t.LastError = ""
		return nil
	})
	if err != nil {
		writeErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, saved)
}

func (s *Server) handleDeleteSchedule(w http.ResponseWriter, r *http.Request) {
	if s.d.Schedules == nil {
		writeErr(w, "自动化任务未启用", http.StatusServiceUnavailable)
		return
	}
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		writeErr(w, "missing id", http.StatusBadRequest)
		return
	}
	if _, err := s.d.Schedules.Delete(id); err != nil {
		writeErr(w, err.Error(), http.StatusNotFound)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handleScheduleAction 处理暂停 / 恢复 / 立即执行。
func (s *Server) handleScheduleAction(w http.ResponseWriter, r *http.Request) {
	if s.d.Schedules == nil {
		writeErr(w, "自动化任务未启用", http.StatusServiceUnavailable)
		return
	}
	var req struct {
		ID     string `json:"id"`
		Action string `json:"action"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	if _, ok := s.d.Schedules.Get(req.ID); !ok {
		writeErr(w, schedule.ErrNotFound.Error(), http.StatusNotFound)
		return
	}
	switch req.Action {
	case "pause":
		t, err := s.d.Schedules.Update(req.ID, func(t *schedule.Task) error {
			t.Status = schedule.StatusPaused
			return nil
		})
		if err != nil {
			writeErr(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, t)
	case "resume":
		var noFuture bool
		t, err := s.d.Schedules.Update(req.ID, func(t *schedule.Task) error {
			if t.Status == schedule.StatusActive && t.NextRun != nil {
				return nil
			}
			now := time.Now()
			next, ok := t.Rule.Next(now)
			if !ok {
				noFuture = true
				return errors.New("这条规则已经没有下一次发生时间")
			}
			t.Status = schedule.StatusActive
			t.NextRun = &next
			return nil
		})
		if err != nil {
			code := http.StatusInternalServerError
			if noFuture {
				code = http.StatusBadRequest
			}
			writeErr(w, err.Error(), code)
			return
		}
		writeJSON(w, t)
	case "run":
		if s.runner == nil {
			writeErr(w, "调度器未启动", http.StatusServiceUnavailable)
			return
		}
		// 投递要起会话、写 stdin，不能挂在 HTTP 请求上等——立刻返回，
		// 结果落在任务的投递记录里（界面刷新列表就能看到）。
		go func() {
			if err := s.runner.RunNow(context.Background(), req.ID); err != nil {
				s.log.Printf("立即执行任务 %s 失败: %v", req.ID, err)
			}
		}()
		writeJSON(w, map[string]any{"ok": true, "accepted": true})
	default:
		writeErr(w, "未知操作: "+req.Action, http.StatusBadRequest)
	}
}

func (s *Server) handleScheduleDeliveries(w http.ResponseWriter, r *http.Request) {
	if s.d.Schedules == nil {
		writeErr(w, "自动化任务未启用", http.StatusServiceUnavailable)
		return
	}
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	t, ok := s.d.Schedules.Get(id)
	if !ok {
		writeErr(w, schedule.ErrNotFound.Error(), http.StatusNotFound)
		return
	}
	// 新的在前（界面按「最近一次」读），但内部存储保持追加顺序便于裁剪。
	out := make([]schedule.Delivery, 0, len(t.Deliveries))
	for i := len(t.Deliveries) - 1; i >= 0; i-- {
		out = append(out, t.Deliveries[i])
	}
	writeJSON(w, map[string]any{"deliveries": out})
}

// buildSchedule 校验并补齐一条任务（prev 为 nil 表示新建）。
//
// 第二个返回值是给 HTTP 用的状态码：工作区没授权是 403（与 /api/session 一致），
// 其余校验失败都是 400。
func (s *Server) buildSchedule(req scheduleReq, prev *schedule.Task) (schedule.Task, int, error) {
	task := schedule.Task{}
	if prev != nil {
		task = prev.Clone()
	}
	task.Name = strings.TrimSpace(req.Name)
	if task.Name == "" {
		return task, http.StatusBadRequest, errors.New("任务名称不能为空")
	}
	if len([]rune(task.Name)) > maxScheduleName {
		return task, http.StatusBadRequest, errors.New("任务名称太长")
	}
	task.Prompt = strings.TrimSpace(req.Prompt)
	if task.Prompt == "" {
		return task, http.StatusBadRequest, errors.New("任务内容不能为空")
	}
	if len([]rune(task.Prompt)) > maxSchedulePrompt {
		return task, http.StatusBadRequest, errors.New("任务内容太长")
	}

	cwd := strings.TrimSpace(req.Workspace)
	if cwd == "" {
		return task, http.StatusBadRequest, errors.New("请选择关联工作区")
	}
	abs, err := project.Validate(cwd)
	if err != nil {
		return task, http.StatusBadRequest, err
	}
	if err := s.ensureCwdAuthorizedReal(abs); err != nil {
		return task, http.StatusForbidden, err
	}
	task.Workspace = abs

	switch req.Target.Kind {
	case schedule.TargetConversation:
		if strings.TrimSpace(req.Target.ConversationID) == "" {
			return task, http.StatusBadRequest, errors.New("投递到现有对话时必须有对话 id")
		}
		task.Target = schedule.Target{Kind: req.Target.Kind, ConversationID: strings.TrimSpace(req.Target.ConversationID)}
	case schedule.TargetNewReuse:
		// 首次投递前没有对话 id；已经建过的那种（界面只改名字/规则）要保留。
		id := strings.TrimSpace(req.Target.ConversationID)
		if id == "" && prev != nil && prev.Target.Kind == schedule.TargetNewReuse {
			id = prev.Target.ConversationID
		}
		task.Target = schedule.Target{Kind: req.Target.Kind, ConversationID: id}
	case schedule.TargetNewEach:
		task.Target = schedule.Target{Kind: req.Target.Kind}
	default:
		return task, http.StatusBadRequest, errors.New("未知的投递目标")
	}

	if err := req.Rule.Validate(); err != nil {
		return task, http.StatusBadRequest, err
	}
	task.Rule = req.Rule
	// 一次性任务的绝对时间必须是未来：改成过去的时间点等于「保存后立刻触发」，
	// 用户通常不是这个意思。
	now := time.Now()
	next, ok := req.Rule.Next(now)
	if !ok {
		return task, http.StatusBadRequest, errors.New("这条规则没有下一次发生时间（仅一次任务的时间要在将来）")
	}
	task.NextRun = &next
	if prev == nil {
		task.Status = schedule.StatusActive
	}
	return task, http.StatusOK, nil
}

// DeliverScheduledTask 把一条任务的指令投进目标对话，返回实际投递到的对话 id。
//
// 目标语义（与 DSH 一致）：
//   - conversation：投给指定对话；
//   - new-reuse：还没绑对话就新建一个并记住，之后一直用它；
//   - new-each：每次都新建（标题带时间，便于在侧栏里区分）。
func (s *Server) DeliverScheduledTask(ctx context.Context, t schedule.Task, fire time.Time) (string, error) {
	if s.d.Manager == nil {
		return "", errors.New("会话管理未启用")
	}
	cwd, err := project.Validate(t.Workspace)
	if err != nil {
		return "", err
	}
	if err := s.ensureCwdAuthorizedReal(cwd); err != nil {
		return "", err
	}

	id := t.Target.ConversationID
	createNew := false
	switch t.Target.Kind {
	case schedule.TargetConversation:
		if id == "" {
			return "", errors.New("这条任务没有关联对话")
		}
	case schedule.TargetNewReuse:
		createNew = id == ""
	case schedule.TargetNewEach:
		createNew = true
	default:
		return "", errors.New("未知的投递目标")
	}

	var info manager.Info
	// schedTitle 是「新建的对话本来该叫什么」：投递那一刻转录往往还没落盘，
	// 落不下元数据，标题要等这一轮结束再补（见 finishScheduledTurn）。
	schedTitle := ""
	if createNew {
		newID, err := manager.NewUUID()
		if err != nil {
			return "", err
		}
		info, err = s.d.Manager.StartFresh(newID, cwd, "", "")
		if err != nil {
			return "", err
		}
		id = newID
		// 标题带规则时区下的启动时间：每次新建的对话在侧栏里长得一样时，
		// 只能靠时间区分是哪一次运行。
		schedTitle = t.Name + " · " + fire.In(t.Rule.Location()).Format("01-02 15:04")
	} else {
		// 归档/删除的对话不能投递：消息会落进一个用户打开不了的对话。
		if s.d.Conversations != nil {
			if rec, ok := s.d.Conversations.Get(id); ok {
				if rec.Deleted {
					return "", errors.New("关联对话已删除")
				}
				if rec.Archived {
					return "", errors.New("关联对话已归档，恢复后才能接收任务")
				}
			}
		}
		if _, ok := s.d.Manager.Get(id); ok {
			// 已经在跑，直接复用这个会话。
		} else if s.hasTranscript(id) {
			info, err = s.d.Manager.Resume(id, cwd, "", "")
			if err != nil {
				return "", err
			}
		} else {
			info, err = s.d.Manager.StartFresh(id, cwd, "", "")
			if err != nil {
				return "", err
			}
		}
	}

	sess, ok := s.d.Manager.Get(id)
	if !ok {
		return "", errors.New("会话启动后不可用")
	}
	if err := sess.Prompt(t.Prompt); err != nil {
		return "", err
	}
	// 这条会话的回合结束后要再通知一次面板：它多半没人打开，而标题（转录首条消息）、
	// live/state 都只在 GET /api/conversations 里现算。见 NoteSessionState。
	s.watchScheduledTurn(id, scheduledTurn{title: schedTitle, cwd: cwd})

	if createNew && s.d.Conversations != nil {
		// 转录已经落盘的话，标题现在就能写（多数情况写不上：CLI 还没来得及落盘）。
		if s.hasTranscript(id) {
			now := time.Now()
			_ = s.d.Conversations.Ensure(conversation.Record{
				ID: id, Cwd: cwd, Title: schedTitle, CreatedAt: now, LastActive: now,
			})
		}
		s.broadcastConversationsChanged()
	} else if info.ID != "" {
		s.touchConversation(info)
	}
	s.touchWorkspace(cwd)
	return id, nil
}

// broadcastConversationsChanged 通知所有面板刷新对话列表。
//
// 定时任务可能在没有任何浏览器打开时新建对话；用户下次打开面板时列表必须已经
// 包含它——前端收到这条事件就重新拉一次 /api/conversations。
func (s *Server) broadcastConversationsChanged() {
	if s.d.Hub == nil {
		return
	}
	s.d.Hub.Broadcast(systemTopic, WireEvent{Kind: "conversations.changed"})
}

// scheduledTurn 是一条「还没跑完的投递」：回合结束后要用它补写标题并通知面板。
type scheduledTurn struct {
	// title 只在「这次投递新建了对话」时非空（比如「每日巡检 · 11-19 09:00」）。
	// 投递那一刻转录往往还没落盘，元数据写不进去，只能等回合结束再补。
	title string
	cwd   string
}

// watchScheduledTurn 记下「这条会话的回合结束后要再通知一次面板」。
//
// 不记的话只能等用户点开这条对话或刷新页面：投递那一刻列表还是「刚新建、还没转录」，
// 前端拿到的标题是空的（显示「新对话」）、state 是 busy（显示转圈），之后没人再拉列表。
func (s *Server) watchScheduledTurn(id string, turn scheduledTurn) {
	if id == "" {
		return
	}
	s.scheduledMu.Lock()
	defer s.scheduledMu.Unlock()
	if s.scheduledTurns == nil {
		s.scheduledTurns = make(map[string]scheduledTurn)
	}
	// 同一轮里又投了一次（例如每分钟一次的 new-reuse 任务，这一轮还没跑完）：
	// 后一次没有待补的标题，别把前一次的抹掉——否则新建的那条对话永远拿不到
	// 「任务名 · 时间」这个标题。
	if prev, ok := s.scheduledTurns[id]; ok {
		if turn.title == "" {
			turn.title = prev.title
		}
		if turn.cwd == "" {
			turn.cwd = prev.cwd
		}
	}
	s.scheduledTurns[id] = turn
}

// consumeScheduledTurn 取走这条会话的待通知标记；没有标记返回 false。
func (s *Server) consumeScheduledTurn(id string) (scheduledTurn, bool) {
	s.scheduledMu.Lock()
	defer s.scheduledMu.Unlock()
	turn, ok := s.scheduledTurns[id]
	if !ok {
		return scheduledTurn{}, false
	}
	delete(s.scheduledTurns, id)
	return turn, true
}

// NoteSessionState 是会话事件的旁路出口（装配层在 manager 的事件回调里调它）。
//
// 自动化任务投递的会话多半没人打开：一轮结束（`session.state=ready`）时没有任何
// 客户端会收到 `result`，而侧栏那一行的标题（转录首条消息）与 live/state 都只在
// `GET /api/conversations` 里现算。所以这里在回合结束时补写标题并推一条
// conversations.changed，让面板自己重拉一次——否则那条对话会一直停在「新对话 + 转圈」。
//
// 只认记过的会话：普通对话的回合结束时用户正看着它，没必要让每个连接都去重扫一遍转录。
func (s *Server) NoteSessionState(sid string, data json.RawMessage) {
	var payload struct {
		State string `json:"state"`
	}
	if err := json.Unmarshal(data, &payload); err != nil || payload.State != session.StateReady {
		return
	}
	s.finishScheduledTurn(sid)
}

// NoteSessionClosed 同理：进程没了（崩溃 / 空闲回收）时这一轮不会再有 result，
// 但列表里的 live/state 变了，同样要刷新一次。
func (s *Server) NoteSessionClosed(sid string) {
	s.finishScheduledTurn(sid)
}

// finishScheduledTurn 收尾一次自动化任务投递：补写标题（这时转录肯定有了）、
// 通知面板重拉列表。没记过的会话什么都不做。
func (s *Server) finishScheduledTurn(sid string) {
	turn, ok := s.consumeScheduledTurn(sid)
	if !ok {
		return
	}
	// 有转录才落元数据：空对话落记录会留下 resume 不起来的幽灵条目
	// （这里已经是回合结束，正常情况下转录一定在）。
	if turn.title != "" && s.d.Conversations != nil && s.hasTranscript(sid) {
		now := time.Now()
		_ = s.d.Conversations.Ensure(conversation.Record{
			ID: sid, Cwd: turn.cwd, Title: turn.title, CreatedAt: now, LastActive: now,
		})
	}
	s.broadcastConversationsChanged()
}
