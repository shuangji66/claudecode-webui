package manager

import "testing"

// 握手中的会话不该被数两遍。
//
// createWith 把会话写进 m.sessions 在 sess.Start() 之前，而 spawning 要到 createWith
// 返回才递减——旧写法 `len(m.sessions)+m.spawning` 在整段握手期把同一条会话算成两条。
// 上限 6 时，3 条在握手 + 3 条在跑就等于「满了」，第 4 次新建拿到 ErrTooMany。
func TestSlotsExhaustedDoesNotDoubleCountSpawning(t *testing.T) {
	const limit = 6
	cases := []struct {
		sessions, spawning int
		want               bool
		why                string
	}{
		{0, 0, false, "全新"},
		{3, 3, false, "3 条在跑 + 3 条在握手 = 恰好占满，不该拒绝"},
		{5, 1, false, "5 在跑 + 1 在握手 = 6，满但不该在加法上再溢出"},
		{6, 0, true, "已满"},
		{0, 6, true, "握手中的已占满"},
		{7, 0, true, "超限（降过上限）"},
	}
	for _, c := range cases {
		if got := slotsExhausted(c.sessions, c.spawning, limit); got != c.want {
			t.Errorf("sessions=%d spawning=%d: got %v want %v（%s）",
				c.sessions, c.spawning, got, c.want, c.why)
		}
	}
	// 旧实现的行为作为对照：相加会把 {3,3} 判成满。
	if !(3+3 >= limit) {
		t.Skip("前提不成立")
	}
	t.Logf("旧写法 sessions+spawning=%d >= %d → 会误判为满", 3+3, limit)
}
