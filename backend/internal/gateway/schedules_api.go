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
	"path/filepath"
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
		// 达到条数上限是「你不能再建了」，不是服务器出错。
		code := http.StatusInternalServerError
		if errors.Is(err, schedule.ErrTooMany) {
			code = http.StatusBadRequest
		}
		writeErr(w, err.Error(), code)
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
	if req.ExpectedUpdatedAt != "" && !sameInstant(req.ExpectedUpdatedAt, prev.UpdatedAt) {
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

// sameInstant 报告客户端带回的时间戳是否就是这一版（乐观并发用）。
//
// 比解析后的时刻而不是字符串：客户端原样带回来时写法本应一致，但 `Z` 与 `+00:00`、
// 带不带纳秒小数、末尾多个空格都会让字符串比较把「同一版」误判成「改过了」，
// 用户看到的是「请刷新后重试」，而其实什么都没变。
func sameInstant(raw string, at time.Time) bool {
	got, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(raw))
	if err != nil {
		return false
	}
	return got.Equal(at)
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
//
// 字段级规则（名称/内容长度、投递目标）走 schedule.Task.Validate：模型那条路
// （`ccweb mcp-schedule`）用的是同一份，两边各写一套必然漂移。
func (s *Server) buildSchedule(req scheduleReq, prev *schedule.Task) (schedule.Task, int, error) {
	task := schedule.Task{}
	if prev != nil {
		task = prev.Clone()
	}
	task.Name = strings.TrimSpace(req.Name)
	task.Prompt = strings.TrimSpace(req.Prompt)
	// 目标：new-reuse 已经绑过对话的（界面只改名字/规则时不会回传 id）要保留。
	target := schedule.Target{Kind: req.Target.Kind, ConversationID: strings.TrimSpace(req.Target.ConversationID)}
	if req.Target.Kind == schedule.TargetNewReuse && target.ConversationID == "" &&
		prev != nil && prev.Target.Kind == schedule.TargetNewReuse {
		target.ConversationID = prev.Target.ConversationID
	}
	if req.Target.Kind == schedule.TargetNewEach {
		target.ConversationID = ""
	}
	task.Target = target
	task.Rule = req.Rule
	if err := task.Validate(); err != nil {
		return task, http.StatusBadRequest, err
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
	// 落不下元数据，标题要等这一轮结束再补（见 finishPendingTurn）。
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
		//
		// 同时要核对目录：任务的「关联工作区」是可改的，而对话属于它自己那个目录。
		// 两边不一致时 CLI 的 `--resume` 按 cwd 编码找转录，必然回
		// 「No conversation found with session ID: …」——投递每轮失败一次、原因还看不出
		// 是目录对不上（与 POST /api/session {resume} 的 409 同一条判断）。
		if s.d.Conversations != nil {
			if rec, ok := s.d.Conversations.Get(id); ok {
				if rec.Deleted {
					return "", errors.New("关联对话已删除")
				}
				if rec.Archived {
					return "", errors.New("关联对话已归档，恢复后才能接收任务")
				}
				if rec.Cwd != "" && filepath.Clean(rec.Cwd) != cwd {
					return "", errors.New("关联对话属于其它工作目录（" + rec.Cwd + "），请把任务的关联工作区改成它")
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
	s.watchPendingTurn(id, pendingTurn{title: schedTitle, cwd: cwd})

	if createNew && s.d.Conversations != nil {
		// 转录已经落盘的话，标题现在就能写（多数情况写不上：CLI 还没来得及落盘）。
		if s.hasTranscript(id) {
			now := time.Now()
			_ = s.d.Conversations.Ensure(conversation.Record{
				ID: id, Cwd: cwd, Title: schedTitle, CreatedAt: now, LastActive: now,
			})
		}
		s.BroadcastConversationsChanged()
	} else if info.ID != "" {
		s.touchConversation(info)
	}
	s.touchWorkspace(cwd)
	return id, nil
}

// pendingTurn 是一条「这一轮还没跑完」的记录：回合结束后要补写标题（如果有）
// 并通知所有面板重拉对话列表。
//
// 两个来源：自动化任务投递（title 是「任务名 · 时间」，投递那一刻转录还没落盘，
// 只能等回合结束再补）与用户新建对话的首条消息（title 为空，只为了在标题与
// live/state 定稿后再刷新一次列表）。
type pendingTurn struct {
	// title 只在「这一轮要负责起名」时非空。
	title string
	cwd   string
}

// watchPendingTurn 记下「这条会话的回合结束后要再通知一次面板」。
//
// 不记的话只能等用户点开这条对话或刷新页面：投递那一刻列表还是「刚新建、还没转录」，
// 前端拿到的标题是空的（显示「新对话」）、state 是 busy（显示转圈），之后没人再拉列表。
func (s *Server) watchPendingTurn(id string, turn pendingTurn) {
	if id == "" {
		return
	}
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	if s.pendingTurns == nil {
		s.pendingTurns = make(map[string]pendingTurn)
	}
	// 同一轮里又投了一次（例如每分钟一次的 new-reuse 任务，这一轮还没跑完）：
	// 后一次没有待补的标题，别把前一次的抹掉——否则新建的那条对话永远拿不到
	// 「任务名 · 时间」这个标题。
	if prev, ok := s.pendingTurns[id]; ok {
		if turn.title == "" {
			turn.title = prev.title
		}
		if turn.cwd == "" {
			turn.cwd = prev.cwd
		}
	}
	s.pendingTurns[id] = turn
}

// consumePendingTurn 取走这条会话的待通知标记；没有标记返回 false。
func (s *Server) consumePendingTurn(id string) (pendingTurn, bool) {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	turn, ok := s.pendingTurns[id]
	if !ok {
		return pendingTurn{}, false
	}
	delete(s.pendingTurns, id)
	return turn, true
}

// NoteSessionReplaced 在 CLI 换了会话 id（`/clear`）时把待通知记录搬到新 id 上。
//
// **不搬的话那条记录永远没人消费**：回合结束时的事件按新 id 走（见
// session.CurrentID），`NoteSessionState(newID)` 找不到旧 id 下的记录，
// 于是它既不会被补写标题也不会被推列表——还顺手在表里留了一条永远不删的残项。
func (s *Server) NoteSessionReplaced(from, to string) {
	if from == "" || to == "" || from == to {
		return
	}
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	turn, ok := s.pendingTurns[from]
	if !ok {
		return
	}
	delete(s.pendingTurns, from)
	// 新 id 上已经有一条就保留它（同一轮里换了 id 又投递过一次这种边角情况）。
	if _, taken := s.pendingTurns[to]; !taken {
		s.pendingTurns[to] = turn
	}
}

// NoteSessionState 是会话事件的旁路出口（装配层在 manager 的事件回调里调它）。
//
// 一轮结束（`session.state=ready`）时列表里那一行的标题（转录首条消息）与
// live/state 才定稿，而它们都只在 `GET /api/conversations` 里现算。所以这里
// 补写标题并推一条 conversations.changed，让别的设备自己重拉一次——否则新建的
// 对话在那边永远停在「新对话 + 转圈」，任务投递出去的对话更是没人看得到。
//
// 只认记过的会话：没记过的普通对话，用户正看着它，没必要让每个连接都去重扫一遍转录。
func (s *Server) NoteSessionState(sid string, data json.RawMessage) {
	var payload struct {
		State string `json:"state"`
	}
	if err := json.Unmarshal(data, &payload); err != nil || payload.State != session.StateReady {
		return
	}
	s.finishPendingTurn(sid)
}

// NoteSessionTitle 收的是 CLI 报上来的会话名（`system/session_title_changed`）：
// 终端里的 `/rename`、IDE 插件、`--name`、别的客户端 rename_session 都会产生它。
//
// 不接的后果是双向的：别处改过的名字在这边看不见，而用户在这边再改一次时，
// 旧标题又被写回去，两边永远对不上。
//
// 落库走 Rename（自定义标题），与用户在界面上重命名是同一条路径 —— 列表接口里
// 「元数据标题优先于转录首条消息」的规则因此天然成立，不用另加一套优先级。
// 自动 AI 标题不走这条（`-p` stream-json 模式下 CLI 根本不产生它），所以这里
// 不会把用户手改的标题顶掉。
func (s *Server) NoteSessionTitle(sid string, data json.RawMessage) {
	if s.d.Conversations == nil || sid == "" {
		return
	}
	var payload struct {
		Title string `json:"title"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return
	}
	title, err := normalizeTitle(payload.Title)
	if err != nil || title == "" {
		return
	}
	// 记录可能还没有（首轮还没落元数据就改了名）：先收养，再写标题。
	if _, ok := s.d.Conversations.Get(sid); !ok {
		if _, ok := s.ensureConversation(sid); !ok {
			return
		}
	}
	if cur, ok := s.d.Conversations.Get(sid); ok && cur.Title == title {
		return // 同一个名字重复上报：CLI 明确要求当作没变化
	}
	if err := s.d.Conversations.Rename(sid, title); err != nil {
		return
	}
	s.BroadcastConversationsChanged()
}

// NoteSessionClosed 同理：进程没了（崩溃 / 空闲回收）时这一轮不会再有 result，
// 但列表里的 live/state 变了，同样要刷新一次。
//
// **与回合结束不同，这里必须无条件推**：进程结束是「列表里那一行从活跃变灰」，
// 而 `closed` 事件只发给订阅了**该会话 topic** 的连接——别的设备没打开这条对话，
// 就永远收不到，它侧栏里那一行会一直显示「活跃」，直到自己下次刷新列表。
// 触发它的事件全都低频（用户点停止、空闲回收默认 10 分钟一次、删版本），
// 不像 prompt 那样每条都来，所以不需要「只在有标记时推」这层节流。
func (s *Server) NoteSessionClosed(sid string) {
	// 先收掉待通知的回合（任务投递的那条要补写标题）。finishPendingTurn 自己
	// 会推一次，没有标记就什么都不做——两种情况都只需要总共一条刷新。
	if !s.finishPendingTurn(sid) {
		s.BroadcastConversationsChanged()
	}
}

// finishPendingTurn 收尾一次待通知的回合：补写标题（这时转录肯定有了）、
// 通知面板重拉列表。没记过的会话什么都不做，返回 false。
func (s *Server) finishPendingTurn(sid string) bool {
	turn, ok := s.consumePendingTurn(sid)
	if !ok {
		return false
	}
	// 有转录才落元数据：空对话落记录会留下 resume 不起来的幽灵条目
	// （这里已经是回合结束，正常情况下转录一定在）。
	if turn.title != "" && s.d.Conversations != nil && s.hasTranscript(sid) {
		now := time.Now()
		_ = s.d.Conversations.Ensure(conversation.Record{
			ID: sid, Cwd: turn.cwd, Title: turn.title, CreatedAt: now, LastActive: now,
		})
	}
	s.BroadcastConversationsChanged()
	return true
}
