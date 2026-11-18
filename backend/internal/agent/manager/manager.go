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
	// toolRules 返回「本会话该预先允许 / 禁用的工具」，由装配层按内置搜索的状态接上
	// （见 SetToolRules）。为 nil 表示不加任何规则。
	toolRules func() (allow, deny []string)

	// createMu 只保护 creating 这张「正在创建」表，不覆盖 spawn 与握手。
	// 它保证同一个 key（会话 id 或目录）的并发创建共享一次结果：
	// 没有它时后端自动拉起与前端同时到达的 ensure 会各起一个 claude；
	// 而把整段 spawn+握手都放进来（旧行为）会让一个起不来的版本把所有人
	// 排队等满 InitTimeout=30s。
	createMu sync.Mutex
	creating map[string]*pendingCreate

	mu       sync.Mutex
	sessions map[string]*session.Session
	procs    map[string]*process.Proc
	metas    map[string]meta
	// closingSessions 记录正在关闭的会话：关闭要先把进程真的收掉再摘表，
	// 否则并发 Resume 会在「已摘表、进程未死」的窗口里给同一个 id 起第二个进程。
	closingSessions map[string]chan struct{}
	// spawning 是正在 spawn/握手、尚未登记进 sessions 的数量，用于上限判定。
	spawning int

	// capMu/caps 缓存「某个 claude 二进制是否认识某个参数」：面板能切换版本，
	// 给旧版本传未知参数会直接起不来，所以探测一次并缓存。
	capMu sync.Mutex
	caps  map[string]bool

	closing chan struct{}
}

// New 构造 Manager。resolve 提供当前要启动的 claude 路径（通常是
// claudebin 的当前版本）；store 提供第三方端点/密钥/默认模型等运行期配置。
//
// 这里不再做「找不到 claude 就启动失败」：二进制改成运行期从界面安装，
// 未安装时服务必须照常起来，否则用户没有入口去装。
func New(cfg config.Config, resolve func() (string, error), store *settings.Store, emit func(string, session.Event)) *Manager {
	m := &Manager{
		cfg:             cfg,
		resolve:         resolve,
		store:           store,
		emit:            emit,
		sessions:        make(map[string]*session.Session),
		procs:           make(map[string]*process.Proc),
		metas:           make(map[string]meta),
		caps:            make(map[string]bool),
		creating:        make(map[string]*pendingCreate),
		closingSessions: make(map[string]chan struct{}),
		closing:         make(chan struct{}),
	}
	go m.reapLoop()
	return m
}

// SetToolRules 接上「本会话的工具规则」取值函数。
//
// 规则只在会话启动时生效（--allowedTools / --disallowedTools 是命令行参数），
// 所以它在装配层按「内置搜索已启用且已注册」现算，而不在这里缓存。
// 只在装配阶段调用一次，之后不再改动（否则与 create 里的读取构成竞争）。
func (m *Manager) SetToolRules(fn func() (allow, deny []string)) {
	m.toolRules = fn
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

// pendingCreate 是一次正在进行的创建；同一 key 的并发调用共享它的结果。
type pendingCreate struct {
	done chan struct{}
	info Info
	err  error
}

// createOnce 让同一个 key（会话 id 或目录）的并发创建共享一次结果。
func (m *Manager) createOnce(key string, fn func() (Info, error)) (Info, error) {
	m.createMu.Lock()
	if prev, ok := m.creating[key]; ok {
		m.createMu.Unlock()
		<-prev.done
		return prev.info, prev.err
	}
	cur := &pendingCreate{done: make(chan struct{})}
	m.creating[key] = cur
	m.createMu.Unlock()

	cur.info, cur.err = fn()

	m.createMu.Lock()
	delete(m.creating, key)
	m.createMu.Unlock()
	close(cur.done)
	return cur.info, cur.err
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
	return m.createOnce("id:"+id, func() (Info, error) {
		return m.create(abs, id, "", model, permissionMode)
	})
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
	return m.createOnce("id:"+id, func() (Info, error) {
		// 正在关闭的旧进程必须先消失：否则 --resume 会与它同时往同一份
		// 转录里追加，Info.ID 也会同时对应两个活进程。
		m.waitClosed(id)
		if info, ok := m.infoByID(id); ok {
			if filepath.Clean(info.Cwd) != abs {
				return Info{}, errors.New("manager: 该对话属于其它工作目录")
			}
			return info, nil
		}
		return m.create(abs, id, id, model, permissionMode)
	})
}

// StartFresh 用**指定 id** 起一个全新的 claude 会话（`--session-id <id>`）。
//
// 给「claude 那边根本没有转录的对话」用（刚点「新对话」还没发过消息就退出、
// 转录被删）：`--resume` 会让 CLI 直接退出（stderr: No conversation found with
// session ID: …），而对话 id 不能换——转录文件名、conversations.json、前端
// activeId 都按它对齐（见根 AGENTS.md「对话 id 必须稳定」）。同 id 新建之后，
// 首条消息照旧写进这个 id 的转录，界面也不用重新指向另一个会话。
func (m *Manager) StartFresh(id, cwd, model, permissionMode string) (Info, error) {
	id = strings.TrimSpace(id)
	if !validUUID(id) {
		return Info{}, errors.New("manager: 非法的对话 id")
	}
	abs, err := normalizeCwd(cwd)
	if err != nil {
		return Info{}, err
	}
	// key 与 Resume 相同：同一个 id 的并发请求共享一次创建结果，不会起两个进程。
	return m.createOnce("id:"+id, func() (Info, error) {
		m.waitClosed(id)
		// 进程已经在跑就直接复用：fork 之后转录可能还没落盘，此时按「没有转录」
		// 走到这里，但那个进程正拿着同一份历史在跑——再起一个会把两份输出写进
		// 同一份转录。
		if info, ok := m.infoByID(id); ok {
			if filepath.Clean(info.Cwd) != abs {
				return Info{}, errors.New("manager: 该对话属于其它工作目录")
			}
			return info, nil
		}
		return m.create(abs, id, "", model, permissionMode)
	})
}

// ErrForkUnsupported 表示当前 claude 二进制不认识 --fork-session。
var ErrForkUnsupported = errors.New("manager: 当前 claude 版本不支持分叉会话（需要 --fork-session），请先在「设置 → 部署」升级")

// Fork 从已有对话复制出一个新会话：历史留在新 id 下，原会话完全不受影响。
//
// 新 id 由我们生成（不是 CLI 自造）：`--resume 旧 --fork-session --session-id 新`
// 在 2.1.326 实测可用，转录写入新文件、行内 sessionId 全部重写、旧文件字节不变。
// 原会话仍在跑也没关系——fork 只读旧转录；代价是它读到的结尾可能比此刻早一两条。
func (m *Manager) Fork(oldID, cwd, model, permissionMode string) (Info, error) {
	oldID = strings.TrimSpace(oldID)
	if !validUUID(oldID) {
		return Info{}, errors.New("manager: 非法的对话 id")
	}
	abs, err := normalizeCwd(cwd)
	if err != nil {
		return Info{}, err
	}
	bin, err := m.resolve()
	if err != nil {
		return Info{}, fmt.Errorf("manager: %w；请在「设置 → 部署」里安装 claude", err)
	}
	if !m.supportsFlag(bin, "--fork-session") {
		return Info{}, ErrForkUnsupported
	}
	id, err := newUUID()
	if err != nil {
		return Info{}, fmt.Errorf("manager: 生成会话 id: %w", err)
	}
	return m.createOnce("id:"+id, func() (Info, error) {
		return m.createWith(abs, id, oldID, model, permissionMode, true)
	})
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
// 「APP 启动自动拉起」与「切换工作区」都走这里：同一目录的并发调用会共享
// 一次创建，前端即便在自动启动完成前也发了一次 ensure，也不会多起 claude。
func (m *Manager) Ensure(cwd, model, permissionMode string) (Info, error) {
	abs, err := normalizeCwd(cwd)
	if err != nil {
		return Info{}, err
	}
	return m.createOnce("cwd:"+abs, func() (Info, error) {
		if info, ok := m.findByCwd(abs); ok {
			return info, nil
		}
		id, err := newUUID()
		if err != nil {
			return Info{}, fmt.Errorf("manager: 生成会话 id: %w", err)
		}
		return m.create(abs, id, "", model, permissionMode)
	})
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

// create 启动会话并完成握手。sessionID 是应用侧 / CLI 共用的 id；
// resumeID 非空时走 --resume。调用方通过 createOnce 去重，这里不再持 createMu。
func (m *Manager) create(abs, sessionID, resumeID, model, permissionMode string) (Info, error) {
	return m.createWith(abs, sessionID, resumeID, model, permissionMode, false)
}

// createWith 是 create 的完整形态：fork=true 时把 resumeID 的历史复制到 sessionID
// （--resume 旧 --fork-session --session-id 新），并允许两者同时出现。
func (m *Manager) createWith(abs, sessionID, resumeID, model, permissionMode string, fork bool) (Info, error) {
	m.reapIdle()
	m.pruneClosed()

	// 并发创建各自 spawn，上限必须把「正在 spawn、还没登记进 sessions」的算进来，
	// 否则两个请求可以同时通过检查、各起一个进程。
	m.mu.Lock()
	if len(m.sessions)+m.spawning >= m.cfg.MaxSessions {
		m.mu.Unlock()
		return Info{}, ErrTooMany
	}
	m.spawning++
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.spawning--
		m.mu.Unlock()
	}()

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
	// 先解析二进制：参数里的能力开关要按版本探测，不能盲加。
	bin, err := m.resolve()
	if err != nil {
		return Info{}, fmt.Errorf("manager: %w；请在「设置 → 部署」里安装 claude", err)
	}
	var allowTools, denyTools []string
	if m.toolRules != nil {
		allowTools, denyTools = m.toolRules()
	}
	args := process.Args(process.Options{
		Model:          model,
		PermissionMode: permissionMode,
		Effort:         effort,
		Resume:         resumeID,
		SessionID: func() string {
			// 普通 resume 不能再传 --session-id（id 已经由 --resume 指定）；
			// fork 恰恰要传：新会话的 id 必须是我们生成的这个 UUID。
			if resumeID == "" || fork {
				return sessionID
			}
			return ""
		}(),
		Fork:                   fork,
		IncludePartialMessages: true,
		ForwardSubagentText:    m.supportsFlag(bin, "--forward-subagent-text"),
		// 「跳过权限」要在会话里切得动，启动时就得带上这个能力开关；
		// 它不会让会话以 bypass 启动（实测带 + --permission-mode default 时首轮照常审批）。
		AllowBypassPermissions: m.supportsFlag(bin, "--allow-dangerously-skip-permissions"),
		AllowedTools:           allowTools,
		DisallowedTools:        denyTools,
	})
	// 先净化继承环境，再追加设置里的 ANTHROPIC_*（后者生效，从而覆盖宿主机同名变量）。
	env := process.CleanEnv(os.Environ(), m.cfg.ClaudeHome, abs)
	env = append(env, cfgSet.Env()...)

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

// SessionsUsing 返回从 bin 启动、仍在运行的会话 id（按字典序，便于比对）。
//
// 已经 closed 但还没被 pruneClosed 摘掉的会话不算：它不再持有进程，删掉它的
// 二进制也不会影响任何东西。
func (m *Manager) SessionsUsing(bin string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, 2)
	for id, proc := range m.procs {
		if proc.Bin() != bin {
			continue
		}
		if s, ok := m.sessions[id]; ok && s.State() == session.StateClosed {
			continue
		}
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// CloseSessionsUsing 结束从 bin 启动的全部会话，返回真正关掉的 id。
//
// 删除某个版本目录前必须走这一趟：切换版本只影响新会话，旧进程会把一份已经
// 被删掉的二进制继续跑在内存里——事后既说不清它跑的是哪个版本，进程本身也可能
// 因为再也找不到自己的文件而行为异常。Close 内部等进程真正退出（SIGTERM →
// 2 秒 → SIGKILL → Wait），所以返回之后不会再有进程引用这个二进制。
func (m *Manager) CloseSessionsUsing(bin string) []string {
	ids := m.SessionsUsing(bin)
	closed := make([]string, 0, len(ids))
	for _, id := range ids {
		if err := m.Close(id); err != nil {
			continue
		}
		closed = append(closed, id)
	}
	return closed
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
//
// 顺序是「标记 closing → 收掉进程 → 摘表」：旧实现先摘表再 kill，中间那段窗口里
// 并发的 Resume 会判定「不存在」，于是以同一个 uuid 再 spawn 一个进程，两个进程
// 同时往同一份转录追加。
func (m *Manager) Close(id string) error {
	m.mu.Lock()
	if ch, ok := m.closingSessions[id]; ok {
		// 已经有人在关，等它收完即可（幂等）。
		m.mu.Unlock()
		<-ch
		return nil
	}
	sess, ok := m.sessions[id]
	proc := m.procs[id]
	var done chan struct{}
	if ok {
		done = make(chan struct{})
		m.closingSessions[id] = done
	}
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("manager: 会话 %s 不存在", id)
	}

	err := sess.Close()
	if proc != nil {
		_ = proc.Close()
	}

	m.mu.Lock()
	delete(m.sessions, id)
	delete(m.procs, id)
	delete(m.metas, id)
	delete(m.closingSessions, id)
	m.mu.Unlock()
	close(done)
	return err
}

// waitClosed 等待某个 id 的关闭流程结束（可能连续多轮）。
func (m *Manager) waitClosed(id string) {
	for {
		m.mu.Lock()
		ch, ok := m.closingSessions[id]
		m.mu.Unlock()
		if !ok {
			return
		}
		<-ch
	}
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
