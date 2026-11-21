package authz

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func mustHash(t *testing.T, pwd string) string {
	t.Helper()
	hash, err := HashPassword(pwd)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	return hash
}

func TestDisabledAllowsEverything(t *testing.T) {
	g := New("")
	for _, ch := range []Channel{ChannelUnix, ChannelTCP} {
		if g.Required(ch) {
			t.Fatalf("未开端口访问时 %v 不应要求鉴权", ch)
		}
		if !g.Check(ch, "", "") {
			t.Fatalf("未启用鉴权时 %v 应放行", ch)
		}
		if mode := g.Mode(ch); mode != "none" {
			t.Fatalf("Mode(%v) = %q, want none", ch, mode)
		}
	}
}

func TestBearerHeader(t *testing.T) {
	g := New("s3cret")
	if !g.Required(ChannelUnix) || !g.Required(ChannelTCP) {
		t.Fatal("环境变量 token 在两条通道上都应要求鉴权")
	}
	cases := []struct {
		name, header, query string
		want                bool
	}{
		{"正确 Bearer", "Bearer s3cret", "", true},
		{"大小写不敏感", "bearer s3cret", "", true},
		{"错误 token", "Bearer nope", "", false},
		{"缺少头", "", "", false},
		{"非 Bearer 方案", "Basic s3cret", "", false},
		{"query token", "", "s3cret", true},
		{"query 错误", "", "nope", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, ch := range []Channel{ChannelUnix, ChannelTCP} {
				if got := g.Check(ch, tc.header, tc.query); got != tc.want {
					t.Fatalf("Check(%v,%q,%q) = %v, want %v", ch, tc.header, tc.query, got, tc.want)
				}
			}
		})
	}
}

func TestEnvTokenMatches(t *testing.T) {
	g := New("secret")
	if !g.EnvTokenMatches("secret") {
		t.Fatal("正确令牌应匹配")
	}
	if g.EnvTokenMatches("wrong") || g.EnvTokenMatches("") {
		t.Fatal("错误/空令牌不应匹配")
	}
	if New("").EnvTokenMatches("") {
		t.Fatal("未配置令牌时任何值都不应匹配")
	}
}

func TestQueryTokenTakesPrecedence(t *testing.T) {
	g := New("right")
	// WS 场景：浏览器无法设置自定义头，只能靠 query。
	if !g.Check(ChannelUnix, "Bearer wrong", "right") {
		t.Fatal("query token 正确时应放行")
	}
}

// 访问密码只在 TCP 通道生效，而且只能用于登录换会话令牌，不能当 Bearer 直接请求。
func TestPasswordOnlyOnTCPChannel(t *testing.T) {
	hash := mustHash(t, "s3cret-123")
	g := New("")
	g.SetPasswordSource(func() string { return hash })

	if g.Required(ChannelUnix) {
		t.Fatal("unix socket 不应要求 TCP 访问密码")
	}
	if !g.Check(ChannelUnix, "", "") {
		t.Fatal("unix socket 应免密放行")
	}
	if !g.Required(ChannelTCP) {
		t.Fatal("开启端口访问后 TCP 通道应要求鉴权")
	}
	if g.Check(ChannelTCP, "", "") {
		t.Fatal("TCP 通道没凭据应拒绝")
	}
	if g.Check(ChannelTCP, "Bearer s3cret-123", "") {
		t.Fatal("密码本身不能当 Bearer 用，必须先登录换会话令牌")
	}
	if g.Check(ChannelTCP, "", "s3cret-123") {
		t.Fatal("密码本身不能当 query token 用")
	}

	token, _, err := g.NewSession(hash)
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	if !g.Check(ChannelTCP, "Bearer "+token, "") {
		t.Fatal("登录会话令牌应被接受")
	}
	if !g.Check(ChannelTCP, "", token) {
		t.Fatal("query 上的会话令牌应被接受（WS 只能走 query）")
	}
	if got := g.Mode(ChannelTCP); got != "password" {
		t.Fatalf("Mode(TCP) = %q, want password", got)
	}
	if got := g.Mode(ChannelUnix); got != "none" {
		t.Fatalf("Mode(unix) = %q, want none", got)
	}
}

// 密码改动后旧会话立刻失效（指纹即摘要）。
func TestSessionInvalidatedByPasswordChange(t *testing.T) {
	hashA := mustHash(t, "old-pass-123")
	hashB := mustHash(t, "new-pass-456")
	cur := hashA
	g := New("")
	g.SetPasswordSource(func() string { return cur })

	token, _, err := g.NewSession(hashA)
	if err != nil {
		t.Fatal(err)
	}
	if !g.Check(ChannelTCP, "Bearer "+token, "") {
		t.Fatal("改密码前应有效")
	}
	cur = hashB
	if g.Check(ChannelTCP, "Bearer "+token, "") {
		t.Fatal("改密码后旧会话必须失效")
	}
}

func TestSessionExpiry(t *testing.T) {
	hash := mustHash(t, "s3cret-123")
	g := New("")
	g.SetPasswordSource(func() string { return hash })
	g.SetTTLSource(func() time.Duration { return 20 * time.Millisecond })
	token, _, err := g.NewSession(hash)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(40 * time.Millisecond)
	if g.Check(ChannelTCP, "Bearer "+token, "") {
		t.Fatal("过期会话应被拒绝")
	}
}

// 有效期是「签发时刻 + 当前值」：设置页改完对已经登录的设备也立刻生效。
func TestSessionTTLFollowsSettings(t *testing.T) {
	hash := mustHash(t, "s3cret-123")
	ttl := time.Hour
	g := New("")
	g.SetPasswordSource(func() string { return hash })
	g.SetTTLSource(func() time.Duration { return ttl })
	token, _, err := g.NewSession(hash)
	if err != nil {
		t.Fatal(err)
	}
	if !g.Check(ChannelTCP, "Bearer "+token, "") {
		t.Fatal("1 小时内应有效")
	}
	ttl = time.Nanosecond
	time.Sleep(2 * time.Millisecond)
	if g.Check(ChannelTCP, "Bearer "+token, "") {
		t.Fatal("把有效期调短后，已签发的会话也应按新值过期")
	}
}

// 会话表落盘：重启进程（新建一个 Guard 读同一个文件）后仍保持登录。
func TestSessionSurvivesRestart(t *testing.T) {
	hash := mustHash(t, "s3cret-123")
	path := filepath.Join(t.TempDir(), "access_sessions.json")

	first := New("")
	first.SetPasswordSource(func() string { return hash })
	if err := first.SetSessionStore(path); err != nil {
		t.Fatalf("SetSessionStore: %v", err)
	}
	token, _, err := first.NewSession(hash)
	if err != nil {
		t.Fatal(err)
	}
	// 文件里不能有令牌原文：只有它的 SHA-256。
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读会话表: %v", err)
	}
	if strings.Contains(string(raw), token) {
		t.Fatal("会话表不该出现令牌原文")
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("会话表权限应为 0600: %v %v", info.Mode().Perm(), err)
	}

	second := New("")
	second.SetPasswordSource(func() string { return hash })
	if err := second.SetSessionStore(path); err != nil {
		t.Fatalf("SetSessionStore(重启): %v", err)
	}
	if !second.Check(ChannelTCP, "Bearer "+token, "") {
		t.Fatal("重启后同一令牌应仍然有效")
	}

	// 注销要落盘：再重启一次也不能复活。
	second.RevokeSession(token)
	third := New("")
	third.SetPasswordSource(func() string { return hash })
	if err := third.SetSessionStore(path); err != nil {
		t.Fatalf("SetSessionStore: %v", err)
	}
	if third.Check(ChannelTCP, "Bearer "+token, "") {
		t.Fatal("注销后的令牌重启也不该复活")
	}
}

// 停机期间改过密码：读回来的旧会话不能再用（指纹与当前摘要不一致）。
func TestStoredSessionDroppedOnPasswordChange(t *testing.T) {
	oldHash := mustHash(t, "old-pass-123")
	newHash := mustHash(t, "new-pass-456")
	path := filepath.Join(t.TempDir(), "access_sessions.json")

	first := New("")
	first.SetPasswordSource(func() string { return oldHash })
	if err := first.SetSessionStore(path); err != nil {
		t.Fatal(err)
	}
	token, _, err := first.NewSession(oldHash)
	if err != nil {
		t.Fatal(err)
	}

	second := New("")
	second.SetPasswordSource(func() string { return newHash })
	if err := second.SetSessionStore(path); err != nil {
		t.Fatal(err)
	}
	if second.Check(ChannelTCP, "Bearer "+token, "") {
		t.Fatal("改密码后旧会话必须失效")
	}
}

// 磁盘上已过期的会话读回来时直接不要。
func TestStoredSessionExpiredOnLoad(t *testing.T) {
	hash := mustHash(t, "s3cret-123")
	path := filepath.Join(t.TempDir(), "access_sessions.json")

	first := New("")
	first.SetPasswordSource(func() string { return hash })
	first.SetTTLSource(func() time.Duration { return time.Hour })
	if err := first.SetSessionStore(path); err != nil {
		t.Fatal(err)
	}
	token, _, err := first.NewSession(hash)
	if err != nil {
		t.Fatal(err)
	}

	second := New("")
	second.SetPasswordSource(func() string { return hash })
	second.SetTTLSource(func() time.Duration { return time.Nanosecond })
	if err := second.SetSessionStore(path); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond)
	if second.Check(ChannelTCP, "Bearer "+token, "") {
		t.Fatal("过期会话不该被读回来")
	}
}

// 会话表文件坏掉不能把登录安全地放行：从空表开始（用户重登一次）。
func TestBrokenSessionStore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "access_sessions.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	g := New("")
	g.SetPasswordSource(func() string { return mustHash(t, "s3cret-123") })
	if err := g.SetSessionStore(path); err == nil {
		t.Fatal("坏文件应返回错误，交给装配层记日志")
	}
	if g.Check(ChannelTCP, "Bearer anything", "") {
		t.Fatal("坏文件不应放行任何令牌")
	}
}

// 从未设置密码时 TCP 不要求登录（此时也没有监听端口）。
func TestPasswordEmpty(t *testing.T) {
	g := New("")
	g.SetPasswordSource(func() string { return "" })
	if g.Required(ChannelTCP) {
		t.Fatal("空摘要不应要求鉴权")
	}
	if !g.Check(ChannelTCP, "", "") {
		t.Fatal("应放行")
	}
	if got := g.Mode(ChannelTCP); got != "none" {
		t.Fatalf("Mode(TCP) = %q, want none", got)
	}
}

// 同时配置环境变量 token 与 TCP 密码时，两条凭据都能进 TCP 通道；
// 但 unix 通道只认环境变量 token。
func TestTokenAndPasswordCoexist(t *testing.T) {
	hash := mustHash(t, "pwd-12345")
	g := New("env-token")
	g.SetPasswordSource(func() string { return hash })

	if got := g.Mode(ChannelTCP); got != "token" {
		t.Fatalf("Mode(TCP) = %q, want token（环境变量令牌优先展示）", got)
	}
	token, _, err := g.NewSession(hash)
	if err != nil {
		t.Fatal(err)
	}
	if !g.Check(ChannelTCP, "Bearer "+token, "") {
		t.Fatal("TCP 通道应接受登录会话")
	}
	if g.Check(ChannelUnix, "Bearer "+token, "") {
		t.Fatal("unix 通道不应接受 TCP 登录会话")
	}
	if !g.Check(ChannelUnix, "Bearer env-token", "") {
		t.Fatal("unix 通道应接受环境变量令牌")
	}
}

// 会话表写不进盘（只读挂载 / 属主变了 / 磁盘满）不能让登录本身不可用：
// 登录只要能在内存里成立就够了，落盘失败只意味着「重启后要重登一次」。
// 以前这里会撤掉会话并回错误，结果 TCP 通道整个登不进去。
func TestLoginWorksWhenStoreUnwritable(t *testing.T) {
	dir := t.TempDir()
	// 让「创建会话表目录」这一步失败：拿一个普通文件当父目录。
	blocker := filepath.Join(dir, "not-a-dir")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(blocker, "access_sessions.json")

	hash := mustHash(t, "s3cret-123")
	g := New("")
	g.SetPasswordSource(func() string { return hash })
	if err := g.SetSessionStore(path); err == nil {
		t.Fatal("测试前提：这个路径写不进去，SetSessionStore 应报错")
	}

	token, expires, err := g.NewSession(hash)
	if token == "" {
		t.Fatal("落盘失败也必须签发令牌")
	}
	if err == nil {
		t.Fatal("落盘失败要返回给调用方记日志")
	}
	if expires.IsZero() {
		t.Fatal("expires 不该是零值")
	}
	if !g.Check(ChannelTCP, "Bearer "+token, "") {
		t.Fatal("内存里的会话应立即可用")
	}
	// 注销同样以内存为准：删掉就不再有效（哪怕磁盘上本来也没写成功）。
	_ = g.RevokeSession(token)
	if g.Check(ChannelTCP, "Bearer "+token, "") {
		t.Fatal("注销后不该再通过")
	}
}

// 并发登录/校验/注销不能死锁，也不能写出比内存更旧的会话表。
func TestPersistConcurrency(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "access_sessions.json")
	hash := mustHash(t, "s3cret-123")
	g := New("")
	g.SetPasswordSource(func() string { return hash })
	if err := g.SetSessionStore(path); err != nil {
		t.Fatalf("SetSessionStore: %v", err)
	}

	const n = 16
	var wg sync.WaitGroup
	tokens := make([]string, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			token, _, err := g.NewSession(hash)
			if err != nil {
				t.Errorf("NewSession: %v", err)
				return
			}
			tokens[i] = token
			if !g.Check(ChannelTCP, "Bearer "+token, "") {
				t.Errorf("刚签发的会话应有效")
			}
		}(i)
	}
	wg.Wait()
	for i := 0; i < n; i += 2 {
		if err := g.RevokeSession(tokens[i]); err != nil {
			t.Errorf("RevokeSession: %v", err)
		}
	}

	// 重启：落盘内容不能比内存旧（偶数号已注销，重启后也不该复活）。
	second := New("")
	second.SetPasswordSource(func() string { return hash })
	if err := second.SetSessionStore(path); err != nil {
		t.Fatalf("SetSessionStore(重启): %v", err)
	}
	for i, token := range tokens {
		got := second.Check(ChannelTCP, "Bearer "+token, "")
		if want := i%2 == 1; got != want {
			t.Fatalf("token[%d] 重启后有效=%v，want %v", i, got, want)
		}
	}
}
