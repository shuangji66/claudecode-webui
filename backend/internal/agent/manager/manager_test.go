package manager

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
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
