// Package authz 实现可选的 Bearer token 鉴权。
//
// 本应用本质上是「浏览器里的命令执行面板」，一旦被反代到内网可访问地址而没有任何
// 鉴权，等于把 NAS 的 shell 敞开。因此只要配置了 CCWEB_AUTH_TOKEN 就必须校验：
//   - HTTP 请求：Authorization: Bearer <token>
//   - WebSocket：浏览器无法给 WS 请求设自定义头，故允许 ?token=<token>
//
// 两者都用常量时间比较，避免时序侧信道。
package authz

import (
	"crypto/subtle"
	"strings"
)

// Guard 持有期望的 token。token 为空表示不启用鉴权。
type Guard struct {
	token string
}

// New 构造 Guard。
func New(token string) *Guard { return &Guard{token: token} }

// Required 表示是否启用了鉴权。
func (g *Guard) Required() bool { return g.token != "" }

// Check 判断本次请求是否被授权。
func (g *Guard) Check(authorization, queryToken string) bool {
	if !g.Required() {
		return true
	}
	cand := queryToken
	if cand == "" {
		cand = bearer(authorization)
	}
	if cand == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(cand), []byte(g.token)) == 1
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
