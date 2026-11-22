package authz

import (
	"testing"
	"time"
)

// 时钟可以用测试拨动：限流全部基于时间，靠真实 sleep 测不动。
func newTestLimiter() (*LoginLimiter, *time.Time) {
	now := time.Unix(1_700_000_000, 0)
	l := NewLoginLimiter(defaultLoginMaxFailures, defaultLoginWindow, defaultLoginLockout)
	l.now = func() time.Time { return now }
	return l, &now
}

// 5 次失败后被锁，且锁定期间 Allowed 返回剩余时间。
func TestLoginLimiterLocksAfterMaxFailures(t *testing.T) {
	l, _ := newTestLimiter()
	const src = "10.0.0.5"

	for i := 1; i < defaultLoginMaxFailures; i++ {
		if locked := l.Fail(src); locked {
			t.Fatalf("第 %d 次失败就被锁了（上限 %d）", i, defaultLoginMaxFailures)
		}
		if ok, _ := l.Allowed(src); !ok {
			t.Fatalf("第 %d 次失败后不该被锁", i)
		}
	}
	// 第 5 次：进入锁定
	if locked := l.Fail(src); !locked {
		t.Fatalf("第 %d 次失败应当锁定", defaultLoginMaxFailures)
	}
	ok, wait := l.Allowed(src)
	if ok {
		t.Fatal("锁定期间应当拒绝")
	}
	if wait <= 0 || wait > defaultLoginLockout {
		t.Fatalf("等待时长 = %v，应在 (0, %v] 之间", wait, defaultLoginLockout)
	}
}

// 锁定到期后重新可以尝试。
func TestLoginLimiterUnlocksAfterLockout(t *testing.T) {
	l, now := newTestLimiter()
	const src = "10.0.0.6"
	for i := 0; i < defaultLoginMaxFailures; i++ {
		l.Fail(src)
	}
	if ok, _ := l.Allowed(src); ok {
		t.Fatal("应当处于锁定态")
	}
	*now = now.Add(defaultLoginLockout + time.Second)
	if ok, _ := l.Allowed(src); !ok {
		t.Fatal("锁定到期后应当放行")
	}
}

// 登录成功清零：用户自己想起来了，不该继续被罚。
func TestLoginLimiterSuccessResets(t *testing.T) {
	l, _ := newTestLimiter()
	const src = "10.0.0.7"
	for i := 0; i < defaultLoginMaxFailures-1; i++ {
		l.Fail(src)
	}
	l.Succeed(src)
	// 清零后应该重新有完整的 5 次额度。
	for i := 1; i < defaultLoginMaxFailures; i++ {
		if locked := l.Fail(src); locked {
			t.Fatalf("成功登录清零后，第 %d 次失败不该锁定", i)
		}
	}
}

// 按来源隔离：一个人输错不该把别人锁在门外。
func TestLoginLimiterIsPerSource(t *testing.T) {
	l, _ := newTestLimiter()
	for i := 0; i < defaultLoginMaxFailures; i++ {
		l.Fail("10.0.0.8")
	}
	if ok, _ := l.Allowed("10.0.0.8"); ok {
		t.Fatal("被爆破的来源应当被锁")
	}
	if ok, _ := l.Allowed("10.0.0.9"); !ok {
		t.Fatal("另一个来源不该受牵连")
	}
}

// 零星输错在窗口过后重新计数：几个月里手滑几次不该累积到锁死。
func TestLoginLimiterWindowExpires(t *testing.T) {
	l, now := newTestLimiter()
	const src = "10.0.0.10"
	for i := 0; i < defaultLoginMaxFailures-1; i++ {
		l.Fail(src)
	}
	*now = now.Add(defaultLoginWindow + time.Second)
	// 窗口过后从 0 开始：再失败 4 次也不该锁。
	for i := 1; i < defaultLoginMaxFailures; i++ {
		if locked := l.Fail(src); locked {
			t.Fatalf("窗口过期后第 %d 次失败不该锁定", i)
		}
	}
}

// 表不能随不同来源无限增长：过期条目要在后续 Fail 里被清掉。
func TestLoginLimiterPrunesStaleEntries(t *testing.T) {
	l, now := newTestLimiter()
	for i := 0; i < 50; i++ {
		l.Fail("10.0.1." + itoa(i))
	}
	if got := len(l.attempts); got == 0 {
		t.Fatal("应当有记录")
	}
	*now = now.Add(defaultLoginWindow + time.Minute)
	// 任意一次 Fail 触发惰性清理。
	l.Fail("10.0.2.1")
	if got := len(l.attempts); got > 2 {
		t.Fatalf("过期条目没被清掉：还剩 %d 条", got)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
