// Package conversation 持久化「侧栏对话列表」的应用级元数据。
//
// claude 自己会把转录写进 ~/.claude/projects，但那份数据只有 id/cwd/标题，
// 没有归档、自定义标题、最后一次打开时间这些界面状态；本包只存这些增量，
// 转录本身仍然以 claude 的 jsonl 为准（见 history 包）。
//
// 文件落在 CCWEB_CONVERSATIONS_FILE（默认数据目录），权限 0600，原子替换。
package conversation

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ErrNotFound 表示对话没有应用级记录。
var ErrNotFound = errors.New("conversation: 对话不存在")

const fileVersion = 1

// Record 是一条对话的应用级状态。
type Record struct {
	ID string `json:"id"`
	// Cwd 是对话启动时的工作目录；用来按工作区分组与恢复。
	Cwd string `json:"cwd"`
	// Title 是用户重命名后的标题；空表示沿用转录里的首条消息。
	Title    string `json:"title,omitempty"`
	Archived bool   `json:"archived,omitempty"`
	// Pinned 是侧栏的「置顶」：只影响列表排序（置顶的排在同组最前），
	// 不参与 LastFor 的自动恢复——置顶不是「默认打开哪一条」。
	Pinned    bool      `json:"pinned,omitempty"`
	Deleted   bool      `json:"deleted,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	// LastActive 是最后一次打开/发送消息的时间，决定默认恢复哪一条。
	LastActive time.Time `json:"last_active"`
	Provider   string    `json:"provider,omitempty"`
	Model      string    `json:"model,omitempty"`
	Effort     string    `json:"effort,omitempty"`
	// Usage 是前端算好的用量快照（上下文 / 缓存命中 / tok/s 的原料）。
	// 后端不解释内容，只保证它是合法 JSON 对象；重开对话时原样返回给前端。
	Usage json.RawMessage `json:"usage,omitempty"`
}

// maxUsageBytes 是单条用量快照的上限：它只有几个数字，正常不到 200 字节。
const maxUsageBytes = 2 << 10

type storedFile struct {
	Version int               `json:"version"`
	Records map[string]Record `json:"records"`
}

// Store 是带锁的内存态 + 原子写盘。
type Store struct {
	opMu sync.Mutex
	mu   sync.RWMutex
	path string
	cur  storedFile
}

// Open 读取对话元数据文件；不存在时返回空存储（首次写入才落盘）。
func Open(path string) (*Store, error) {
	s := &Store{path: path}
	b, err := os.ReadFile(path)
	switch {
	case err == nil:
		if err := json.Unmarshal(b, &s.cur); err != nil {
			return nil, fmt.Errorf("conversation: 解析 %s: %w", path, err)
		}
		if s.cur.Records == nil {
			s.cur.Records = make(map[string]Record)
		}
		s.cur.Version = fileVersion
	case errors.Is(err, os.ErrNotExist):
		s.cur = storedFile{Version: fileVersion, Records: make(map[string]Record)}
	default:
		return nil, fmt.Errorf("conversation: 读取 %s: %w", path, err)
	}
	return s, nil
}

// Path 返回持久化文件路径。
func (s *Store) Path() string { return s.path }

// Get 返回一条对话记录。
func (s *Store) Get(id string) (Record, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rec, ok := s.cur.Records[id]
	return rec, ok
}

// List 返回全部记录（含已删除墓碑，由上层过滤）。
func (s *Store) List() []Record {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Record, 0, len(s.cur.Records))
	for _, rec := range s.cur.Records {
		out = append(out, rec)
	}
	return out
}

// Ensure 在记录不存在时插入；已存在时只补空字段，不覆盖用户状态。
// 用于把 history 里发现的老对话「收养」进应用状态。
func (s *Store) Ensure(rec Record) error {
	if strings.TrimSpace(rec.ID) == "" {
		return errors.New("conversation: id 不能为空")
	}
	return s.mutate(func(f *storedFile) error {
		cur, ok := f.Records[rec.ID]
		if !ok {
			if rec.CreatedAt.IsZero() {
				rec.CreatedAt = time.Now()
			}
			if rec.LastActive.IsZero() {
				rec.LastActive = rec.CreatedAt
			}
			f.Records[rec.ID] = rec
			return nil
		}
		if cur.Cwd == "" {
			cur.Cwd = rec.Cwd
		}
		if cur.CreatedAt.IsZero() {
			cur.CreatedAt = rec.CreatedAt
		}
		if cur.LastActive.IsZero() {
			cur.LastActive = rec.LastActive
		}
		f.Records[rec.ID] = cur
		return nil
	})
}

// Touch 更新对话的最近活跃时间；首次出现时创建记录。
func (s *Store) Touch(id, cwd string) error {
	if strings.TrimSpace(id) == "" {
		return errors.New("conversation: id 不能为空")
	}
	now := time.Now()
	return s.mutate(func(f *storedFile) error {
		rec, ok := f.Records[id]
		if !ok {
			rec = Record{ID: id, Cwd: filepath.Clean(cwd), CreatedAt: now}
		}
		if cwd != "" {
			rec.Cwd = filepath.Clean(cwd)
		}
		rec.LastActive = now
		f.Records[id] = rec
		return nil
	})
}

// SetUsage 保存一次用量快照；传 nil 表示清空。
//
// 只做「是不是合法 JSON 对象、有没有超长」两道校验：内容由前端从 CLI 的 usage 算出来，
// 后端没有能力也不应该重新推导。
func (s *Store) SetUsage(id string, usage json.RawMessage) error {
	if strings.TrimSpace(id) == "" {
		return errors.New("conversation: id 不能为空")
	}
	if len(usage) > maxUsageBytes {
		return fmt.Errorf("conversation: 用量快照超过 %d 字节", maxUsageBytes)
	}
	if len(usage) > 0 && !json.Valid(usage) {
		return errors.New("conversation: 用量快照不是合法 JSON")
	}
	return s.mutate(func(f *storedFile) error {
		rec, ok := f.Records[id]
		if !ok {
			return ErrNotFound
		}
		rec.Usage = append(json.RawMessage(nil), usage...)
		f.Records[id] = rec
		return nil
	})
}

// UpdateMeta 记录对话使用的提供商 / 模型 / 推理强度。
func (s *Store) UpdateMeta(id, provider, model, effort string) error {
	return s.mutate(func(f *storedFile) error {
		rec, ok := f.Records[id]
		if !ok {
			return ErrNotFound
		}
		if provider != "" {
			rec.Provider = provider
		}
		if model != "" {
			rec.Model = model
		}
		if effort != "" {
			rec.Effort = effort
		}
		f.Records[id] = rec
		return nil
	})
}

// Rename 设置自定义标题；空标题表示恢复转录标题。
func (s *Store) Rename(id, title string) error {
	return s.mutate(func(f *storedFile) error {
		rec, ok := f.Records[id]
		if !ok {
			return ErrNotFound
		}
		rec.Title = strings.TrimSpace(title)
		f.Records[id] = rec
		return nil
	})
}

// SetArchived 归档/取消归档一条对话。
func (s *Store) SetArchived(id string, archived bool) error {
	return s.mutate(func(f *storedFile) error {
		rec, ok := f.Records[id]
		if !ok {
			return ErrNotFound
		}
		rec.Archived = archived
		f.Records[id] = rec
		return nil
	})
}

// SetPinned 置顶/取消置顶一条对话。只影响列表排序，不动归档与最近活跃时间。
func (s *Store) SetPinned(id string, pinned bool) error {
	return s.mutate(func(f *storedFile) error {
		rec, ok := f.Records[id]
		if !ok {
			return ErrNotFound
		}
		rec.Pinned = pinned
		f.Records[id] = rec
		return nil
	})
}

// Delete 软删除一条对话：写墓碑而不是删转录文件，避免误删历史。
// 墓碑保证它不会再出现在列表里，转录仍可从历史记录里找回。
func (s *Store) Delete(id string) error {
	return s.mutate(func(f *storedFile) error {
		rec, ok := f.Records[id]
		if !ok {
			return ErrNotFound
		}
		rec.Deleted = true
		rec.Archived = false
		f.Records[id] = rec
		return nil
	})
}

// LastFor 返回 cwd（或它的子目录）下最近活跃、未归档、未删除的对话。
// 按最长工作区匹配由调用方保证；这里只要求 cwd 相等或位于其下。
func (s *Store) LastFor(cwd string) (Record, bool) {
	cwd = filepath.Clean(cwd)
	if cwd == "" || cwd == "." {
		return Record{}, false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	var best Record
	found := false
	for _, rec := range s.cur.Records {
		if rec.Deleted || rec.Archived || rec.Cwd == "" {
			continue
		}
		inside := rec.Cwd == cwd || strings.HasPrefix(rec.Cwd, cwd+string(filepath.Separator))
		if !inside {
			continue
		}
		if !found || rec.LastActive.After(best.LastActive) {
			best = rec
			found = true
		}
	}
	return best, found
}

// mutate 串行读改写；写盘成功后才发布内存态。
func (s *Store) mutate(fn func(*storedFile) error) error {
	s.opMu.Lock()
	defer s.opMu.Unlock()

	s.mu.RLock()
	next := storedFile{Version: s.cur.Version, Records: make(map[string]Record, len(s.cur.Records))}
	for id, rec := range s.cur.Records {
		next.Records[id] = rec
	}
	s.mu.RUnlock()

	if err := fn(&next); err != nil {
		return err
	}
	next.Version = fileVersion
	if err := writeFile(s.path, next); err != nil {
		return err
	}
	s.mu.Lock()
	s.cur = next
	s.mu.Unlock()
	return nil
}

func writeFile(path string, v storedFile) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("conversation: 创建目录: %w", err)
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("conversation: 序列化: %w", err)
	}
	b = append(b, '\n')

	tmp, err := os.CreateTemp(filepath.Dir(path), ".conversations-*")
	if err != nil {
		return fmt.Errorf("conversation: 创建临时文件: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("conversation: chmod: %w", err)
	}
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("conversation: 写入: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("conversation: sync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("conversation: 关闭: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("conversation: 替换: %w", err)
	}
	return nil
}
