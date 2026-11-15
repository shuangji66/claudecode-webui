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
	ID         string    `json:"id"`
	Cwd        string    `json:"cwd"`
	State      string    `json:"state"`
	CreatedAt  time.Time `json:"created_at"`
	LastActive time.Time `json:"last_active"`
}

// Manager 持有全部常驻会话。
type Manager struct {
	cfg   config.Config
	bin   string
	store *settings.Store
	emit  func(sessionID string, ev session.Event)

	mu       sync.Mutex
	sessions map[string]*session.Session
	procs    map[string]*process.Proc

	closing chan struct{}
}

// New 构造 Manager。exePath 用于在程序同目录里发现 claude；
// store 提供第三方端点/密钥/默认模型等运行期配置。
func New(cfg config.Config, exePath string, store *settings.Store, emit func(string, session.Event)) (*Manager, error) {
	bin, err := process.Discover(cfg.ClaudeBin, exePath)
	if err != nil {
		return nil, err
	}
	m := &Manager{
		cfg:      cfg,
		bin:      bin,
		store:    store,
		emit:     emit,
		sessions: make(map[string]*session.Session),
		procs:    make(map[string]*process.Proc),
		closing:  make(chan struct{}),
	}
	go m.reapLoop()
	return m, nil
}

// Binary 返回已发现的 claude 路径。
func (m *Manager) Binary() string { return m.bin }

// Create 新建一个会话并完成握手。
func (m *Manager) Create(cwd, model, permissionMode string) (Info, error) {
	if cwd == "" {
		return Info{}, errors.New("manager: cwd 不能为空")
	}
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return Info{}, fmt.Errorf("manager: 解析 cwd: %w", err)
	}
	st, err := os.Stat(abs)
	if err != nil {
		return Info{}, fmt.Errorf("manager: 工作目录不可用: %w", err)
	}
	if !st.IsDir() {
		return Info{}, fmt.Errorf("manager: %s 不是目录", abs)
	}

	m.reapIdle()

	m.mu.Lock()
	if len(m.sessions) >= m.cfg.MaxSessions {
		m.mu.Unlock()
		return Info{}, ErrTooMany
	}
	m.mu.Unlock()

	// 运行期设置优先于启动期环境变量：设置页改完之后新会话立刻用新值。
	cfgSet := m.store.Get()
	if model == "" {
		model = cfgSet.Model
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
	args := process.Args(process.Options{
		Model:                  model,
		PermissionMode:         permissionMode,
		IncludePartialMessages: true,
	})
	// 先净化继承环境，再追加设置里的 ANTHROPIC_*（后者生效，从而覆盖宿主机同名变量）。
	env := process.CleanEnv(os.Environ(), m.cfg.ClaudeHome, abs)
	env = append(env, m.store.Env()...)

	proc, err := process.Spawn(m.bin, args, abs, env)
	if err != nil {
		return Info{}, err
	}

	id := newID()
	sess := session.New(id, abs, proc, func(ev session.Event) {
		if m.emit != nil {
			m.emit(id, ev)
		}
	})

	m.mu.Lock()
	m.sessions[id] = sess
	m.procs[id] = proc
	m.mu.Unlock()

	if err := sess.Start(); err != nil {
		m.mu.Lock()
		delete(m.sessions, id)
		delete(m.procs, id)
		m.mu.Unlock()
		tail := proc.StderrTail()
		_ = proc.Close()
		if tail != "" {
			return Info{}, fmt.Errorf("%w；stderr: %s", err, tail)
		}
		return Info{}, err
	}

	return infoOf(sess), nil
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
	for _, s := range m.sessions {
		out = append(out, infoOf(s))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out
}

// Close 关闭并移除一个会话。
func (m *Manager) Close(id string) error {
	m.mu.Lock()
	sess, ok := m.sessions[id]
	proc := m.procs[id]
	delete(m.sessions, id)
	delete(m.procs, id)
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

func infoOf(s *session.Session) Info {
	return Info{
		ID:         s.ID,
		Cwd:        s.Cwd,
		State:      s.State(),
		CreatedAt:  s.CreatedAt,
		LastActive: s.LastActive(),
	}
}

func newID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("s%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}
