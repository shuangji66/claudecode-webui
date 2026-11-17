package gateway

import (
	"encoding/json"
	"net/http"

	"ccweb/backend/internal/authz"
)

// handleLogin 用访问密码换一个登录会话令牌。
//
// 这是唯一接受明文密码的接口：密码在这里按 PBKDF2 摘要校验一次，之后浏览器
// 带的是随机会话令牌（Guard.Check 只查内存里的会话表）。密码本身不再能当
// Bearer 用，settings.json 里也只有摘要。
//
// 会话只存在进程内存：重启进程后需要重新登录，但设置不会因此丢失。
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	// 旧的 CCWEB_AUTH_TOKEN 部署也要能从鉴权页登录：令牌本身就是凭据，
	// 这里原样发回给前端存进 localStorage（它仍按 Bearer 校验）。
	if s.d.Guard.EnvTokenMatches(req.Password) {
		writeJSON(w, map[string]any{"token": req.Password})
		return
	}

	enabled, hash := s.d.Settings.TCPAccess()
	if !enabled || hash == "" {
		// 配置了令牌时，输错是「凭据不对」；没配置任何鉴权时才是「没开端口」。
		if s.d.Guard.TokenConfigured() {
			writeErr(w, "凭据不正确", http.StatusUnauthorized)
			return
		}
		writeErr(w, "端口访问未开启或未设置访问密码", http.StatusConflict)
		return
	}
	if !authz.VerifyPassword(hash, req.Password) {
		writeErr(w, "密码不正确", http.StatusUnauthorized)
		return
	}
	token, expires, err := s.d.Guard.NewSession(hash)
	if err != nil {
		writeErr(w, "无法创建登录会话", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"token": token, "expires_at": expires})
}
