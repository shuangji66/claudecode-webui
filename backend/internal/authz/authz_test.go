package authz

import (
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
	old := SessionTTL
	SessionTTL = 20 * time.Millisecond
	defer func() { SessionTTL = old }()

	hash := mustHash(t, "s3cret-123")
	g := New("")
	g.SetPasswordSource(func() string { return hash })
	token, _, err := g.NewSession(hash)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(40 * time.Millisecond)
	if g.Check(ChannelTCP, "Bearer "+token, "") {
		t.Fatal("过期会话应被拒绝")
	}
}

func TestClearSessions(t *testing.T) {
	hash := mustHash(t, "s3cret-123")
	g := New("")
	g.SetPasswordSource(func() string { return hash })
	token, _, err := g.NewSession(hash)
	if err != nil {
		t.Fatal(err)
	}
	g.ClearSessions()
	if g.Check(ChannelTCP, "Bearer "+token, "") {
		t.Fatal("清空后会话令牌必须失效")
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
