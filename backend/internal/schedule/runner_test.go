package schedule

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	st, err := Open(filepath.Join(t.TempDir(), "schedules.json"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return st
}

func TestStorePersists(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(filepath.Join(dir, "schedules.json"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	next := time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)
	created, err := st.Create(Task{
		Name:      "每日巡检",
		Prompt:    "跑测试",
		Target:    Target{Kind: TargetNewEach},
		Workspace: "/w",
		Rule:      Rule{Kind: KindDaily, Time: "09:00"},
		NextRun:   &next,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if created.ID == "" {
		t.Fatal("Create 应当补上 id")
	}
	if created.Status != StatusActive {
		t.Fatalf("默认状态 = %q, want active", created.Status)
	}

	// 换一个 Store 实例读同一份文件：落盘要能读回来。
	again, err := Open(filepath.Join(dir, "schedules.json"))
	if err != nil {
		t.Fatalf("重新 Open: %v", err)
	}
	got, ok := again.Get(created.ID)
	if !ok {
		t.Fatal("重新打开后找不到任务")
	}
	if got.Name != "每日巡检" || got.Prompt != "跑测试" || got.NextRun == nil || !got.NextRun.Equal(next) {
		t.Fatalf("读回的任务不对: %+v", got)
	}

	// 改一个字段；fn 报错时不能落盘。
	if _, err := again.Update(created.ID, func(x *Task) error {
		x.Name = "改名了"
		return errors.New("不保存")
	}); err == nil {
		t.Fatal("Update 应当把 fn 的错误带出来")
	}
	if cur, _ := again.Get(created.ID); cur.Name != "每日巡检" {
		t.Fatalf("fn 失败后不该改内存: %q", cur.Name)
	}
	if _, err := again.Update(created.ID, func(x *Task) error {
		x.Name = "改名了"
		return nil
	}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if cur, _ := again.Get(created.ID); cur.Name != "改名了" {
		t.Fatalf("Update 没生效: %q", cur.Name)
	}

	if _, err := again.Delete(created.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, ok := again.Get(created.ID); ok {
		t.Fatal("删除后还能查到")
	}
	if _, err := again.Delete(created.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("重复删除应当返回 ErrNotFound，得到 %v", err)
	}
}

func TestStoreRejectsBrokenFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "schedules.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(path); err == nil {
		t.Fatal("坏文件应当报错，而不是静默当成空列表（那会丢任务）")
	}
}

// 到期投递：记一条投递、推进下一次、首次新建的对话回填到 target。
func TestRunnerDeliversAndAdvances(t *testing.T) {
	st := newTestStore(t)
	base := time.Date(2026, 11, 18, 9, 0, 0, 0, time.UTC)
	next := base.Add(-time.Minute)
	task, err := st.Create(Task{
		Name:    "每小时",
		Prompt:  "干点活",
		Target:  Target{Kind: TargetNewReuse},
		Rule:    Rule{Kind: KindHours, Interval: 1},
		NextRun: &next,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	var delivered int
	r := NewRunner(st, func(_ context.Context, tk Task, fire time.Time) (string, error) {
		delivered++
		if tk.ID != task.ID {
			t.Fatalf("投递的任务 id = %q, want %q", tk.ID, task.ID)
		}
		if !fire.Equal(next) {
			t.Fatalf("fire = %v, want %v", fire, next)
		}
		return "conv-1", nil
	}, nil)
	r.now = func() time.Time { return base }

	if n := r.Tick(context.Background()); n != 1 {
		t.Fatalf("本轮投递 %d 条, want 1", n)
	}
	if delivered != 1 {
		t.Fatalf("deliver 被调用 %d 次", delivered)
	}

	got, _ := st.Get(task.ID)
	if got.LastDeliveredAt == nil || !got.LastDeliveredAt.Equal(base) {
		t.Fatalf("LastDeliveredAt = %v", got.LastDeliveredAt)
	}
	if got.NextRun == nil || !got.NextRun.Equal(base.Add(time.Hour)) {
		t.Fatalf("NextRun = %v, want %v", got.NextRun, base.Add(time.Hour))
	}
	if got.Target.ConversationID != "conv-1" {
		t.Fatalf("首次投递应回填对话 id，得到 %q", got.Target.ConversationID)
	}
	if len(got.Deliveries) != 1 || got.Deliveries[0].ConversationID != "conv-1" || got.Deliveries[0].Error != "" {
		t.Fatalf("投递记录不对: %+v", got.Deliveries)
	}
	if got.Status != StatusActive {
		t.Fatalf("重复任务不该结束，状态 = %q", got.Status)
	}
}

// 一次性任务投完就结束，不再安排下一次。
func TestRunnerEndsOnce(t *testing.T) {
	st := newTestStore(t)
	base := time.Date(2026, 11, 18, 9, 0, 0, 0, time.UTC)
	next := base.Add(-time.Hour)
	task, err := st.Create(Task{
		Name:    "只跑一次",
		Prompt:  "你好",
		Target:  Target{Kind: TargetNewEach},
		Rule:    Rule{Kind: KindOnce, At: next.Format(time.RFC3339)},
		NextRun: &next,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	r := NewRunner(st, func(context.Context, Task, time.Time) (string, error) { return "c", nil }, nil)
	r.now = func() time.Time { return base }
	if n := r.Tick(context.Background()); n != 1 {
		t.Fatalf("本轮投递 %d 条", n)
	}
	got, _ := st.Get(task.ID)
	if got.Status != StatusEnded || got.NextRun != nil {
		t.Fatalf("一次性任务应当结束: status=%q next=%v", got.Status, got.NextRun)
	}
	// 再 tick 一次不会再投。
	if n := r.Tick(context.Background()); n != 0 {
		t.Fatalf("已结束的任务不该再投，本轮 %d 条", n)
	}
}

// 刚投递过的任务要等最小间隔，避免「立即执行」之后又马上被 tick 追一次。
func TestRunnerRespectsGap(t *testing.T) {
	st := newTestStore(t)
	base := time.Date(2026, 11, 18, 9, 0, 0, 0, time.UTC)
	next := base.Add(-time.Minute)
	last := base.Add(-10 * time.Second)
	task, err := st.Create(Task{
		Name:            "每分钟",
		Prompt:          "x",
		Target:          Target{Kind: TargetNewEach},
		Rule:            Rule{Kind: KindMinutes, Interval: 1},
		NextRun:         &next,
		LastDeliveredAt: &last,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	r := NewRunner(st, func(context.Context, Task, time.Time) (string, error) {
		t.Fatal("间隔内不该投递")
		return "", nil
	}, nil)
	r.now = func() time.Time { return base }
	if n := r.Tick(context.Background()); n != 0 {
		t.Fatalf("本轮投递 %d 条, want 0", n)
	}
	if got, _ := st.Get(task.ID); got.NextRun == nil || !got.NextRun.Equal(next) {
		t.Fatalf("跳过时不该改 NextRun: %v", got.NextRun)
	}
}

// 投递失败也要推进下一次并记下原因，否则永久失败会每 30 秒刷一遍。
func TestRunnerRecordsFailureAndAdvances(t *testing.T) {
	st := newTestStore(t)
	base := time.Date(2026, 11, 18, 9, 0, 0, 0, time.UTC)
	next := base.Add(-time.Minute)
	task, err := st.Create(Task{
		Name:    "会失败",
		Prompt:  "x",
		Target:  Target{Kind: TargetConversation, ConversationID: "gone"},
		Rule:    Rule{Kind: KindHours, Interval: 1},
		NextRun: &next,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	r := NewRunner(st, func(context.Context, Task, time.Time) (string, error) {
		return "", errors.New("工作区已移除")
	}, nil)
	r.now = func() time.Time { return base }
	if n := r.Tick(context.Background()); n != 0 {
		t.Fatalf("失败不该计入投递数，本轮 %d", n)
	}
	got, _ := st.Get(task.ID)
	if got.LastError != "工作区已移除" {
		t.Fatalf("LastError = %q", got.LastError)
	}
	if got.NextRun == nil || !got.NextRun.Equal(base.Add(time.Hour)) {
		t.Fatalf("失败也要推进下一次，NextRun = %v", got.NextRun)
	}
	if len(got.Deliveries) != 1 || got.Deliveries[0].Error == "" {
		t.Fatalf("应当留下一条带错误的投递记录: %+v", got.Deliveries)
	}
}

// 立即执行：记录一次投递，但不改动计划时间；间隔内再来一次要被挡住。
func TestRunnerRunNow(t *testing.T) {
	st := newTestStore(t)
	base := time.Date(2026, 11, 18, 9, 0, 0, 0, time.UTC)
	next := base.Add(2 * time.Hour)
	task, err := st.Create(Task{
		Name:    "手动",
		Prompt:  "跑了",
		Target:  Target{Kind: TargetConversation, ConversationID: "conv-9"},
		Rule:    Rule{Kind: KindHours, Interval: 4},
		NextRun: &next,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	calls := 0
	r := NewRunner(st, func(_ context.Context, _ Task, fire time.Time) (string, error) {
		calls++
		if !fire.Equal(base) {
			t.Fatalf("立即执行的 fire = %v, want now", fire)
		}
		return "conv-9", nil
	}, nil)
	r.now = func() time.Time { return base }

	if err := r.RunNow(context.Background(), task.ID); err != nil {
		t.Fatalf("RunNow: %v", err)
	}
	got, _ := st.Get(task.ID)
	if got.NextRun == nil || !got.NextRun.Equal(next) {
		t.Fatalf("立即执行不该改计划时间: %v", got.NextRun)
	}
	if len(got.Deliveries) != 1 {
		t.Fatalf("投递记录 %d 条, want 1", len(got.Deliveries))
	}

	if err := r.RunNow(context.Background(), task.ID); !errors.Is(err, ErrTooSoon) {
		t.Fatalf("间隔内再次执行应当 ErrTooSoon，得到 %v", err)
	}
	if calls != 1 {
		t.Fatalf("deliver 被调用 %d 次, want 1", calls)
	}
	if err := r.RunNow(context.Background(), "不存在的 id"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("未知 id 应当 ErrNotFound，得到 %v", err)
	}
}
