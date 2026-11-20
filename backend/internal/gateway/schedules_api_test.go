package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ccweb/backend/internal/agent/session"
	"ccweb/backend/internal/authz"
	"ccweb/backend/internal/config"
	"ccweb/backend/internal/conversation"
	"ccweb/backend/internal/hub"
	"ccweb/backend/internal/schedule"
	"ccweb/backend/internal/settings"
	"ccweb/backend/internal/workspace"
)

// syncBuffer 是并发安全的写缓冲：会话的 writeLoop 在另一个 goroutine 里写。
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) Read([]byte) (int, error) { return 0, nil }

func (b *syncBuffer) Close() error { return nil }

func (b *syncBuffer) lines() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return strings.Split(strings.TrimSpace(b.buf.String()), "\n")
}

type schedFixture struct {
	srv   *Server
	mgr   *fakeMgr
	store *schedule.Store
	conv  *conversation.Store
	root  string
	out   *syncBuffer
}

// newSchedServer 装配一个带自动化任务的最小网关。
func newSchedServer(t *testing.T) *schedFixture {
	t.Helper()
	mgr := &fakeMgr{}
	out := &syncBuffer{}
	mgr.newSession = func(id, cwd string) *session.Session {
		return session.New(id, cwd, out, func(session.Event) {})
	}

	setStore, err := settings.Open(filepath.Join(t.TempDir(), "settings.json"))
	if err != nil {
		t.Fatalf("settings.Open: %v", err)
	}
	root := t.TempDir()
	ws, err := workspace.Open(filepath.Join(t.TempDir(), "workspaces.json"), root)
	if err != nil {
		t.Fatalf("workspace.Open: %v", err)
	}
	conv, err := conversation.Open(filepath.Join(t.TempDir(), "conversations.json"))
	if err != nil {
		t.Fatalf("conversation.Open: %v", err)
	}
	sch, err := schedule.Open(filepath.Join(t.TempDir(), "schedules.json"))
	if err != nil {
		t.Fatalf("schedule.Open: %v", err)
	}

	deps := Deps{
		Cfg:           config.Config{Version: "test-1", MaxSessions: 4},
		Guard:         authz.New(""),
		Hub:           hub.New(),
		Manager:       mgr,
		HistoryDir:    t.TempDir(),
		ProjectsRoot:  root,
		Settings:      setStore,
		Workspaces:    ws,
		Conversations: conv,
		Schedules:     sch,
		StartedAt:     time.Now(),
	}
	return &schedFixture{srv: New(deps, nil), mgr: mgr, store: sch, conv: conv, root: root, out: out}
}

func (f *schedFixture) post(t *testing.T, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	f.srv.Handler().ServeHTTP(rec, req)
	return rec
}

func (f *schedFixture) patch(t *testing.T, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	f.srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPatch, "/api/schedules", bytes.NewReader(raw)))
	return rec
}

func (f *schedFixture) do(t *testing.T, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	f.srv.Handler().ServeHTTP(rec, httptest.NewRequest(method, path, nil))
	return rec
}

func (f *schedFixture) createTask(t *testing.T, over map[string]any) schedule.Task {
	t.Helper()
	body := map[string]any{
		"name":      "每日巡检",
		"prompt":    "跑一遍测试",
		"workspace": f.root,
		"target":    map[string]any{"kind": schedule.TargetNewEach},
		"rule":      map[string]any{"kind": schedule.KindDaily, "time": "09:00"},
	}
	for k, v := range over {
		body[k] = v
	}
	rec := f.post(t, "/api/schedules", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("创建任务失败: %d %s", rec.Code, rec.Body.String())
	}
	var task schedule.Task
	if err := json.Unmarshal(rec.Body.Bytes(), &task); err != nil {
		t.Fatalf("解析任务: %v", err)
	}
	return task
}

func TestScheduleCreateValidates(t *testing.T) {
	f := newSchedServer(t)
	base := map[string]any{
		"name":      "任务",
		"prompt":    "干活",
		"workspace": f.root,
		"target":    map[string]any{"kind": schedule.TargetNewEach},
		"rule":      map[string]any{"kind": schedule.KindDaily, "time": "09:00"},
	}
	cases := []struct {
		name  string
		patch map[string]any
		want  int
	}{
		{"名称为空", map[string]any{"name": "  "}, http.StatusBadRequest},
		{"内容为空", map[string]any{"prompt": ""}, http.StatusBadRequest},
		{"工作区为空", map[string]any{"workspace": ""}, http.StatusBadRequest},
		{"工作区未授权", map[string]any{"workspace": "/etc"}, http.StatusForbidden},
		{"规则非法", map[string]any{"rule": map[string]any{"kind": "weekly", "time": "09:00"}}, http.StatusBadRequest},
		{"仅一次却在过去", map[string]any{"rule": map[string]any{"kind": schedule.KindOnce, "at": "2020-01-01T09:00:00+08:00"}}, http.StatusBadRequest},
		{"投现有对话却没 id", map[string]any{"target": map[string]any{"kind": schedule.TargetConversation}}, http.StatusBadRequest},
		{"未知目标", map[string]any{"target": map[string]any{"kind": "nope"}}, http.StatusBadRequest},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			body := map[string]any{}
			for k, v := range base {
				body[k] = v
			}
			for k, v := range c.patch {
				body[k] = v
			}
			if rec := f.post(t, "/api/schedules", body); rec.Code != c.want {
				t.Fatalf("code = %d, want %d（%s）", rec.Code, c.want, rec.Body.String())
			}
		})
	}
}

func TestScheduleLifecycle(t *testing.T) {
	f := newSchedServer(t)
	task := f.createTask(t, nil)
	if task.NextRun == nil || !task.NextRun.After(time.Now()) {
		t.Fatalf("新建任务应当有未来的 NextRun: %v", task.NextRun)
	}

	rec := f.do(t, http.MethodGet, "/api/schedules")
	if rec.Code != http.StatusOK {
		t.Fatalf("列表 code = %d", rec.Code)
	}
	var list struct {
		Tasks []schedule.Task `json:"tasks"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("解析列表: %v", err)
	}
	if len(list.Tasks) != 1 || list.Tasks[0].ID != task.ID {
		t.Fatalf("列表内容不对: %+v", list.Tasks)
	}

	// 暂停 → 恢复：恢复后要重新算出下一次，不能停在空 NextRun 上。
	if rec := f.post(t, "/api/schedules/action", map[string]any{"id": task.ID, "action": "pause"}); rec.Code != http.StatusOK {
		t.Fatalf("暂停 code = %d", rec.Code)
	}
	if got, _ := f.store.Get(task.ID); got.Status != schedule.StatusPaused {
		t.Fatalf("暂停后状态 = %q", got.Status)
	}
	if rec := f.post(t, "/api/schedules/action", map[string]any{"id": task.ID, "action": "resume"}); rec.Code != http.StatusOK {
		t.Fatalf("恢复 code = %d: %s", rec.Code, rec.Body.String())
	}
	if got, _ := f.store.Get(task.ID); got.Status != schedule.StatusActive || got.NextRun == nil {
		t.Fatalf("恢复后状态 = %q next = %v", got.Status, got.NextRun)
	}

	// 改名字：规则没变，NextRun 保留原值（不能因为改个名字就把计划推迟）。
	before, _ := f.store.Get(task.ID)
	rec = f.patch(t, map[string]any{
		"id":                  task.ID,
		"name":                "改名了",
		"prompt":              before.Prompt,
		"workspace":           before.Workspace,
		"target":              before.Target,
		"rule":                before.Rule,
		"expected_updated_at": before.UpdatedAt.Format(time.RFC3339Nano),
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("修改 code = %d: %s", rec.Code, rec.Body.String())
	}
	if got, _ := f.store.Get(task.ID); got.Name != "改名了" {
		t.Fatalf("改名没生效: %q", got.Name)
	}

	// 用过期版本再改一次：必须 409，不能静默覆盖。
	rec = f.patch(t, map[string]any{
		"id":                  task.ID,
		"name":                "又改了",
		"prompt":              before.Prompt,
		"workspace":           before.Workspace,
		"target":              before.Target,
		"rule":                before.Rule,
		"expected_updated_at": before.UpdatedAt.Add(-time.Second).Format(time.RFC3339Nano),
	})
	if rec.Code != http.StatusConflict {
		t.Fatalf("过期版本应当 409，得到 %d", rec.Code)
	}

	if rec := f.do(t, http.MethodDelete, "/api/schedules?id="+task.ID); rec.Code != http.StatusOK {
		t.Fatalf("删除 code = %d", rec.Code)
	}
	if _, ok := f.store.Get(task.ID); ok {
		t.Fatal("删除后还能查到")
	}
}

// 每次新建：投递时造一个新对话，标题带时间，并把指令真的写进 stdin。
func TestDeliverScheduledTaskNewEach(t *testing.T) {
	f := newSchedServer(t)
	task := f.createTask(t, nil)

	id, err := f.srv.DeliverScheduledTask(context.Background(), task, time.Date(2026, 11, 19, 9, 0, 0, 0, time.Local))
	if err != nil {
		t.Fatalf("投递失败: %v", err)
	}
	if len(f.mgr.fresh) != 1 || f.mgr.fresh[0] != id {
		t.Fatalf("应当用 StartFresh 起新对话，fresh = %v id = %s", f.mgr.fresh, id)
	}
	if len(f.out.lines()) == 0 || !strings.Contains(strings.Join(f.out.lines(), ""), "跑一遍测试") {
		t.Fatalf("指令没有写进会话: %v", f.out.lines())
	}
}

// 复用模式：已经绑了对话就直接投进去，不新建。
func TestDeliverScheduledTaskReusesConversation(t *testing.T) {
	f := newSchedServer(t)
	if err := f.conv.Ensure(conversation.Record{ID: "conv-1", Cwd: f.root, Title: "旧对话"}); err != nil {
		t.Fatal(err)
	}
	f.mgr.register("conv-1", f.root)
	task := schedule.Task{
		Name:      "复用",
		Prompt:    "继续干",
		Workspace: f.root,
		Target:    schedule.Target{Kind: schedule.TargetNewReuse, ConversationID: "conv-1"},
		Rule:      schedule.Rule{Kind: schedule.KindHours, Interval: 1},
	}
	if _, err := f.srv.DeliverScheduledTask(context.Background(), task, time.Now()); err != nil {
		t.Fatalf("投递失败: %v", err)
	}
	if len(f.mgr.fresh) != 0 {
		t.Fatalf("已有对话时不该新建: %v", f.mgr.fresh)
	}
	if !strings.Contains(strings.Join(f.out.lines(), ""), "继续干") {
		t.Fatalf("指令没写进对话: %v", f.out.lines())
	}
}

func TestDeliverScheduledTaskRejects(t *testing.T) {
	f := newSchedServer(t)
	if err := f.conv.Ensure(conversation.Record{ID: "archived-1", Cwd: f.root, Archived: true}); err != nil {
		t.Fatal(err)
	}
	// 任务改过「关联工作区」、而对话属于另一个目录：`--resume` 按 cwd 找转录，
	// 必然报 No conversation found，要在起进程之前挡掉。
	if err := f.conv.Ensure(conversation.Record{ID: "other-cwd", Cwd: filepath.Join(f.root, "sub")}); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		task schedule.Task
		want string
	}{
		{
			name: "工作区未授权",
			task: schedule.Task{Workspace: "/etc", Prompt: "x", Target: schedule.Target{Kind: schedule.TargetNewEach}},
			want: "未授权",
		},
		{
			name: "归档的对话不能投递",
			task: schedule.Task{
				Workspace: f.root, Prompt: "x",
				Target: schedule.Target{Kind: schedule.TargetConversation, ConversationID: "archived-1"},
			},
			want: "已归档",
		},
		{
			name: "对话属于其它目录",
			task: schedule.Task{
				Workspace: f.root, Prompt: "x",
				Target: schedule.Target{Kind: schedule.TargetConversation, ConversationID: "other-cwd"},
			},
			want: "其它工作目录",
		},
		{
			name: "投现有对话但没 id",
			task: schedule.Task{Workspace: f.root, Prompt: "x", Target: schedule.Target{Kind: schedule.TargetConversation}},
			want: "没有关联对话",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := f.srv.DeliverScheduledTask(context.Background(), c.task, time.Now()); err == nil {
				t.Fatal("预期报错")
			} else if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("错误 = %q, want 含 %q", err.Error(), c.want)
			}
		})
	}
}

// 立即执行：接口立刻返回，投递在后台完成。
func TestScheduleRunNow(t *testing.T) {
	f := newSchedServer(t)
	task := f.createTask(t, nil)

	var calls atomic.Int32
	f.srv.SetScheduleRunner(schedule.NewRunner(f.store, func(_ context.Context, _ schedule.Task, _ time.Time) (string, error) {
		// 投递跑在后台 goroutine 里（接口立即返回），这里的计数必须原子：
		// 普通 int 会让 `go test -race` 报数据竞争，把整套 race 检查废掉。
		calls.Add(1)
		return "", nil
	}, nil))
	rec := f.post(t, "/api/schedules/action", map[string]any{"id": task.ID, "action": "run"})
	if rec.Code != http.StatusOK {
		t.Fatalf("立即执行 code = %d: %s", rec.Code, rec.Body.String())
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && calls.Load() == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	if calls.Load() != 1 {
		t.Fatalf("立即执行没有投递（calls=%d）", calls.Load())
	}
	// 计划时间保持不变。
	if got, _ := f.store.Get(task.ID); got.NextRun == nil {
		t.Fatal("立即执行不该清掉下一次计划时间")
	}
}

// 没有调度器时立即执行要说清楚，而不是假装成功。
func TestScheduleRunNowWithoutRunner(t *testing.T) {
	f := newSchedServer(t)
	task := f.createTask(t, nil)
	rec := f.post(t, "/api/schedules/action", map[string]any{"id": task.ID, "action": "run"})
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("code = %d, want 503", rec.Code)
	}
}

// 回归：自动化任务投递出去的对话多半没人打开，投递那一刻列表里还是
// 「刚新建、没有转录」（前端显示「新对话」）且 state=busy（显示转圈）。
// 标题取自转录首条消息、live/state 也是列表接口现算的，所以这一轮结束时
// 必须再推一条 conversations.changed，否则那条对话会一直停在转圈上。
func TestScheduledTurnEndRefreshesConversationList(t *testing.T) {
	f := newSchedServer(t)
	rec := &recClient{}
	f.srv.d.Hub.Subscribe(systemTopic, rec)

	task := f.createTask(t, nil)
	id, err := f.srv.DeliverScheduledTask(context.Background(), task, time.Now())
	if err != nil {
		t.Fatalf("投递失败: %v", err)
	}
	// 新建时就推了一条（列表里要立刻出现这条对话）。
	if n := len(rec.take()); n != 1 {
		t.Fatalf("投递时应推 1 次，得到 %d", n)
	}

	// 与本轮无关的会话：不推。
	f.srv.NoteSessionState("other-session", json.RawMessage(`{"state":"ready"}`))
	if n := len(rec.take()); n != 0 {
		t.Fatalf("没投递过的会话不该触发刷新，得到 %d 次", n)
	}
	// 同一会话的中间状态（busy）不算回合结束。
	f.srv.NoteSessionState(id, json.RawMessage(`{"state":"busy"}`))
	if n := len(rec.take()); n != 0 {
		t.Fatalf("busy 不该触发刷新，得到 %d 次", n)
	}

	f.srv.NoteSessionState(id, json.RawMessage(`{"state":"ready"}`))
	events := rec.take()
	if len(events) != 1 || events[0].Kind != "conversations.changed" {
		t.Fatalf("回合结束应推 1 条 conversations.changed，得到 %+v", events)
	}
	// 标记已消耗：同一条会话不会因为后续状态变化再推。
	f.srv.NoteSessionState(id, json.RawMessage(`{"state":"ready"}`))
	if n := len(rec.take()); n != 0 {
		t.Fatalf("同一条会话不该重复推，得到 %d 次", n)
	}
}

// 进程在回合结束前就没了（崩溃 / 被关闭）时也要刷新一次：
// 这一轮不会再有 result，但列表里的 live/state 变了。
func TestScheduledSessionClosedRefreshesConversationList(t *testing.T) {
	f := newSchedServer(t)
	rec := &recClient{}
	f.srv.d.Hub.Subscribe(systemTopic, rec)

	task := f.createTask(t, nil)
	id, err := f.srv.DeliverScheduledTask(context.Background(), task, time.Now())
	if err != nil {
		t.Fatalf("投递失败: %v", err)
	}
	rec.take()

	f.srv.NoteSessionClosed(id)
	events := rec.take()
	if len(events) != 1 || events[0].Kind != "conversations.changed" {
		t.Fatalf("进程结束应推 1 条 conversations.changed，得到 %+v", events)
	}
	// 关闭与「回合结束」是同一个标记，先到的那个推完就不再推。
	f.srv.NoteSessionState(id, json.RawMessage(`{"state":"ready"}`))
	if n := len(rec.take()); n != 0 {
		t.Fatalf("标记已消耗，不该再推，得到 %d 次", n)
	}
}

// 没有任何待通知标记的普通对话被关闭时也要推：`closed` 事件只发给订阅了该会话
// topic 的连接（`h.Broadcast(sid, …)`），别的设备没打开这条对话就收不到，它侧栏里
// 那一行会一直显示「活跃」——用户点停止、空闲回收（默认 30 分钟）、删版本都走这条路。
func TestSessionClosedRefreshesListWithoutPendingTurn(t *testing.T) {
	f := newSchedServer(t)
	rec := &recClient{}
	f.srv.d.Hub.Subscribe(systemTopic, rec)

	f.srv.NoteSessionClosed("some-plain-conversation")
	if events := rec.take(); len(events) != 1 || events[0].Kind != "conversations.changed" {
		t.Fatalf("进程结束应推 1 条 conversations.changed，得到 %+v", events)
	}
}

// 投递那一刻转录往往还没落盘（CLI 是异步写的），标题写不进元数据；
// 回合结束时转录肯定有了，这时补写——否则每次新建的对话在侧栏里都叫「新对话」，
// 「任务名 · 时间」这个用来区分多次运行的标题永远落不下。
func TestScheduledTurnEndWritesTitle(t *testing.T) {
	f := newSchedServer(t)
	task := f.createTask(t, map[string]any{"name": "每日巡检"})
	id, err := f.srv.DeliverScheduledTask(context.Background(), task, time.Date(2026, 11, 19, 9, 0, 0, 0, time.Local))
	if err != nil {
		t.Fatalf("投递失败: %v", err)
	}
	if _, ok := f.conv.Get(id); ok {
		t.Fatal("还没有转录时不该落元数据（会留下 resume 不起来的幽灵条目）")
	}

	// 这一轮还没跑完时又投了一次（例如每分钟一次的 new-reuse，没有待补标题）：
	// 不能把前一次记下的标题抹掉。
	f.srv.watchPendingTurn(id, pendingTurn{})

	// 单元测试里没有真的 claude 转录：清掉历史目录即视为「有转录」。
	f.srv.d.HistoryDir = ""
	f.srv.NoteSessionState(id, json.RawMessage(`{"state":"ready"}`))

	rec, ok := f.conv.Get(id)
	if !ok {
		t.Fatal("回合结束后应当补上对话元数据")
	}
	if want := "每日巡检 · 11-19 09:00"; rec.Title != want {
		t.Fatalf("标题 = %q, want %q", rec.Title, want)
	}
	if rec.Cwd != f.root {
		t.Fatalf("cwd = %q, want %q", rec.Cwd, f.root)
	}
}
