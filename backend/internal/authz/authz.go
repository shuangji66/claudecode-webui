// Package authz 实现访问鉴权：环境变量令牌、TCP 访问密码的摘要与登录会话。
//
// 两条到达路径的凭据要求不同：
//   - unix socket：本机/前置网关注入的通道，只校验 CCWEB_AUTH_TOKEN（通常为空=放行）；
//   - TCP 端口：局域网可达，开启端口访问后必须登录（访问密码）。
//
// 密码只以 PBKDF2-SHA256 摘要落盘（见 password.go），登录成功换一个随机会话令牌：
// 浏览器之后每次请求带的是这个令牌，不是密码本身。
//
// 会话表**落盘**（`SetSessionStore`，0600、原子替换，文件里只存令牌的 SHA-256）：
// 重启进程/升级应用不再把已经登录的设备全部踢下线。有效期的唯一边界是
// 「签发时刻 + 当前有效期」（有效期来自设置页，见 settings.Store.LoginTTL）；
// 改密码仍然让旧令牌立刻失效——签发时记的指纹就是密码摘要。
package authz

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
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

// DefaultSessionTTL 是登录会话的兜底有效期（设置页没给值、或给了非法值时用）。
// 与 settings.DefaultLoginTTLHours 同一个数，这里不 import settings：
// authz 是底层包，取值函数由装配层接进来（`SetTTLSource`）。
const DefaultSessionTTL = 24 * time.Hour

// Guard 持有环境变量令牌、TCP 访问密码摘要与登录会话。
type Guard struct {
	token string
	// password 返回 TCP 访问密码的摘要（来自设置页，可运行期修改）。
	// 摘要为空表示从未设置过密码，TCP 通道不要求登录（此时也没有监听端口）。
	password func() string
	// ttl 返回当前登录有效期（来自设置页）。nil 表示用 DefaultSessionTTL。
	ttl func() time.Duration
	// storePath 是会话表的落盘路径；空表示只存内存（测试用）。
	storePath string

	mu       sync.Mutex
	sessions map[string]session

	// persistMu 串行化落盘，并保证「快照 → 写盘」的顺序与内存变更顺序一致：
	// g.mu 只护内存，I/O 在它外面做（持锁 fsync 会把所有并发鉴权串在慢盘后面）。
	persistMu sync.Mutex
}

type session struct {
	// issued 是签发时刻。过期时刻 = issued + **当前**有效期：设置页改完，
	// 已经登录的设备也按新值算，不必等下一次登录。
	issued time.Time
	// fingerprint 是签发时的密码摘要。密码一改，旧会话立刻失效，
	// 不需要额外广播"踢掉所有设备"。
	fingerprint string
}

// persistedSession 是会话表的磁盘格式。
//
// Token 存的是**令牌的 SHA-256**（`tokenKey`），不是令牌原文：备份、同步、
// 截图把这个文件带走时，拿到的摘要不能直接当凭据用。指纹与签发时刻照存。
type persistedSession struct {
	Token       string    `json:"token"`
	Fingerprint string    `json:"fingerprint"`
	Issued      time.Time `json:"issued"`
}

type persistedSessions struct {
	Sessions []persistedSession `json:"sessions"`
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

// SetTTLSource 接入登录有效期的取值函数（通常是 settings.Store.LoginTTL）。
// nil 表示用 DefaultSessionTTL。
func (g *Guard) SetTTLSource(fn func() time.Duration) {
	g.mu.Lock()
	g.ttl = fn
	g.mu.Unlock()
}

// SetSessionStore 指定会话表的落盘路径，并把磁盘上仍然有效的会话读回来。
//
// 调用时机是进程启动（装配层给 CCWEB_DATA_DIR 下的一个文件）。文件不存在不是错误；
// 坏文件返回错误、已登录的会话从空开始——调用方记一条日志，用户重登一次即可。
// 读回来的会话会先过两道筛子：已经过期的不收，签发时用的密码摘要与**现在**的
// 摘要不一致的也不收（进程停机期间改过密码）。
func (g *Guard) SetSessionStore(path string) error {
	loaded := make(map[string]session)
	var err error
	if path != "" {
		loaded, err = readSessions(path)
	}

	// 两个取值都在锁外做：它们会去读设置，锁序不要叠起来。
	ttl := g.ttlValue()
	fingerprint := passwordOf(g.passwordSource())

	now := time.Now()
	kept := make(map[string]session, len(loaded))
	for token, s := range loaded {
		if now.After(s.issued.Add(ttl)) {
			continue
		}
		if fingerprint != "" && s.fingerprint != fingerprint {
			continue
		}
		kept[token] = s
	}

	g.mu.Lock()
	g.storePath = path
	g.sessions = kept
	g.mu.Unlock()

	if err != nil {
		return err
	}
	// 读进来就顺手把淘汰过的条目从磁盘上抹掉：否则过期令牌会一直躺在文件里。
	// 写失败不影响启动（多半也正是写不进去的环境），下一次登录会再写一遍。
	if len(kept) != len(loaded) {
		_ = g.persist()
	}
	return nil
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
	return passwordOf(fn)
}

// passwordSource 取密码摘要的取值函数（调用方负责在锁外调用它）。
func (g *Guard) passwordSource() func() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.password
}

func passwordOf(fn func() string) string {
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
//
// 返回值是落盘结果：内存里的会话**一定**已经删掉了（这次请求之后就用不了），
// 落盘失败只意味着「重启进程后这个令牌还能用」——调用方该把这件事记进日志。
func (g *Guard) RevokeSession(token string) error {
	if token == "" {
		return nil
	}
	g.mu.Lock()
	key := tokenKey(token)
	_, ok := g.sessions[key]
	if ok {
		delete(g.sessions, key)
	}
	g.mu.Unlock()
	if !ok {
		return nil
	}
	return g.persist()
}

// NewSession 在密码校验通过后签发一个会话令牌。
//
// 落盘失败**不让登录失败**：会话表是「跨进程重启」的加分项，不是登录的前置条件。
// CCWEB_DATA_DIR 只读挂载 / 升级后属主变了 / 磁盘满时，以前会出现「unix socket 能用、
// 用访问密码登录却 500」——那是把可写磁盘当成访问密码的前提。现在会话留在内存里照常
// 工作，只把落盘错误返回给调用方记日志（重启后需要重登一次）。
func (g *Guard) NewSession(fingerprint string) (string, time.Time, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", time.Time{}, err
	}
	token := hex.EncodeToString(raw[:])
	now := time.Now()
	ttl := g.ttlValue()

	g.mu.Lock()
	if g.sessions == nil {
		g.sessions = make(map[string]session)
	}
	g.pruneLocked(now, ttl)
	g.sessions[tokenKey(token)] = session{issued: now, fingerprint: fingerprint}
	g.mu.Unlock()

	return token, now.Add(ttl), g.persist()
}

func (g *Guard) sessionValid(token, fingerprint string) bool {
	key := tokenKey(token)
	ttl := g.ttlValue()
	now := time.Now()

	g.mu.Lock()
	s, ok := g.sessions[key]
	if !ok {
		g.mu.Unlock()
		return false
	}
	stale := now.After(s.issued.Add(ttl)) || s.fingerprint != fingerprint
	if stale {
		delete(g.sessions, key)
	}
	g.mu.Unlock()

	if stale {
		// 顺手把清掉的条目落盘（否则过期令牌会留在文件里）。写失败无所谓：
		// 重启后 SetSessionStore 会用同样的两道筛子（TTL 与密码指纹）再筛一次。
		_ = g.persist()
		return false
	}
	return true
}

// pruneLocked 清掉过期会话；签发时顺手调用，避免 map 与磁盘无限增长。
func (g *Guard) pruneLocked(now time.Time, ttl time.Duration) {
	for key, s := range g.sessions {
		if now.After(s.issued.Add(ttl)) {
			delete(g.sessions, key)
		}
	}
}

// ttlValue 取当前有效期（不持锁调用取值函数：那会去读设置，锁序不要叠起来）。
func (g *Guard) ttlValue() time.Duration {
	g.mu.Lock()
	fn := g.ttl
	g.mu.Unlock()
	return ttlOf(fn)
}

func ttlOf(fn func() time.Duration) time.Duration {
	if fn == nil {
		return DefaultSessionTTL
	}
	if d := fn(); d > 0 {
		return d
	}
	return DefaultSessionTTL
}

// persist 把会话表原子写到 storePath（没有配置路径时什么都不做）。
//
// 锁的分工：g.mu 只护内存，快照在 persistMu 里取、写盘在锁外做——
// `sessionValid` 是鉴权热路径，持着 g.mu 去 fsync 会把所有并发请求（含 WS 握手）
// 串在慢盘后面。persistMu 同时保证「快照 → 写盘」的顺序与内存变更顺序一致：
// 两个协程各自取快照时不会写出「更旧的快照后落盘」。
func (g *Guard) persist() error {
	g.persistMu.Lock()
	defer g.persistMu.Unlock()

	g.mu.Lock()
	path := g.storePath
	if path == "" {
		g.mu.Unlock()
		return nil
	}
	out := persistedSessions{Sessions: make([]persistedSession, 0, len(g.sessions))}
	for token, s := range g.sessions {
		out.Sessions = append(out.Sessions, persistedSession{Token: token, Fingerprint: s.fingerprint, Issued: s.issued})
	}
	g.mu.Unlock()

	// map 顺序随机：排一下，同一份会话表每次写出来的字节稳定，便于比对与备份。
	sort.Slice(out.Sessions, func(i, j int) bool { return out.Sessions[i].Token < out.Sessions[j].Token })
	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return fmt.Errorf("authz: 编码登录会话表: %w", err)
	}
	dir := filepath.Dir(path)
	if dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("authz: 创建会话表目录 %s: %w", dir, err)
		}
	}
	temp, err := os.CreateTemp(dir, ".access_sessions-*.json")
	if err != nil {
		return fmt.Errorf("authz: 创建会话表临时文件: %w", err)
	}
	name := temp.Name()
	defer os.Remove(name) // rename 成功后这里是 no-op
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return fmt.Errorf("authz: 设置会话表权限: %w", err)
	}
	if _, err := temp.Write(b); err != nil {
		temp.Close()
		return fmt.Errorf("authz: 写入会话表: %w", err)
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return fmt.Errorf("authz: 落盘会话表: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("authz: 关闭会话表: %w", err)
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("authz: 替换会话表 %s: %w", path, err)
	}
	// rename 只保证「指向新 inode」，目录项本身也要落盘：否则掉电后可能回到旧文件
	// （甚至找不到文件），那时所有已登录设备都要重登一次。
	if d, err := os.Open(dir); err == nil {
		syncErr := d.Sync()
		_ = d.Close()
		if syncErr != nil {
			return fmt.Errorf("authz: 落盘会话表目录 %s: %w", dir, syncErr)
		}
	}
	return nil
}

// readSessions 读出磁盘上的会话表（key = 令牌的 SHA-256）。
func readSessions(path string) (map[string]session, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("authz: 读取登录会话表 %s: %w", path, err)
	}
	var onDisk persistedSessions
	if err := json.Unmarshal(b, &onDisk); err != nil {
		return nil, fmt.Errorf("authz: 解析登录会话表 %s: %w", path, err)
	}
	out := make(map[string]session, len(onDisk.Sessions))
	for _, ps := range onDisk.Sessions {
		if ps.Token == "" || ps.Fingerprint == "" || ps.Issued.IsZero() {
			continue
		}
		out[ps.Token] = session{issued: ps.Issued, fingerprint: ps.Fingerprint}
	}
	return out, nil
}

// tokenKey 是会话表的内存键与磁盘键：令牌的 SHA-256（十六进制）。
//
// 不直接拿令牌当键，是为了让磁盘上的文件即使泄漏也不能当凭据用。
func tokenKey(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
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
