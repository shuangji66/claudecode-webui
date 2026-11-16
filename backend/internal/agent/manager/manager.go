// Package manager 是 agent 子域的门面：负责创建/查找/回收 claude 会话进程。
//
// 上层（gateway）只和 Manager 打交道，不直接接触 exec.Cmd 或 NDJSON 管道。
package manager

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"ccweb/backend/internal/agent/process"
	"ccweb/backend/internal/agent/session"
	"ccweb/backend/internal/config"
	"ccweb/backend/internal/settings"
)

// ErrTooMany 表示常驻会话已达上限。
var ErrTooMany = errors.New("manager: 常驻会话数已达上限，请先关闭空闲会话")

// Info 是会话的对外描述。
type Info struct {
	ID    string `json:"id"`
	Cwd   string `json:"cwd"`
	State string `json:"state"`
	// Provider 是创建该会话时选中的提供商 id，前端据此判断能否热切换模型
	// （跨提供商切换需要新建会话，因为地址与密钥在进程启动时就定死了）。
	Provider   string    `json:"provider,omitempty"`
	Model      string    `json:"model,omitempty"`
	Effort     string    `json:"effort,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
	LastActive time.Time `json:"last_active"`
}

// Manager 持有全部常驻会话。
type Manager struct {
	cfg config.Config
	// resolve 每次新建会话时重新解析 claude 路径：设置页切换版本后，
	// 新会话立刻用新版本，已在跑的进程保持原样（二进制已载入内存）。
	resolve func() (string, error)
	store   *settings.Store
	emit    func(sessionID string, ev session.Event)

	// createMu 串行化「检查是否已有同目录会话 + 启动新进程」。
	// 没有它时，后端自动拉起与前端同时到达的 ensure 会各起一个 claude。
	createMu sync.Mutex

	mu       sync.Mutex
	sessions map[string]*session.Session
	procs    map[string]*process.Proc
	metas    map[string]meta

	closing chan struct{}
}

// New 构造 Manager。resolve 提供当前要启动的 claude 路径（通常是
// claudebin 的当前版本）；store 提供第三方端点/密钥/默认模型等运行期配置。
//
// 这里不再做「找不到 claude 就启动失败」：二进制改成运行期从界面安装，
// 未安装时服务必须照常起来，否则用户没有入口去装。
func New(cfg config.Config, resolve func() (string, error), store *settings.Store, emit func(string, session.Event)) *Manager {
	m := &Manager{
		cfg:      cfg,
		resolve:  resolve,
		store:    store,
		emit:     emit,
		sessions: make(map[string]*session.Session),
		procs:    make(map[string]*process.Proc),
		metas:    make(map[string]meta),
		closing:  make(chan struct{}),
	}
	go m.reapLoop()
	return m
}

// Binary 返回当前生效的 claude 路径；未安装时返回空串（/api/info 只做展示）。
func (m *Manager) Binary() string {
	if m.resolve == nil {
		return ""
	}
	p, err := m.resolve()
	if err != nil {
		return ""
	}
	return p
}

// Create 新建一个会话并完成握手。
//
// 会话 id 同时作为 claude 的 --session-id：这样转录文件名、应用侧记录和
// 前端 active id 是同一个 UUID，重启后可以用 --resume 精确恢复。
func (m *Manager) Create(cwd, model, permissionMode string) (Info, error) {
	abs, err := normalizeCwd(cwd)
	if err != nil {
		return Info{}, err
	}
	id, err := newUUID()
	if err != nil {
		return Info{}, fmt.Errorf("manager: 生成会话 id: %w", err)
	}
	m.createMu.Lock()
	defer m.createMu.Unlock()
	return m.create(abs, id, "", model, permissionMode)
}

// Resume 用已有对话 id 恢复一个 claude 进程。
//
// 同 id 已经在运行就直接返回现有会话；否则以 --resume 启动，并沿用原 id，
// 这样前后端所有引用（transcript、active id、对话元数据）保持稳定。
func (m *Manager) Resume(id, cwd, model, permissionMode string) (Info, error) {
	id = strings.TrimSpace(id)
	if !validUUID(id) {
		return Info{}, errors.New("manager: 非法的对话 id")
	}
	abs, err := normalizeCwd(cwd)
	if err != nil {
		return Info{}, err
	}
	m.createMu.Lock()
	defer m.createMu.Unlock()

	if info, ok := m.infoByID(id); ok {
		if filepath.Clean(info.Cwd) != abs {
			return Info{}, errors.New("manager: 该对话属于其它工作目录")
		}
		return info, nil
	}
	return m.create(abs, id, id, model, permissionMode)
}

// Info 按 id 返回会话描述。
func (m *Manager) Info(id string) (Info, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok {
		return Info{}, false
	}
	info := infoOf(s)
	if mt, ok := m.metas[id]; ok {
		info.Provider = mt.Provider
		info.Model = mt.Model
		info.Effort = mt.Effort
	}
	return info, true
}

// Ensure 返回 cwd 下已存在的会话；没有则新建。
//
// 「APP 启动自动拉起」与「切换工作区」都走这里：并发调用会串行化，
// 前端即便在自动启动完成前也发了一次 ensure，也不会多起 claude。
func (m *Manager) Ensure(cwd, model, permissionMode string) (Info, error) {
	abs, err := normalizeCwd(cwd)
	if err != nil {
		return Info{}, err
	}
	m.createMu.Lock()
	defer m.createMu.Unlock()

	if info, ok := m.findByCwd(abs); ok {
		return info, nil
	}
	id, err := newUUID()
	if err != nil {
		return Info{}, fmt.Errorf("manager: 生成会话 id: %w", err)
	}
	return m.create(abs, id, "", model, permissionMode)
}

// infoByID 返回某个 id 的存活会话描述；已退出的会话视为不存在，
// 这样 Resume 会重新拉起进程而不是返回一个 closed 的壳。
func (m *Manager) infoByID(id string) (Info, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok || s.State() == session.StateClosed {
		return Info{}, false
	}
	info := infoOf(s)
	if mt, ok := m.metas[id]; ok {
		info.Provider = mt.Provider
		info.Model = mt.Model
		info.Effort = mt.Effort
	}
	return info, true
}

// findByCwd 返回该目录下最近活跃的存活会话。
func (m *Manager) findByCwd(abs string) (Info, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var best *session.Session
	for _, s := range m.sessions {
		if filepath.Clean(s.Cwd) != abs || s.State() == session.StateClosed {
			continue
		}
		if best == nil || s.LastActive().After(best.LastActive()) {
			best = s
		}
	}
	if best == nil {
		return Info{}, false
	}
	info := infoOf(best)
	if mt, ok := m.metas[best.ID]; ok {
		info.Provider = mt.Provider
		info.Model = mt.Model
	}
	return info, true
}

// normalizeCwd 校验并归一化工作目录。
func normalizeCwd(cwd string) (string, error) {
	if cwd == "" {
		return "", errors.New("manager: cwd 不能为空")
	}
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return "", fmt.Errorf("manager: 解析 cwd: %w", err)
	}
	st, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("manager: 工作目录不可用: %w", err)
	}
	if !st.IsDir() {
		return "", fmt.Errorf("manager: %s 不是目录", abs)
	}
	return abs, nil
}

// create 在 createMu 已持有的前提下启动会话。
// sessionID 是应用侧 / CLI 共用的 id；resumeID 非空时走 --resume。
func (m *Manager) create(abs, sessionID, resumeID, model, permissionMode string) (Info, error) {
	m.reapIdle()
	m.pruneClosed()

	m.mu.Lock()
	if len(m.sessions) >= m.cfg.MaxSessions {
		m.mu.Unlock()
		return Info{}, ErrTooMany
	}
	m.mu.Unlock()

	// 运行期设置优先：设置页选中的模型就是 CLI 的默认模型。
	cfgSet := m.store.Get()
	if model == "" {
		model = cfgSet.DefaultModel()
	}
	if model == "" {
		model = m.cfg.Model
	}
	if permissionMode == "" {
		permissionMode = cfgSet.PermissionMode
	}
	if permissionMode == "" {
		permissionMode = m.cfg.PermissionMode
	}
	effort := cfgSet.DefaultEffort()
	args := process.Args(process.Options{
		Model:          model,
		PermissionMode: permissionMode,
		Effort:         effort,
		Resume:         resumeID,
		SessionID: func() string {
			if resumeID == "" {
				return sessionID
			}
			return ""
		}(),
		IncludePartialMessages: true,
	})
	// 先净化继承环境，再追加设置里的 ANTHROPIC_*（后者生效，从而覆盖宿主机同名变量）。
	env := process.CleanEnv(os.Environ(), m.cfg.ClaudeHome, abs)
	env = append(env, cfgSet.Env()...)

	bin, err := m.resolve()
	if err != nil {
		return Info{}, fmt.Errorf("manager: %w；请在「设置 → 部署」里安装 claude", err)
	}
	proc, err := process.Spawn(bin, args, abs, env)
	if err != nil {
		return Info{}, err
	}

	id := sessionID
	sess := session.New(id, abs, proc, func(ev session.Event) {
		if m.emit != nil {
			m.emit(id, ev)
		}
	})

	m.mu.Lock()
	m.sessions[id] = sess
	m.procs[id] = proc
	m.metas[id] = meta{Provider: cfgSet.Selected.Provider, Model: model, Effort: effort}
	m.mu.Unlock()

	if err := sess.Start(); err != nil {
		m.mu.Lock()
		delete(m.sessions, id)
		delete(m.procs, id)
		delete(m.metas, id)
		m.mu.Unlock()
		tail := proc.StderrTail()
		_ = proc.Close()
		if tail != "" {
			return Info{}, fmt.Errorf("%w；stderr: %s", err, tail)
		}
		return Info{}, err
	}

	info := infoOf(sess)
	info.Provider = cfgSet.Selected.Provider
	info.Model = model
	info.Effort = effort
	return info, nil
}

// Get 按 id 取会话。
func (m *Manager) Get(id string) (*session.Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	return s, ok
}

// List 返回全部会话，按创建时间倒序。
func (m *Manager) List() []Info {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Info, 0, len(m.sessions))
	for id, s := range m.sessions {
		info := infoOf(s)
		if mt, ok := m.metas[id]; ok {
			info.Provider = mt.Provider
			info.Model = mt.Model
			info.Effort = mt.Effort
		}
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out
}

// pruneClosed 清理已经退出但还占着槽位的会话。
func (m *Manager) pruneClosed() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, s := range m.sessions {
		if s.State() != session.StateClosed {
			continue
		}
		delete(m.sessions, id)
		delete(m.procs, id)
		delete(m.metas, id)
	}
}

// Close 关闭并移除一个会话。
func (m *Manager) Close(id string) error {
	m.mu.Lock()
	sess, ok := m.sessions[id]
	proc := m.procs[id]
	delete(m.sessions, id)
	delete(m.procs, id)
	delete(m.metas, id)
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("manager: 会话 %s 不存在", id)
	}
	err := sess.Close()
	if proc != nil {
		_ = proc.Close()
	}
	return err
}

// CloseAll 关闭全部会话（进程退出时调用）。
func (m *Manager) CloseAll() {
	close(m.closing)
	m.mu.Lock()
	ids := make([]string, 0, len(m.sessions))
	for id := range m.sessions {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		_ = m.Close(id)
	}
}

// reapLoop 周期性回收空闲会话，避免 NAS 上常驻进程无限堆积。
func (m *Manager) reapLoop() {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-m.closing:
			return
		case <-t.C:
			m.reapIdle()
		}
	}
}

func (m *Manager) reapIdle() {
	deadline := time.Now().Add(-m.cfg.IdleTimeout)
	var victims []string
	m.mu.Lock()
	for id, s := range m.sessions {
		if s.State() == session.StateReady && s.LastActive().Before(deadline) {
			victims = append(victims, id)
		}
	}
	m.mu.Unlock()
	for _, id := range victims {
		_ = m.Close(id)
	}
}

// meta 记录会话创建时的提供商与模型（session 本身不关心这些）。
type meta struct {
	Provider string
	Model    string
	Effort   string
}

func infoOf(s *session.Session) Info {
	return Info{
		ID:         s.ID,
		Cwd:        s.Cwd,
		State:      s.State(),
		CreatedAt:  s.CreatedAt,
		LastActive: s.LastActive(),
	}
}

// newUUID 生成 RFC 4122 v4 UUID；claude 的 --session-id 要求这个格式。
func newUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(b[0:4]),
		hex.EncodeToString(b[4:6]),
		hex.EncodeToString(b[6:8]),
		hex.EncodeToString(b[8:10]),
		hex.EncodeToString(b[10:16]),
	), nil
}

func validUUID(id string) bool {
	if len(id) != 36 {
		return false
	}
	for i, r := range id {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if r != '-' {
				return false
			}
			continue
		}
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') && (r < 'A' || r > 'F') {
			return false
		}
	}
	return true
}
