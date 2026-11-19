package session

import (
	"encoding/json"
	"sync"
	"testing"
	"time"
)

// 重放缓冲是「断线重连补空缺」的唯一依据：序号必须单调、事件必须能原样取回。
func TestReplayReturnsEventsAfterSince(t *testing.T) {
	s := New("s1", "/tmp", &duplex{}, func(Event) {})
	for i := 0; i < 5; i++ {
		s.emitData(KindCLI, map[string]int{"n": i})
	}
	if got := s.Seq(); got != 5 {
		t.Fatalf("Seq = %d, want 5", got)
	}

	events, ok := s.Replay(s.Epoch(), 2)
	if !ok {
		t.Fatal("缓冲里全都有，应判为可补齐")
	}
	if len(events) != 3 {
		t.Fatalf("补发 %d 条，want 3", len(events))
	}
	for i, ev := range events {
		if ev.Seq != uint64(i+3) {
			t.Fatalf("第 %d 条的 seq = %d，want %d", i, ev.Seq, i+3)
		}
		var payload map[string]int
		if err := json.Unmarshal(ev.Data, &payload); err != nil {
			t.Fatalf("解析载荷: %v", err)
		}
		if payload["n"] != i+2 {
			t.Fatalf("第 %d 条的载荷 = %v", i, payload)
		}
	}
}

// 水位已经追平：补 0 条，但仍然是「可补齐」（不要误判成 resync）。
func TestReplayUpToDateIsStillOK(t *testing.T) {
	s := New("s1", "/tmp", &duplex{}, func(Event) {})
	s.emitData(KindCLI, map[string]int{"n": 1})
	events, ok := s.Replay(s.Epoch(), s.Seq())
	if !ok {
		t.Fatal("水位追平不该判为补不齐")
	}
	if len(events) != 0 {
		t.Fatalf("补发 %d 条，want 0", len(events))
	}
}

// 空缺已经被缓冲淘汰：必须判为补不齐，由前端整份重放转录。
func TestReplayGivesUpWhenGapEvicted(t *testing.T) {
	prevEvents, prevBytes := replayMaxEvents, replayMaxBytes
	replayMaxEvents, replayMaxBytes = 3, 1<<20
	t.Cleanup(func() { replayMaxEvents, replayMaxBytes = prevEvents, prevBytes })

	s := New("s1", "/tmp", &duplex{}, func(Event) {})
	for i := 0; i < 6; i++ {
		s.emitData(KindCLI, map[string]int{"n": i})
	}
	// 只要第 1 条之后的部分：前 3 条已经被切掉。
	if _, ok := s.Replay(s.Epoch(), 1); ok {
		t.Fatal("缺口超过缓冲时必须判为补不齐")
	}
	// 缓冲里还在的那一段仍然能补。
	if events, ok := s.Replay(s.Epoch(), 4); !ok || len(events) != 2 {
		t.Fatalf("events=%d ok=%v，want 2/true", len(events), ok)
	}
}

// 进程被重开过（用同一个 UUID 又 --resume 了）：seq 从头开始，光比序号会把
// 新进程的前几条当成老进程的续集拼上去。epoch 对不上必须判为补不齐。
func TestReplayRejectsDifferentEpoch(t *testing.T) {
	a := New("s1", "/tmp", &duplex{}, func(Event) {})
	a.emitData(KindCLI, map[string]int{"n": 1})
	b := New("s1", "/tmp", &duplex{}, func(Event) {})
	b.emitData(KindCLI, map[string]int{"n": 2})

	if a.Epoch() == b.Epoch() {
		t.Fatal("两个会话对象的 epoch 不该相同")
	}
	if _, ok := b.Replay(a.Epoch(), 0); ok {
		t.Fatal("epoch 变了必须判为补不齐")
	}
}

// 字节上限同样要能触发淘汰：一次工具结果可以有几百 KB，条数上限挡不住。
func TestReplayEvictsByBytes(t *testing.T) {
	prevEvents, prevBytes := replayMaxEvents, replayMaxBytes
	replayMaxEvents, replayMaxBytes = 1024, 300
	t.Cleanup(func() { replayMaxEvents, replayMaxBytes = prevEvents, prevBytes })

	s := New("s1", "/tmp", &duplex{}, func(Event) {})
	// 每条载荷 100 字节左右，超过 3 条就会触发字节淘汰。
	for i := 0; i < 6; i++ {
		s.emitData(KindCLI, map[string]string{"pad": string(make([]byte, 100))})
	}
	if _, ok := s.Replay(s.Epoch(), 0); ok {
		t.Fatal("字节超限后早期事件应已被淘汰")
	}
	last := s.Seq()
	if _, ok := s.Replay(s.Epoch(), last-1); !ok {
		t.Fatal("最近的这一段仍应能补")
	}
}

// 序号必须严格递增：前端靠它去重与排序（补发帧与实时广播会交错到达）。
func TestEmitDataAssignsMonotonicSeq(t *testing.T) {
	var got []uint64
	s := New("s1", "/tmp", &duplex{}, func(ev Event) { got = append(got, ev.Seq) })
	for i := 0; i < 3; i++ {
		s.emitData(KindSessionState, map[string]string{"state": "ready"})
	}
	for i := 1; i < len(got); i++ {
		if got[i] <= got[i-1] {
			t.Fatalf("seq 不单调: %v", got)
		}
	}
}

// 并发 emit（读循环 + 审批回包）不能把序号写乱。
func TestEmitDataConcurrentSeqIsUnique(t *testing.T) {
	var mu sync.Mutex
	seen := map[uint64]bool{}
	dup := false
	s := New("s1", "/tmp", &duplex{}, func(ev Event) {
		mu.Lock()
		defer mu.Unlock()
		if seen[ev.Seq] {
			dup = true
		}
		seen[ev.Seq] = true
	})
	done := make(chan struct{})
	for i := 0; i < 4; i++ {
		go func() {
			for j := 0; j < 50; j++ {
				s.emitData(KindCLI, map[string]int{"n": j})
			}
			done <- struct{}{}
		}()
	}
	for i := 0; i < 4; i++ {
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Fatal("并发 emit 超时")
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if dup {
		t.Fatal("序号重复")
	}
	if len(seen) != 200 {
		t.Fatalf("事件数 = %d, want 200", len(seen))
	}
}
