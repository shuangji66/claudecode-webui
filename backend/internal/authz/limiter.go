package authz

import (
	"sync"
	"time"
)

// 登录失败限流。
//
// 为什么必须有：`handleLogin` 每次尝试都要跑一次 PBKDF2（21 万轮，约几十毫秒
// CPU）。端口访问对局域网开放，没有限流时，拿到这个端口的人可以一边爆破密码、
// 一边用几十个并发请求把 NAS 的 CPU 打满——后者甚至不需要猜对密码。
//
// 口径是「按来源计数」而不是全局计数：
//   - 全局计数会让一个人输错就把所有人锁在门外（多设备 + 忘记密码的场景很常见）；
//   - 按来源只需要挡住「同一个来源的连续尝试」，这正是爆破的形态。
//
// 规则：
//   - 同一次登录窗口内累计失败 MaxLoginFailures(5) 次就锁定 LockoutDuration(1 分钟)；
//   - 锁定期间**不再校验密码**（直接拒绝），所以也就不会消耗 PBKDF2；
//   - 登录成功立刻清零（用户自己回想起来了，不该继续被罚）；
//   - 窗口内失败次数不足上限时，ResetWindow(15 分钟) 后重新计数——避免
//     「几个月里零星输错几次」累积到锁死。
//
// 只在内存里：进程重启即清零。攻击者重启不了进程，而这条限制的目的是挡住
// 在线爆破，不是长期记账；为它落盘反而会让「忘记密码后重启应用」变成一种绕法。
type LoginLimiter struct {
	maxFailures int
	window      time.Duration
	lockout     time.Duration
	now         func() time.Time

	mu       sync.Mutex
	attempts map[string]*loginAttempt
}

type loginAttempt struct {
	failures   int
	firstAt    time.Time
	lastAt     time.Time
	lockedTill time.Time
}

// 默认参数。`maxFailures` 取 5：够挡住手工乱试，又不至于让手滑的用户多等。
const (
	defaultLoginMaxFailures = 5
	defaultLoginWindow      = 15 * time.Minute
	defaultLoginLockout     = time.Minute
)

// NewLoginLimiter 构造限流器（0 值参数按默认值处理）。
func NewLoginLimiter(maxFailures int, window, lockout time.Duration) *LoginLimiter {
	if maxFailures <= 0 {
		maxFailures = defaultLoginMaxFailures
	}
	if window <= 0 {
		window = defaultLoginWindow
	}
	if lockout <= 0 {
		lockout = defaultLoginLockout
	}
	return &LoginLimiter{
		maxFailures: maxFailures,
		window:      window,
		lockout:     lockout,
		now:         time.Now,
		attempts:    make(map[string]*loginAttempt),
	}
}

// Allowed 报告该来源现在能不能尝试登录；返回的 duration 是还需要等待多久
// （只在被锁时非零），供接口文案使用。
//
// 它**不改状态**：允许与否的记账在 Fail / Succeed 里。
func (l *LoginLimiter) Allowed(key string) (bool, time.Duration) {
	if l == nil {
		return true, 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	a, ok := l.attempts[key]
	if !ok {
		return true, 0
	}
	now := l.now()
	if now.Before(a.lockedTill) {
		return false, a.lockedTill.Sub(now)
	}
	return true, 0
}

// Fail 记一次失败；返回是否因此进入锁定。
func (l *LoginLimiter) Fail(key string) (locked bool) {
	if l == nil {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	a, ok := l.attempts[key]
	// 窗口过期（且不在锁定期）就从头计数：零星输错不该越攒越多。
	if !ok || (now.Sub(a.firstAt) > l.window && !now.Before(a.lockedTill)) {
		a = &loginAttempt{firstAt: now}
		l.attempts[key] = a
	}
	a.failures++
	a.lastAt = now
	// 惰性清理：表的大小只与「不同来源数」有关，正常部署很小；长期运行或被换
	// IP 刷时才需要这道兜底，否则它会一直长。
	l.prune(now)
	if a.failures >= l.maxFailures {
		a.lockedTill = now.Add(l.lockout)
		// 锁定后重新开始计数：解锁时不该立刻又只差一次就再被锁。
		a.failures = 0
		a.firstAt = now
		return true
	}
	return false
}

// Succeed 在密码校验通过后清零该来源的失败记录。
func (l *LoginLimiter) Succeed(key string) {
	if l == nil {
		return
	}
	l.mu.Lock()
	delete(l.attempts, key)
	l.mu.Unlock()
}

// LockoutDuration 返回一次锁定的时长（接口文案要用它说「请 N 秒后再试」）。
func (l *LoginLimiter) LockoutDuration() time.Duration {
	if l == nil {
		return defaultLoginLockout
	}
	return l.lockout
}

// prune 清掉已经不用的条目。表的大小只与「不同来源数」有关，正常部署里很小；
// 但长期运行（或被人换了 IP 刷）时也要有界，所以每次 Fail 顺带做一次惰性清理。
func (l *LoginLimiter) prune(now time.Time) {
	for k, a := range l.attempts {
		if now.Before(a.lockedTill) {
			continue
		}
		if now.Sub(a.firstAt) > l.window {
			delete(l.attempts, k)
		}
	}
}
