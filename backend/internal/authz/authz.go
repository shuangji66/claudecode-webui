// Package authz 实现访问鉴权：环境变量令牌、TCP 访问密码的摘要与登录会话。
//
// 两条到达路径的凭据要求不同：
//   - unix socket：本机/前置网关注入的通道，只校验 CCWEB_AUTH_TOKEN（通常为空=放行）；
//   - TCP 端口：局域网可达，开启端口访问后必须登录（访问密码）。
//
// 密码只以 PBKDF2-SHA256 摘要落盘（见 password.go），登录成功换一个随机会话令牌：
// 浏览器之后每次请求带的是这个令牌，不是密码本身。会话只存在进程内存里，
// 重启后需要重新登录——这是刻意的：令牌不落盘，泄漏面更小。
package authz

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"strings"
	"sync"
	"time"
)

// Channel 是请求到达本进程的通道。
type Channel int

const (
	// ChannelUnix 是 unix socket（前置网关反代）：本机可信，不要求访问密码。
	ChannelUnix Channel = iota
	// ChannelTCP 是直连的 TCP 端口：局域网可达，开启端口访问后要求登录。
	ChannelTCP
)

// SessionTTL 是 TCP 登录会话的有效期。面板会常驻在浏览器标签里，
// 太短会天天重输密码；太长又失去"关掉端口访问即失效"的意义（关闭时会主动清空）。
// 是变量而不是常量：测试会临时调小它验证过期路径。
var SessionTTL = 7 * 24 * time.Hour

// Guard 持有环境变量令牌、TCP 访问密码摘要与登录会话。
type Guard struct {
	token string
	// password 返回 TCP 访问密码的摘要（来自设置页，可运行期修改）。
	// 摘要为空表示从未设置过密码，TCP 通道不要求登录（此时也没有监听端口）。
	password func() string

	mu       sync.Mutex
	sessions map[string]session
}

type session struct {
	expires time.Time
	// fingerprint 是签发时的密码摘要。密码一改，旧会话立刻失效，
	// 不需要额外广播"踢掉所有设备"。
	fingerprint string
}

// New 构造 Guard。token 为空表示未配置环境变量令牌。
func New(token string) *Guard {
	return &Guard{token: token, sessions: make(map[string]session)}
}

// SetPasswordSource 接入 TCP 访问密码摘要。传 nil 表示不需要登录。
func (g *Guard) SetPasswordSource(fn func() string) {
	g.mu.Lock()
	g.password = fn
	g.mu.Unlock()
}

// TokenConfigured 表示是否配置了环境变量令牌。
func (g *Guard) TokenConfigured() bool { return g.token != "" }

// EnvTokenMatches 判断候选值是否等于环境变量令牌。
//
// 登录接口用它兼容旧的 CCWEB_AUTH_TOKEN 部署：令牌本来就能当 Bearer 用，
// 这里只是让鉴权页也能用它换一个可存进 localStorage 的凭据。
func (g *Guard) EnvTokenMatches(candidate string) bool {
	return g.token != "" && subtle.ConstantTimeCompare([]byte(candidate), []byte(g.token)) == 1
}

// PasswordRequired 表示 TCP 是否要求登录。
//
// 判据只有「有没有密码摘要」，**不看端口开关**：关闭端口访问时监听会马上
// 断开，但在断开之前的极短窗口里，如果这里回退成「不需要鉴权」，那几个
// 连接就是免密的。只要设过密码，任何到达 TCP 通道的请求都必须先登录。
func (g *Guard) PasswordRequired() bool {
	return g.passwordHash() != ""
}

func (g *Guard) passwordHash() string {
	g.mu.Lock()
	fn := g.password
	g.mu.Unlock()
	if fn == nil {
		return ""
	}
	return fn()
}

// Required 表示该通道是否需要凭据。
func (g *Guard) Required(ch Channel) bool {
	if g.token != "" {
		return true
	}
	return ch == ChannelTCP && g.PasswordRequired()
}

// Check 判断本次请求在该通道上是否被授权。
//
// 凭据有两种：环境变量令牌（两条通道都认）与登录会话令牌（只对 TCP 有效）。
// 密码本身不再能当令牌用：它只在登录接口里被校验一次。
func (g *Guard) Check(ch Channel, authorization, queryToken string) bool {
	if !g.Required(ch) {
		return true
	}
	cand := Credential(authorization, queryToken)
	if cand == "" {
		return false
	}
	if g.token != "" && subtle.ConstantTimeCompare([]byte(cand), []byte(g.token)) == 1 {
		return true
	}
	if ch == ChannelTCP {
		if hash := g.passwordHash(); hash != "" && g.sessionValid(cand, hash) {
			return true
		}
	}
	return false
}

// Credential 取出候选凭据：query 优先（WS 只能走 query），否则 Authorization。
func Credential(authorization, queryToken string) string {
	if queryToken != "" {
		return queryToken
	}
	return bearer(authorization)
}

// RevokeSession 让指定会话令牌立刻失效（注销）。不存在的令牌是幂等的 no-op。
func (g *Guard) RevokeSession(token string) {
	if token == "" {
		return
	}
	g.mu.Lock()
	delete(g.sessions, token)
	g.mu.Unlock()
}

// NewSession 在密码校验通过后签发一个会话令牌。
func (g *Guard) NewSession(fingerprint string) (string, time.Time, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", time.Time{}, err
	}
	token := hex.EncodeToString(raw[:])
	expires := time.Now().Add(SessionTTL)
	g.mu.Lock()
	if g.sessions == nil {
		g.sessions = make(map[string]session)
	}
	g.pruneLocked(time.Now())
	g.sessions[token] = session{expires: expires, fingerprint: fingerprint}
	g.mu.Unlock()
	return token, expires, nil
}

// ClearSessions 让所有 TCP 登录会话立刻失效（关闭端口访问/改密码时用）。
func (g *Guard) ClearSessions() {
	g.mu.Lock()
	g.sessions = make(map[string]session)
	g.mu.Unlock()
}

func (g *Guard) sessionValid(token, fingerprint string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	s, ok := g.sessions[token]
	if !ok {
		return false
	}
	if time.Now().After(s.expires) || s.fingerprint != fingerprint {
		delete(g.sessions, token)
		return false
	}
	return true
}

// pruneLocked 清掉过期会话；签发与校验都会顺手调用，避免 map 无限增长。
func (g *Guard) pruneLocked(now time.Time) {
	for token, s := range g.sessions {
		if now.After(s.expires) {
			delete(g.sessions, token)
		}
	}
}

// Mode 返回该通道的鉴权方式，供 /api/info 与设置页区分凭据类型。
func (g *Guard) Mode(ch Channel) string {
	switch {
	case g.token != "":
		return "token"
	case ch == ChannelTCP && g.PasswordRequired():
		return "password"
	default:
		return "none"
	}
}

func bearer(h string) string {
	if h == "" {
		return ""
	}
	const prefix = "bearer "
	if len(h) > len(prefix) && strings.EqualFold(h[:len(prefix)], prefix) {
		return strings.TrimSpace(h[len(prefix):])
	}
	return ""
}
