package session

import (
	"io"
	"testing"
)

type nopTransport struct{}

func (nopTransport) Read(p []byte) (int, error)  { return 0, io.EOF }
func (nopTransport) Write(p []byte) (int, error) { return len(p), nil }
func (nopTransport) Close() error                { return nil }

// closed 必须是终态。
//
// prompt() 在写 stdin 成功后调 setState(busy)，而同一瞬间 Close() 可能已经把它置成
// closed。旧的 check-then-store 会把 closed 覆盖回 busy，而 busy 那一支不自愈：
// Reclaimable 要求 StateReady（busy 永不回收），infoByID 只把 closed 当死
// （Resume 会返回这个死壳、不再 spawn）。表现是转圈环一直转、发消息永远写不进去。
func TestClosedIsTerminal(t *testing.T) {
	s := New("11111111-2222-4333-8444-555555555555", "/tmp", nopTransport{}, nil)
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if got := s.State(); got != StateClosed {
		t.Fatalf("Close 之后 state = %q", got)
	}
	for _, st := range []string{StateBusy, StateReady, StateStarting} {
		s.setState(st)
		if got := s.State(); got != StateClosed {
			t.Fatalf("closed 之后再 setState(%q)，state 变成 %q（closed 不是终态）", st, got)
		}
	}
}
