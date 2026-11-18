package manager

import (
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ccweb/backend/internal/agent/process"
	"ccweb/backend/internal/agent/session"
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
