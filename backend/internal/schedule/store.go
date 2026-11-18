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
	"sync"
	"time"
)

// 任务状态。
const (
	StatusActive  = "active"
	StatusPaused  = "paused"
	StatusEnded   = "ended" // 一次性任务投递完之后
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
type Store struct {
	mu   sync.Mutex
	path string
	data file
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
	return s, nil
}

// Path 返回任务文件路径（MCP 子命令与界面都靠它定位同一份数据）。
func (s *Store) Path() string { return s.path }

// List 返回全部任务（按 NextRun 升序，已结束的排最后）。
func (s *Store) List() []Task {
	s.mu.Lock()
	defer s.mu.Unlock()
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
	for _, t := range s.data.Tasks {
		if t.ID == id {
			return t.Clone(), true
		}
	}
	return Task{}, false
}

// Create 追加一条任务并落盘（ID / CreatedAt / UpdatedAt 由这里补齐）。
func (s *Store) Create(t Task) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
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

// Update 就地修改一条任务；fn 返回错误时不落盘。
func (s *Store) Update(id string, fn func(*Task) error) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.data.Tasks {
		if s.data.Tasks[i].ID != id {
			continue
		}
		prev := s.data.Tasks[i].Clone()
		if err := fn(&s.data.Tasks[i]); err != nil {
			s.data.Tasks[i] = prev
			return prev, err
		}
		s.data.Tasks[i].UpdatedAt = time.Now()
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
	return nil
}

func newID() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("schedule: 生成任务 id: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}
