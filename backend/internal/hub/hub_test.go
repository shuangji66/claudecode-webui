package hub

import (
	"errors"
	"sync"
	"testing"
)

type fakeClient struct {
	mu     sync.Mutex
	got    []any
	failOn bool
}

func (f *fakeClient) SendJSON(v any) error {
	if f.failOn {
		return errors.New("boom")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, v)
	return nil
}

func (f *fakeClient) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.got)
}

func TestBroadcastReachesAllSubscribers(t *testing.T) {
	h := New()
	a, b := &fakeClient{}, &fakeClient{}
	h.Subscribe("s1", a)
	h.Subscribe("s1", b)

	if n := h.Broadcast("s1", "hi"); n != 0 {
		t.Fatalf("失败数 = %d", n)
	}
	if a.count() != 1 || b.count() != 1 {
		t.Fatalf("a=%d b=%d，期望各 1", a.count(), b.count())
	}
	if h.Count("s1") != 2 {
		t.Fatalf("Count = %d", h.Count("s1"))
	}
}

func TestBroadcastIsolatesTopics(t *testing.T) {
	h := New()
	a, b := &fakeClient{}, &fakeClient{}
	h.Subscribe("s1", a)
	h.Subscribe("s2", b)

	h.Broadcast("s1", "x")
	if a.count() != 1 {
		t.Fatalf("a 应收到 1 条，实际 %d", a.count())
	}
	if b.count() != 0 {
		t.Fatalf("s2 不应收到事件，实际 %d", b.count())
	}
}

func TestBroadcastDropsFailingClients(t *testing.T) {
	h := New()
	bad := &fakeClient{failOn: true}
	good := &fakeClient{}
	h.Subscribe("s1", bad)
	h.Subscribe("s1", good)

	if n := h.Broadcast("s1", "x"); n != 1 {
		t.Fatalf("失败数 = %d, want 1", n)
	}
	// 失败的订阅者应被自动移除，避免死连接长期占位。
	if h.Count("s1") != 1 {
		t.Fatalf("Count = %d, want 1", h.Count("s1"))
	}
	if good.count() != 1 {
		t.Fatalf("正常订阅者应收到: %d", good.count())
	}
}

func TestUnsubscribeRemovesTopicWhenEmpty(t *testing.T) {
	h := New()
	c := &fakeClient{}
	h.Subscribe("s1", c)
	h.Unsubscribe("s1", c)
	if h.Count("s1") != 0 {
		t.Fatalf("Count = %d", h.Count("s1"))
	}
	if len(h.Topics()) != 0 {
		t.Fatalf("空 topic 应被删除: %v", h.Topics())
	}
}

func TestSubscribeIgnoresEmptyTopic(t *testing.T) {
	h := New()
	h.Subscribe("", &fakeClient{})
	if len(h.Topics()) != 0 {
		t.Fatalf("空 topic 不应被记录: %v", h.Topics())
	}
}

func TestTopicIsolationAfterFailure(t *testing.T) {
	h := New()
	bad := &fakeClient{failOn: true}
	other := &fakeClient{}
	h.Subscribe("s1", bad)
	h.Subscribe("s2", other)

	h.Broadcast("s1", "x")
	h.Broadcast("s2", "y")

	if h.Count("s1") != 0 {
		t.Fatalf("s1 应被清空，实际 %d", h.Count("s1"))
	}
	if h.Count("s2") != 1 {
		t.Fatalf("s2 不应受影响，实际 %d", h.Count("s2"))
	}
}

// `/clear` 之后会话 id 变了：订阅要跟着搬，否则已经连着的页面从此收不到任何事件。
func TestRekeyMovesSubscribers(t *testing.T) {
	h := New()
	c := &fakeClient{}
	h.Subscribe("old", c)

	h.Rekey("old", "new")

	if h.Count("old") != 0 {
		t.Fatalf("旧 topic 上还有 %d 个订阅者", h.Count("old"))
	}
	if h.Count("new") != 1 {
		t.Fatalf("新 topic 上有 %d 个订阅者，want 1", h.Count("new"))
	}
	// 真的能收到：事件按新 topic 广播，那个连接要收到。
	h.Broadcast("new", map[string]string{"k": "v"})
	if len(c.got) != 1 {
		t.Fatalf("订阅者没收到事件（sent=%d）", len(c.got))
	}
}

// 目标 topic 上已有的订阅者要保留（别的连接），两边合并。
func TestRekeyMergesSubscribers(t *testing.T) {
	h := New()
	a, b := &fakeClient{}, &fakeClient{}
	h.Subscribe("old", a)
	h.Subscribe("new", b)

	h.Rekey("old", "new")

	if h.Count("new") != 2 {
		t.Fatalf("新 topic 上有 %d 个订阅者，want 2", h.Count("new"))
	}
	h.Broadcast("new", map[string]string{"k": "v"})
	if len(a.got) != 1 || len(b.got) != 1 {
		t.Fatalf("合并后两个连接都该收到（a=%d b=%d）", len(a.got), len(b.got))
	}
}

// 旧 topic 没有订阅者 / 同一个 topic 时是空操作。
func TestRekeyNoop(t *testing.T) {
	h := New()
	h.Rekey("missing", "new")
	h.Rekey("x", "x")
	if h.Count("new") != 0 {
		t.Fatal("不该凭空建出订阅者")
	}
}

// topicClient 是会记住「自己现在订阅哪个 topic」的连接（网关的 wsClient 就是它）。
type topicClient struct {
	fakeClient
	mu  sync.Mutex
	now string
}

func (c *topicClient) Retopic(topic string) {
	c.mu.Lock()
	c.now = topic
	c.mu.Unlock()
}

func (c *topicClient) topicNow() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// Rekey 搬完订阅要告诉连接新 topic：它断开时要用**当前**那个去 Unsubscribe。
//
// 不说的话，界面上看不出任何异常，但那条连接一断，新 topic 里就留下一条永远发不出去
// 的死订阅——之后每次广播都要失败一次才被摘掉。
func TestRekeyRetopicsClients(t *testing.T) {
	h := New()
	c := &topicClient{}
	h.Subscribe("old", c)

	h.Rekey("old", "new")

	if got := c.topicNow(); got != "new" {
		t.Fatalf("连接记住的 topic = %q，want new（断开时会按它退订）", got)
	}
	// 用新 topic 退订必须真的退掉；用旧 topic 退等于什么都没做。
	h.Unsubscribe("old", c)
	if h.Count("new") != 1 {
		t.Fatalf("用旧 topic 退订不该影响新 topic（count=%d）", h.Count("new"))
	}
	h.Unsubscribe(c.topicNow(), c)
	if h.Count("new") != 0 {
		t.Fatalf("按当前 topic 退订后仍剩 %d 个订阅者", h.Count("new"))
	}
}

// 不实现 Retopical 的连接照旧可用（Rekey 只是不通知它）。
func TestRekeyToleratesPlainClients(t *testing.T) {
	h := New()
	c := &fakeClient{}
	h.Subscribe("old", c)
	h.Rekey("old", "new")
	if h.Count("new") != 1 {
		t.Fatalf("新 topic 上有 %d 个订阅者，want 1", h.Count("new"))
	}
}
