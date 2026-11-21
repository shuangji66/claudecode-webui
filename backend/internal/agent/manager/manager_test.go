package manager

import (
	"os"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ccweb/backend/internal/agent/process"
	"ccweb/backend/internal/agent/session"
	"ccweb/backend/internal/settings"
)

func TestNewUUIDAndValidation(t *testing.T) {
	id, err := newUUID()
	if err != nil {
		t.Fatal(err)
	}
	if !validUUID(id) {
		t.Fatalf("newUUID 生成的不是合法 UUID: %q", id)
	}
	if id[14] != '4' {
		t.Fatalf("UUID 版本位 = %c, want 4", id[14])
	}
	for _, bad := range []string{"", "not-a-uuid", "../../etc/passwd", "11111111-2222-3333-4444-55555555555"} {
		if validUUID(bad) {
			t.Fatalf("%q 不应通过校验", bad)
		}
	}
}

// 同一个 key 的并发创建只应真正执行一次，其余调用共享结果。
//
// 这是把 spawn+握手移出 createMu 之后仍然「不多起 claude」的保证。
func TestCreateOnceSharesConcurrentResult(t *testing.T) {
	m := &Manager{creating: make(map[string]*pendingCreate)}
	var calls atomic.Int32
	const n = 5

	start := make(chan struct{})
	infos := make([]Info, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			info, err := m.createOnce("id:same", func() (Info, error) {
				calls.Add(1)
				time.Sleep(30 * time.Millisecond)
				return Info{ID: "same", Cwd: "/tmp/x"}, nil
			})
			if err != nil {
				t.Errorf("createOnce: %v", err)
			}
			infos[i] = info
		}(i)
	}
	close(start)
	wg.Wait()

	if got := calls.Load(); got != 1 {
		t.Fatalf("创建执行了 %d 次，want 1", got)
	}
	for i, info := range infos {
		if info.ID != "same" {
			t.Fatalf("第 %d 个调用拿到 %+v", i, info)
		}
	}
	// 完成后登记表要清空，后续调用才能重新创建。
	m.createMu.Lock()
	left := len(m.creating)
	m.createMu.Unlock()
	if left != 0 {
		t.Fatalf("creating 残留 %d 项", left)
	}
}

// Fork 的 id 校验必须在起进程之前完成：非法 id 不能把 claude 拉起来。
func TestForkRejectsInvalidID(t *testing.T) {
	m := &Manager{}
	if _, err := m.Fork("not-a-uuid", "/tmp", "", ""); err == nil {
		t.Fatal("非法 id 应报错")
	}
}

// StartFresh 用同一个 id 新建（对话在 claude 那边没有转录时的退路）：
// 校验同样必须在起进程之前完成，否则会留下一个来路不明的 id。
func TestStartFreshRejectsInvalidInput(t *testing.T) {
	m := &Manager{}
	if _, err := m.StartFresh("not-a-uuid", "/tmp", "", ""); err == nil {
		t.Fatal("非法 id 应报错")
	}
	id, err := newUUID()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.StartFresh(id, "/definitely/not/here", "", ""); err == nil {
		t.Fatal("不存在的目录应报错")
	}
}

// 删除某个 claude 版本前，要能列出还跑在这个二进制上的会话，并把它们真正结束。
//
// 用「复制一份 /bin/sh 到版本目录冒充 claude」的方式造两个不同 bin 的进程：
// Proc.bin 就是 Spawn 时传的路径，这样才测得到按二进制路径筛选的逻辑。
func TestSessionsUsingAndClose(t *testing.T) {
	dir := t.TempDir()
	fakeBin := func(name string) string {
		t.Helper()
		src, err := os.ReadFile("/bin/sh")
		if err != nil {
			t.Skipf("没有 /bin/sh，跳过：%v", err)
		}
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, src, 0o755); err != nil {
			t.Fatalf("写测试二进制: %v", err)
		}
		return p
	}
	spawn := func(bin string) *process.Proc {
		t.Helper()
		p, err := process.Spawn(bin, []string{"-c", "sleep 30"}, dir, nil)
		if err != nil {
			t.Fatalf("Spawn(%s): %v", bin, err)
		}
		t.Cleanup(func() { _ = p.Close() })
		return p
	}

	binA, binB := fakeBin("claude-a"), fakeBin("claude-b")
	procA, procB := spawn(binA), spawn(binB)

	m := &Manager{
		sessions:        map[string]*session.Session{},
		procs:           map[string]*process.Proc{},
		metas:           map[string]meta{},
		closingSessions: map[string]chan struct{}{},
	}
	m.sessions["sess-a"] = session.New("sess-a", dir, procA, func(session.Event) {})
	m.procs["sess-a"] = procA
	m.sessions["sess-b"] = session.New("sess-b", dir, procB, func(session.Event) {})
	m.procs["sess-b"] = procB
	// 已关闭但还没被 pruneClosed 摘掉的会话不再持有进程，不算「使用中」。
	_ = m.sessions["sess-b"].Close()

	if got := m.SessionsUsing(binA); len(got) != 1 || got[0] != "sess-a" {
		t.Fatalf("SessionsUsing(binA) = %v, want [sess-a]", got)
	}
	if got := m.SessionsUsing(binB); len(got) != 0 {
		t.Fatalf("已关闭的会话不应算使用中: %v", got)
	}

	if closed := m.CloseSessionsUsing(binA); len(closed) != 1 || closed[0] != "sess-a" {
		t.Fatalf("CloseSessionsUsing = %v, want [sess-a]", closed)
	}
	if got := m.SessionsUsing(binA); len(got) != 0 {
		t.Fatalf("结束后不应再列出: %v", got)
	}

	// 返回时进程必须已经退出：调用方紧接着就要删掉这个二进制。
	gone := make(chan struct{})
	go func() {
		_ = procA.Wait()
		close(gone)
	}()
	select {
	case <-gone:
	case <-time.After(3 * time.Second):
		t.Fatal("CloseSessionsUsing 返回时进程还在跑")
	}
}

// 任务清单工具固定放行，且不能污染装配层交回来的切片（它有富余容量时会被 append 写进底层数组）。
func TestSessionToolRulesAlwaysAllowsTaskTools(t *testing.T) {
	allow, deny := sessionToolRules(nil)
	for _, want := range taskToolNames {
		if !slices.Contains(allow, want) {
			t.Fatalf("--allowedTools 缺少 %s：%v", want, allow)
		}
	}
	if len(deny) != 0 {
		t.Fatalf("没有装配规则时不该有禁用项：%v", deny)
	}

	shared := make([]string, 2, 8)
	shared[0], shared[1] = "mcp__a__b", "mcp__c__d"
	allow, deny = sessionToolRules(func() ([]string, []string) { return shared, []string{"WebSearch"} })
	if len(shared) != 2 || shared[0] != "mcp__a__b" || shared[1] != "mcp__c__d" {
		t.Fatalf("装配层的切片被改写了：%v", shared)
	}
	if !slices.Contains(allow, "mcp__a__b") || !slices.Contains(allow, taskToolNames[0]) {
		t.Fatalf("规则与任务清单工具都要保留：%v", allow)
	}
	if len(deny) != 1 || deny[0] != "WebSearch" {
		t.Fatalf("禁用项应原样带出：%v", deny)
	}
}

// 空闲回收阈值的唯一来源是设置项；没有 store（单测）时回落到默认值。
//
// 这一条挡的是「界面上改成 45 分钟，进程仍按启动时那份配置回收」——
// 阈值必须是每次扫描现读，不能是启动快照。
func TestIdleTimeoutReadsSettingsLive(t *testing.T) {
	store, err := settings.Open(filepath.Join(t.TempDir(), "settings.json"))
	if err != nil {
		t.Fatalf("settings.Open: %v", err)
	}
	m := &Manager{store: store}

	if got := m.idleTimeout(); got != 10*time.Minute {
		t.Fatalf("默认应取设置项 10 分钟，实际 %s", got)
	}

	want := 45
	if _, err := store.Apply(settings.Patch{IdleMinutes: &want}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if got := m.idleTimeout(); got != 45*time.Minute {
		t.Fatalf("改完设置应立刻生效，实际 %s", got)
	}

	// 没接 store（单测装配）时回落到默认值，不会算出 0 让回收循环疯转。
	bare := &Manager{}
	if got := bare.idleTimeout(); got != 10*time.Minute {
		t.Fatalf("没有 store 时应回落到默认值，实际 %s", got)
	}
}

// 常驻会话数的唯一来源也是设置项：每次新建现读，没有 store 时回落到默认值。
//
// 挡的是「设置页改成 6、实际仍按启动快照拦」：上限必须在 createWith 里现读。
func TestMaxSessionsReadsSettingsLive(t *testing.T) {
	store, err := settings.Open(filepath.Join(t.TempDir(), "settings.json"))
	if err != nil {
		t.Fatalf("settings.Open: %v", err)
	}
	m := &Manager{store: store}

	if got := m.maxSessions(); got != settings.DefaultMaxSessions {
		t.Fatalf("默认应取设置项 %d，实际 %d", settings.DefaultMaxSessions, got)
	}

	want := 12
	if _, err := store.Apply(settings.Patch{MaxSessions: &want}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if got := m.maxSessions(); got != 12 {
		t.Fatalf("改完设置应立刻生效，实际 %d", got)
	}

	// 没接 store（单测装配）时回落到默认值，不能是 0——那会让所有新建都被挡住。
	bare := &Manager{}
	if got := bare.maxSessions(); got != settings.DefaultMaxSessions {
		t.Fatalf("没有 store 时应回落到默认值，实际 %d", got)
	}
}

// `/clear` 之后 manager 的键要换到新 id，而且**不能顺手改会话对象的 ID 字段**：
// 那个字段是外部按 id 找会话的键（sessions/procs/metas 三张表都用它），改了会让
// 表与对象对不上；真正的「当前 id」由 Session.CurrentID 持锁维护。
//
// 同时验证事件路由：换 id 之后事件必须按**新** id 上报（hub 的订阅已经搬过去了），
// 而 `session.replaced` 本身必须按**旧** id 上报（订阅还没搬）。
func TestRenameKeepsSessionIDFieldAndRoutesEvents(t *testing.T) {
	type got struct {
		topic string
		kind  string
	}
	var mu sync.Mutex
	var events []got

	// 直接用 session.New 造一个不握手的会话：这里只测 Rename 的登记表与路由，
	// 不需要真的起 claude。
	sess := session.New("old", t.TempDir(), nil, nil)
	m := &Manager{
		sessions:        map[string]*session.Session{"old": sess},
		procs:           map[string]*process.Proc{},
		metas:           map[string]meta{"old": {Provider: "p", Model: "m", Effort: "high"}},
		closingSessions: map[string]chan struct{}{},
		emit: func(topic string, ev session.Event) {
			mu.Lock()
			events = append(events, got{topic: topic, kind: ev.Kind})
			mu.Unlock()
		},
	}

	if ok := m.Rename("old", "new"); !ok {
		t.Fatal("Rename 应当成功")
	}
	if _, ok := m.sessions["old"]; ok {
		t.Fatal("旧 id 上还挂着会话")
	}
	if got, ok := m.sessions["new"]; !ok || got != sess {
		t.Fatal("新 id 上应当是同一个会话对象（不重启进程）")
	}
	if got := m.metas["new"]; got.Effort != "high" {
		t.Fatalf("meta 没跟着搬: %+v", got)
	}
	if sess.ID != "old" {
		t.Fatalf("Rename 不该改 Session.ID（得到 %q）：当前 id 由 CurrentID 持锁维护", sess.ID)
	}

	// 新 id 上能按 id 取回同一个会话（后续 prompt 走的是这条路径）。
	if got, ok := m.Get("new"); !ok || got != sess {
		t.Fatal("Get(new) 应当返回同一个会话对象")
	}
	if _, ok := m.Get("old"); ok {
		t.Fatal("Get(old) 不该再取到会话")
	}
	// List 报的是会话**当前**的 id（CurrentID）。这里会话自己还没收到带新 id 的
	// init，所以它仍然自认旧 id——真实顺序是「会话先从 init 学到新 id（并广播
	// session.replaced），装配层再 Rename」，那时两边一致。Rename 只负责换键。
	if list := m.List(); len(list) != 1 || list[0].ID != "old" {
		t.Fatalf("List = %+v（会话还没见过新 id，应当仍报旧 id）", list)
	}

	// 目标 id 已被占用时不搬（会摘掉另一个进程）。
	sess2 := session.New("other", t.TempDir(), nil, nil)
	m.sessions["taken"] = sess2
	if m.Rename("new", "taken") {
		t.Fatal("目标 id 已存在时不该搬")
	}
	if m.sessions["new"] != sess {
		t.Fatal("搬失败时原登记不该被改动")
	}
}
