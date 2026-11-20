// 任务存储：一条任务一行 JSON，整份文件原子替换。
//
// 为什么用单文件而不是每条一个文件：任务量是个位数到几十条，整份读改写最简单，
// 也不必处理「目录里出现半截文件」；代价是每次写全量，几十 KB 的 JSON 可以接受。
// 真正需要并发保护的是「读整份 → 改 → 写回」这一段，Store.mu 串行化它。
package schedule

import (
	"crypto/rand"
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

// 任务状态。
const (
	StatusActive = "active"
	StatusPaused = "paused"
	StatusEnded  = "ended" // 一次性任务投递完之后
)

// 投递目标。
const (
	// TargetConversation 投给指定的对话（用户在界面上选的「当前对话」）。
	TargetConversation = "conversation"
	// TargetNewReuse 首次投递时新建一个对话，之后一直复用它。
	TargetNewReuse = "new-reuse"
	// TargetNewEach 每次投递都新建一个对话（标题带时间）。
	TargetNewEach = "new-each"
)

// MaxDeliveries 是每条任务保留的投递记录条数。
//
// 和 DSH 一样，这里只是「指令投出去过」的确认，不是模型执行结果；
// 保留条数有上限，避免一条每分钟任务把文件撑爆。
const MaxDeliveries = 50

// ErrNotFound 表示任务不存在。
var ErrNotFound = errors.New("schedule: 任务不存在")

// ErrTooMany 表示任务数已达 MaxTasks。
var ErrTooMany = fmt.Errorf("schedule: 任务数已达上限 %d 条", MaxTasks)

// 字段上限：面板（HTTP 接口）与模型（`ccweb mcp-schedule`）共用同一套。
//
// 两处各写一份迟早漂移：面板挡住了超长内容、模型那条路照样能写进 10 MB 的指令，
// 而这条指令会在到点那一刻原样塞进对话上下文。
const (
	MaxNameLen   = 120
	MaxPromptLen = 4000
	// MaxTasks 是任务总数上限。模型能自己建任务，没有上限就等于给它一个把调度表
	// 撑爆的入口：每条任务每次 tick 都要算一次下一次、每写一次都是整份文件。
	MaxTasks = 100
)

// Validate 检查任务本身是否自洽（名称 / 内容 / 规则 / 投递目标）。
//
// 只覆盖与外部状态无关的规则：工作区是否授权、目标对话是否存在由调用方判断
// （schedule 包不认识工作区与会话）。错误文案直接进界面与工具结果，所以不加包名前缀。
func (t Task) Validate() error {
	name := strings.TrimSpace(t.Name)
	if name == "" {
		return errors.New("任务名称不能为空")
	}
	if len([]rune(name)) > MaxNameLen {
		return fmt.Errorf("任务名称最多 %d 个字符", MaxNameLen)
	}
	prompt := strings.TrimSpace(t.Prompt)
	if prompt == "" {
		return errors.New("任务内容不能为空")
	}
	if len([]rune(prompt)) > MaxPromptLen {
		return fmt.Errorf("任务内容最多 %d 个字符", MaxPromptLen)
	}
	switch t.Target.Kind {
	case TargetConversation:
		if strings.TrimSpace(t.Target.ConversationID) == "" {
			return errors.New("投递到现有对话时必须有对话 id")
		}
	case TargetNewReuse, TargetNewEach:
	default:
		return fmt.Errorf("未知的投递目标 %q", t.Target.Kind)
	}
	return t.Rule.Validate()
}

// Target 是投递目标。
type Target struct {
	Kind string `json:"kind"`
	// ConversationID 在 TargetConversation 下必填；TargetNewReuse 下首次投递后回填。
	ConversationID string `json:"conversation_id,omitempty"`
}

// Delivery 是一次投递记录。
type Delivery struct {
	At             time.Time `json:"at"`
	ConversationID string    `json:"conversation_id,omitempty"`
	Prompt         string    `json:"prompt"`
	// Error 非空表示这次投递失败（起会话失败、工作区失效等）。
	Error string `json:"error,omitempty"`
}

// Task 是一条自动化任务。
type Task struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Prompt    string `json:"prompt"`
	Target    Target `json:"target"`
	Workspace string `json:"workspace"`
	Rule      Rule   `json:"rule"`
	Status    string `json:"status"`
	// NextRun 是下一次计划投递时间（UTC 存储）；已结束的任务为 nil。
	NextRun *time.Time `json:"next_run,omitempty"`
	// UpdatedAt 同时充当乐观并发标记：界面保存时带上它，对不上就拒绝。
	UpdatedAt       time.Time  `json:"updated_at"`
	CreatedAt       time.Time  `json:"created_at"`
	LastDeliveredAt *time.Time `json:"last_delivered_at,omitempty"`
	LastError       string     `json:"last_error,omitempty"`
	Deliveries      []Delivery `json:"deliveries,omitempty"`
}

// Due 报告任务是否到了该投递的时间。
func (t Task) Due(now time.Time) bool {
	return t.Status == StatusActive && t.NextRun != nil && !t.NextRun.After(now)
}

// Clone 返回一份深拷贝：Store 把任务交出去之后，调用方改字段不能影响内部状态。
func (t Task) Clone() Task {
	out := t
	if t.NextRun != nil {
		v := *t.NextRun
		out.NextRun = &v
	}
	if t.LastDeliveredAt != nil {
		v := *t.LastDeliveredAt
		out.LastDeliveredAt = &v
	}
	out.Rule.Weekdays = append([]int(nil), t.Rule.Weekdays...)
	out.Deliveries = append([]Delivery(nil), t.Deliveries...)
	return out
}

type file struct {
	Version int    `json:"version"`
	Tasks   []Task `json:"tasks"`
}

// Store 是 schedules.json 的读写入口。
//
// 每次操作前先看文件的 mtime/size，变了就重新读一遍再改。这样两个进程能共用
// 同一份任务：主进程在用，`ccweb mcp-schedule` 子命令（模型创建提醒）也直接写
// 这个文件；只靠启动时读一次的话，一边写完另一边会把旧内容覆盖回去。
type Store struct {
	mu      sync.Mutex
	path    string
	data    file
	modTime time.Time
	size    int64
}

// Open 打开（或创建）任务文件。文件不存在时按空列表处理，不报错。
func Open(path string) (*Store, error) {
	if path == "" {
		return nil, errors.New("schedule: 缺少任务文件路径")
	}
	s := &Store{path: path, data: file{Version: 1}}
	raw, err := os.ReadFile(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return s, nil
	case err != nil:
		return nil, fmt.Errorf("schedule: 读取 %s: %w", path, err)
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &s.data); err != nil {
			// 坏文件不静默清空：那会把用户的任务全丢掉，而原因还看不出来。
			return nil, fmt.Errorf("schedule: 解析 %s: %w", path, err)
		}
	}
	if st, err := os.Stat(path); err == nil {
		s.modTime, s.size = st.ModTime(), st.Size()
	}
	return s, nil
}

// reloadLocked 在文件被别的进程改过时重新加载。调用方必须持锁。
func (s *Store) reloadLocked() error {
	st, err := os.Stat(s.path)
	if errors.Is(err, os.ErrNotExist) {
		s.data = file{Version: 1}
		s.modTime, s.size = time.Time{}, 0
		return nil
	}
	if err != nil {
		return fmt.Errorf("schedule: 读取 %s 的状态: %w", s.path, err)
	}
	if st.ModTime().Equal(s.modTime) && st.Size() == s.size {
		return nil
	}
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return fmt.Errorf("schedule: 读取 %s: %w", s.path, err)
	}
	var next file
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &next); err != nil {
			return fmt.Errorf("schedule: 解析 %s: %w", s.path, err)
		}
	}
	s.data = next
	s.modTime, s.size = st.ModTime(), st.Size()
	return nil
}

// Path 返回任务文件路径（MCP 子命令与界面都靠它定位同一份数据）。
func (s *Store) Path() string { return s.path }

// List 返回全部任务（按 NextRun 升序，已结束的排最后）。
func (s *Store) List() []Task {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.reloadLocked() // 读失败就用手上这份，不把界面打成报错
	out := make([]Task, 0, len(s.data.Tasks))
	for _, t := range s.data.Tasks {
		out = append(out, t.Clone())
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if (a.NextRun == nil) != (b.NextRun == nil) {
			return a.NextRun != nil
		}
		if a.NextRun != nil && b.NextRun != nil && !a.NextRun.Equal(*b.NextRun) {
			return a.NextRun.Before(*b.NextRun)
		}
		return a.CreatedAt.Before(b.CreatedAt)
	})
	return out
}

// Get 按 id 取一条任务。
func (s *Store) Get(id string) (Task, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.reloadLocked()
	for _, t := range s.data.Tasks {
		if t.ID == id {
			return t.Clone(), true
		}
	}
	return Task{}, false
}

// Create 追加一条任务并落盘（ID / CreatedAt / UpdatedAt 由这里补齐）。
//
// 上限在 Store 里挡，而不是各个入口各挡一次：模型那条路（MCP 子命令）与面板
// 写的是同一份文件，只在一边挡等于没挡。
func (s *Store) Create(t Task) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reloadLocked(); err != nil {
		return Task{}, err
	}
	if len(s.data.Tasks) >= MaxTasks {
		return Task{}, ErrTooMany
	}
	if t.ID == "" {
		id, err := newID()
		if err != nil {
			return Task{}, err
		}
		t.ID = id
	}
	now := time.Now()
	if t.CreatedAt.IsZero() {
		t.CreatedAt = now
	}
	t.UpdatedAt = now
	if t.Status == "" {
		t.Status = StatusActive
	}
	s.data.Tasks = append(s.data.Tasks, t.Clone())
	if err := s.save(); err != nil {
		// 落盘失败就把内存改动撤回来，否则界面显示成功、重启后消失。
		s.data.Tasks = s.data.Tasks[:len(s.data.Tasks)-1]
		return Task{}, err
	}
	return t.Clone(), nil
}

// Update 就地修改一条任务（用户编辑）；fn 返回错误时不落盘。
//
// 会推进 UpdatedAt，它同时是界面的乐观并发标记：用户在面板里保存时带着读到的那一版，
// 对不上就说明这条任务在别处被改过。
func (s *Store) Update(id string, fn func(*Task) error) (Task, error) {
	return s.update(id, fn, true)
}

// UpdateRun 就地修改一条任务（调度器自己的记账：投递时间、下一次、投递记录）。
//
// **不推进 UpdatedAt**：那条时间戳只表示「用户可见的字段变过」。投递也算一次改动的话，
// 一条每分钟任务会让用户在面板里永远存不进去（打开编辑器到点一次，保存就 409）。
// 调度器要改的字段（NextRun/LastDeliveredAt/LastError/Deliveries/Target.ConversationID）
// 都不是用户在编辑器里能改的，所以跳过这个标记是安全的。
func (s *Store) UpdateRun(id string, fn func(*Task) error) (Task, error) {
	return s.update(id, fn, false)
}

func (s *Store) update(id string, fn func(*Task) error, bump bool) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reloadLocked(); err != nil {
		return Task{}, err
	}
	for i := range s.data.Tasks {
		if s.data.Tasks[i].ID != id {
			continue
		}
		prev := s.data.Tasks[i].Clone()
		if err := fn(&s.data.Tasks[i]); err != nil {
			s.data.Tasks[i] = prev
			return prev, err
		}
		if bump {
			s.data.Tasks[i].UpdatedAt = time.Now()
		}
		if err := s.save(); err != nil {
			s.data.Tasks[i] = prev
			return prev, err
		}
		return s.data.Tasks[i].Clone(), nil
	}
	return Task{}, ErrNotFound
}

// Delete 删除一条任务。
func (s *Store) Delete(id string) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reloadLocked(); err != nil {
		return Task{}, err
	}
	for i := range s.data.Tasks {
		if s.data.Tasks[i].ID != id {
			continue
		}
		removed := s.data.Tasks[i].Clone()
		s.data.Tasks = append(s.data.Tasks[:i], s.data.Tasks[i+1:]...)
		if err := s.save(); err != nil {
			return Task{}, err
		}
		return removed, nil
	}
	return Task{}, ErrNotFound
}

// save 原子替换整份文件（同目录临时文件 + rename）。调用方必须持锁。
func (s *Store) save() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return fmt.Errorf("schedule: 创建目录: %w", err)
	}
	s.data.Version = 1
	raw, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return fmt.Errorf("schedule: 序列化任务: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".schedules-*.json")
	if err != nil {
		return fmt.Errorf("schedule: 创建临时文件: %w", err)
	}
	name := tmp.Name()
	defer func() { _ = os.Remove(name) }()
	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("schedule: 写入临时文件: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("schedule: 关闭临时文件: %w", err)
	}
	if err := os.Rename(name, s.path); err != nil {
		return fmt.Errorf("schedule: 替换 %s: %w", s.path, err)
	}
	// 记下新文件的指纹，免得下一次操作把「自己刚写的」当成别人改的再读一遍。
	if st, err := os.Stat(s.path); err == nil {
		s.modTime, s.size = st.ModTime(), st.Size()
	} else {
		s.modTime, s.size = time.Time{}, 0
	}
	return nil
}

func newID() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("schedule: 生成任务 id: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}
