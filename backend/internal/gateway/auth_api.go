package gateway

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"

	"ccweb/backend/internal/authz"
)

// handleLogout 注销调用方持有的登录会话。
//
// 不挂鉴权中间件：令牌过期/填错时前端也要能清掉本地凭据，所以这里对
// 无效令牌同样返回 200（幂等）。它只能吊销「请求里自己带的那个令牌」，
// 不能吊销别人的会话；环境变量令牌不是会话，这里对它没有影响。
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	token := authz.Credential(r.Header.Get("Authorization"), r.URL.Query().Get("token"))
	// 内存里的会话一定已经删掉（这次之后就无效）；落盘失败只影响「重启后它是否复活」，
	// 不该把注销接口变成 500——前端据此清本地凭据，失败重试也没有意义。
	if err := s.d.Guard.RevokeSession(token); err != nil {
		s.log.Printf("注销会话落盘失败（重启后该令牌可能仍然有效）: %v", err)
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handleLogin 用访问密码换一个登录会话令牌。
//
// 这是唯一接受明文密码的接口：密码在这里按 PBKDF2 摘要校验一次，之后浏览器
// 带的是随机会话令牌（Guard.Check 只查会话表，表里的键是令牌的 SHA-256）。
// 密码本身不再能当 Bearer 用，settings.json 里也只有摘要。
//
// 会话表落盘，重启进程/升级应用不会把已登录的设备踢下线；它的唯一边界是
// 「签发时刻 + 「设置 → 访问」里的登录有效期」（默认 24 小时）。
// loginSource 取限流用的来源标识。
//
// **只认 TCP 连接的 RemoteAddr**，不看 `X-Forwarded-For` / `X-Real-IP` 之类：
// 这个接口只在 TCP 通道上有意义（unix 通道免密），而 TCP 是浏览器直连本进程，
// 头是客户端随手写的——认了它，攻击者每次换一个头就是一条新记录，限流形同虚设。
//
// 端口被前置代理挡住时所有请求都来自同一个 127.0.0.1，于是它们共享一份配额；
// 那是**安全的一侧**（宁可多锁一个人，也不要谁都能绕过），而且这种部署本就不该
// 把访问密码暴露在代理之外。
func loginSource(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || host == "" {
		return r.RemoteAddr
	}
	return host
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	// 先过限流，**在读请求体之前**：被锁的来源连解析都不做，更不会跑 PBKDF2
	// （那正是「几十个并发把 CPU 打满」的杠杆）。
	source := loginSource(r)
	if ok, wait := s.logins.Allowed(source); !ok {
		secs := int(wait.Seconds()) + 1
		writeErr(w, fmt.Sprintf("尝试次数过多，请 %d 秒后再试", secs), http.StatusTooManyRequests)
		return
	}

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
		s.logins.Succeed(source)
		writeJSON(w, map[string]any{"token": req.Password})
		return
	}

	enabled, hash := s.d.Settings.TCPAccess()
	if !enabled || hash == "" {
		// 配置了令牌时，输错是「凭据不对」；没配置任何鉴权时才是「没开端口」。
		// 这两种都不是「猜密码」，**不计入失败次数**：否则一个没开端口访问的部署
		// 被脚本扫几次就锁住了，用户改完设置也进不来。
		if s.d.Guard.TokenConfigured() {
			writeErr(w, "凭据不正确", http.StatusUnauthorized)
			return
		}
		writeErr(w, "端口访问未开启或未设置访问密码", http.StatusConflict)
		return
	}
	if !authz.VerifyPassword(hash, req.Password) {
		locked := s.logins.Fail(source)
		if locked {
			secs := int(s.logins.LockoutDuration().Seconds()) + 1
			writeErr(w, fmt.Sprintf("密码错误次数过多，请 %d 秒后再试", secs), http.StatusTooManyRequests)
			return
		}
		writeErr(w, "密码不正确", http.StatusUnauthorized)
		return
	}
	s.logins.Succeed(source)
	token, expires, err := s.d.Guard.NewSession(hash)
	if token == "" {
		writeErr(w, "无法创建登录会话", http.StatusInternalServerError)
		return
	}
	if err != nil {
		// 会话表写不进盘（只读挂载 / 磁盘满 / 属主变了）：登录照常，
		// 只是重启进程后要重登一次。不要因为这个回 500——那会让「端口访问」整个不可用。
		s.log.Printf("登录会话落盘失败（本次登录仍然有效，重启后需要重新登录）: %v", err)
	}
	writeJSON(w, map[string]any{"token": token, "expires_at": expires})
}
