// Package workspace 管理「授权目录」与当前工作区。
//
// 语义（对齐 DSH 的工作区切换）：
//   - 用户把若干真实目录加入白名单，这些目录就是可选工作区；
//   - 同一时刻只有一个「当前工作区」，新建会话必须落在白名单内；
//   - 白名单持久化在 CCWEB_WORKSPACES_FILE（默认落在数据目录），权限 0600。
//
// 目录本身由操作者授权给本应用使用，因此这里不做沙箱：Path 是宿主路径，
// 是否可读可写由操作系统权限决定。网关仍会校验会话 cwd 必须落在白名单内。
package workspace

import (
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

// ErrNotFound 表示目录不在授权列表里。
var ErrNotFound = errors.New("workspace: 目录不在授权列表")

const fileVersion = 1

// Entry 是一条授权目录（运行期视图）。
type Entry struct {
	Path     string    `json:"path"`
	Name     string    `json:"name"`
	LastUsed time.Time `json:"last_used"`
	// Exists 是读取时探测的结果：目录可能被移动/删除，列表仍要能展示并提示。
	Exists bool `json:"exists"`
}

// storedEntry 是落盘形态；Exists 不入库，避免把一次探测结果永久化。
type storedEntry struct {
	Path     string    `json:"path"`
	Name     string    `json:"name"`
	LastUsed time.Time `json:"last_used"`
}

type storedFile struct {
	Version    int           `json:"version"`
	Current    string        `json:"current"`
	Workspaces []storedEntry `json:"workspaces"`
}

// Store 是带锁的内存态 + 原子写盘。
//
// 锁的层次：opMu 串行化「读-改-写」；mu 只保护内存快照；写盘在 mu 之外完成。
type Store struct {
	opMu sync.Mutex
	mu   sync.RWMutex
	path string
	cur  storedFile
}

// Open 读取授权目录文件。文件不存在时，把 seed（通常是 CCWEB_PROJECTS_ROOT）
// 作为首个授权目录写入；文件存在但为空则不自动补，尊重用户显式删除。
func Open(path, seed string) (*Store, error) {
	s := &Store{path: path}
	b, err := os.ReadFile(path)
	switch {
	case err == nil:
		if err := json.Unmarshal(b, &s.cur); err != nil {
			return nil, fmt.Errorf("workspace: 解析 %s: %w", path, err)
		}
		s.normalize()
	case errors.Is(err, os.ErrNotExist):
		if abs, ok := existingDir(seed); ok {
			now := time.Now()
			s.cur = storedFile{
				Version:    fileVersion,
				Current:    abs,
				Workspaces: []storedEntry{{Path: abs, Name: nameOf(abs), LastUsed: now}},
			}
			if err := writeFile(path, s.cur); err != nil {
				return nil, err
			}
		}
	default:
		return nil, fmt.Errorf("workspace: 读取 %s: %w", path, err)
	}
	return s, nil
}

// Path 返回授权目录文件路径。
func (s *Store) Path() string { return s.path }

// normalize 修正旧文件 / 手工编辑后的非法状态：去重、补名字、校正 current。
func (s *Store) normalize() {
	seen := make(map[string]bool, len(s.cur.Workspaces))
	out := make([]storedEntry, 0, len(s.cur.Workspaces))
	for _, e := range s.cur.Workspaces {
		p, ok := existingDir(e.Path)
		if !ok {
			// 目录暂时不可用也要保留：NAS 挂载可能晚于服务启动。
			p = filepath.Clean(e.Path)
			if !filepath.IsAbs(p) {
				continue
			}
		}
		if seen[p] {
			continue
		}
		seen[p] = true
		if e.Name == "" {
			e.Name = nameOf(p)
		}
		e.Path = p
		out = append(out, e)
	}
	s.cur.Version = fileVersion
	s.cur.Workspaces = out
	if s.cur.Current == "" || !seen[filepath.Clean(s.cur.Current)] {
		s.cur.Current = ""
		if len(out) > 0 {
			s.cur.Current = out[0].Path
		}
	}
}

// List 返回全部授权目录（按添加顺序），并实时探测目录是否存在。
func (s *Store) List() []Entry {
	s.mu.RLock()
	items := make([]storedEntry, len(s.cur.Workspaces))
	copy(items, s.cur.Workspaces)
	s.mu.RUnlock()

	out := make([]Entry, 0, len(items))
	for _, e := range items {
		_, err := os.Stat(e.Path)
		out = append(out, Entry{
			Path:     e.Path,
			Name:     e.Name,
			LastUsed: e.LastUsed,
			Exists:   err == nil,
		})
	}
	return out
}

// Current 返回当前工作区；没有授权目录时返回空串。
func (s *Store) Current() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.cur.Current != "" {
		return s.cur.Current
	}
	if len(s.cur.Workspaces) > 0 {
		return s.cur.Workspaces[0].Path
	}
	return ""
}

// AutoStartPath 返回适合启动会话的目录：优先当前工作区；它被移动/卸载时
// 退到第一个仍存在的授权目录；一个可用的都没有时返回空串。
func (s *Store) AutoStartPath() string {
	cur := s.Current()
	if st, err := os.Stat(cur); cur != "" && err == nil && st.IsDir() {
		return cur
	}
	for _, e := range s.List() {
		if e.Exists {
			return e.Path
		}
	}
	return ""
}

// Paths 返回全部授权目录路径，供网关做 cwd 校验。
func (s *Store) Paths() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, 0, len(s.cur.Workspaces))
	for _, e := range s.cur.Workspaces {
		out = append(out, e.Path)
	}
	return out
}

// Allows 报告 abs 是否落在某个授权目录内（目录本身或子目录）。
//
// abs 与授权项都按「解析符号链接后的真实路径」比对：网关会把 cwd 解析成真实路径
// 再进来，而授权项本身可能是一个软链（/data/ws -> /vol1/ws）。只比字符串会让
// 前一种情况被误判为越界，只比原始路径则会让「工作区里的软链指向外部」蒙混过关。
func (s *Store) Allows(abs string) bool {
	abs = filepath.Clean(abs)
	if !filepath.IsAbs(abs) {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, e := range s.cur.Workspaces {
		if withinDir(abs, e.Path) {
			return true
		}
		if real, err := filepath.EvalSymlinks(e.Path); err == nil && withinDir(abs, real) {
			return true
		}
	}
	return false
}

// withinDir 报告 abs 是否等于 root 或落在 root 之下（纯词法）。
func withinDir(abs, root string) bool {
	root = filepath.Clean(root)
	return abs == root || strings.HasPrefix(abs, root+string(filepath.Separator))
}

// Add 授权一个目录并把它设为当前工作区；已存在时仅刷新 last_used。
func (s *Store) Add(raw string) (Entry, error) {
	abs, ok := existingDir(raw)
	if !ok {
		return Entry{}, fmt.Errorf("workspace: 目录不可用: %s", strings.TrimSpace(raw))
	}
	if abs == string(filepath.Separator) {
		return Entry{}, errors.New("workspace: 不能授权文件系统根目录")
	}
	now := time.Now()
	var out Entry
	err := s.mutate(func(f *storedFile) error {
		for i := range f.Workspaces {
			if f.Workspaces[i].Path == abs {
				f.Workspaces[i].LastUsed = now
				f.Current = abs
				out = entryOf(f.Workspaces[i])
				return nil
			}
		}
		f.Workspaces = append(f.Workspaces, storedEntry{Path: abs, Name: nameOf(abs), LastUsed: now})
		f.Current = abs
		out = entryOf(f.Workspaces[len(f.Workspaces)-1])
		return nil
	})
	return out, err
}

// Remove 移除授权目录；当前工作区被移除时自动切到第一个剩余的目录。
func (s *Store) Remove(raw string) error {
	abs := filepath.Clean(raw)
	return s.mutate(func(f *storedFile) error {
		idx := -1
		for i := range f.Workspaces {
			if f.Workspaces[i].Path == abs {
				idx = i
				break
			}
		}
		if idx < 0 {
			return ErrNotFound
		}
		f.Workspaces = append(f.Workspaces[:idx], f.Workspaces[idx+1:]...)
		if f.Current == abs {
			f.Current = ""
			if len(f.Workspaces) > 0 {
				f.Current = f.Workspaces[0].Path
			}
		}
		return nil
	})
}

// Rename 只改授权目录的显示名，不动路径。
//
// 路径是授权键（会话 cwd、workspaces.json、前端当前工作区都按它匹配），
// 「重命名」只影响侧栏展示，绝不能顺手 os.Rename 真目录。name 为空时回落到目录名。
func (s *Store) Rename(raw, name string) (Entry, error) {
	abs := filepath.Clean(raw)
	name = strings.TrimSpace(name)
	if runes := []rune(name); len(runes) > 64 {
		name = string(runes[:64])
	}
	var out Entry
	err := s.mutate(func(f *storedFile) error {
		for i := range f.Workspaces {
			if f.Workspaces[i].Path != abs {
				continue
			}
			if name == "" {
				f.Workspaces[i].Name = nameOf(abs)
			} else {
				f.Workspaces[i].Name = name
			}
			out = entryOf(f.Workspaces[i])
			return nil
		}
		return ErrNotFound
	})
	return out, err
}

// SetCurrent 切换当前工作区并刷新 last_used。
func (s *Store) SetCurrent(raw string) error {
	abs := filepath.Clean(raw)
	return s.mutate(func(f *storedFile) error {
		for i := range f.Workspaces {
			if f.Workspaces[i].Path == abs {
				f.Workspaces[i].LastUsed = time.Now()
				f.Current = abs
				return nil
			}
		}
		return ErrNotFound
	})
}

// Touch 在会话创建成功后刷新当前工作区；路径不在白名单时静默忽略。
//
// 嵌套授权时（/data 与 /data/proj 同时存在）必须选最长匹配，
// 否则在子目录里开会话会把当前工作区悄悄切回父目录。
func (s *Store) Touch(raw string) {
	abs := filepath.Clean(raw)
	_ = s.mutate(func(f *storedFile) error {
		best := -1
		for i := range f.Workspaces {
			root := f.Workspaces[i].Path
			if abs != root && !strings.HasPrefix(abs, root+string(filepath.Separator)) {
				continue
			}
			if best < 0 || len(root) > len(f.Workspaces[best].Path) {
				best = i
			}
		}
		if best >= 0 {
			f.Workspaces[best].LastUsed = time.Now()
			f.Current = f.Workspaces[best].Path
		}
		return nil
	})
}

// SortedByRecent 返回按最近使用倒序的路径副本（不改变持久化顺序）。
func (s *Store) SortedByRecent() []string {
	s.mu.RLock()
	items := make([]storedEntry, len(s.cur.Workspaces))
	copy(items, s.cur.Workspaces)
	s.mu.RUnlock()
	sort.SliceStable(items, func(i, j int) bool { return items[i].LastUsed.After(items[j].LastUsed) })
	out := make([]string, 0, len(items))
	for _, e := range items {
		out = append(out, e.Path)
	}
	return out
}

// mutate 串行读改写：先复制内存态，在副本上应用变更，写盘成功后才发布。
// 这样写盘失败不会让内存与磁盘分叉，也不会在持锁时做 I/O。
func (s *Store) mutate(fn func(*storedFile) error) error {
	s.opMu.Lock()
	defer s.opMu.Unlock()

	s.mu.RLock()
	next := s.cur
	next.Workspaces = append([]storedEntry(nil), s.cur.Workspaces...)
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

func entryOf(e storedEntry) Entry {
	_, err := os.Stat(e.Path)
	return Entry{Path: e.Path, Name: e.Name, LastUsed: e.LastUsed, Exists: err == nil}
}

func existingDir(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", false
	}
	abs, err := filepath.Abs(raw)
	if err != nil {
		return "", false
	}
	st, err := os.Stat(abs)
	if err != nil || !st.IsDir() {
		return "", false
	}
	return filepath.Clean(abs), true
}

func nameOf(p string) string {
	base := filepath.Base(p)
	if base == "." || base == string(filepath.Separator) {
		return p
	}
	return base
}

// writeFile 原子替换授权目录文件；内容不含密钥，仍然用 0600 保持一致性。
func writeFile(path string, v storedFile) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("workspace: 创建目录: %w", err)
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("workspace: 序列化: %w", err)
	}
	b = append(b, '\n')

	tmp, err := os.CreateTemp(filepath.Dir(path), ".workspaces-*")
	if err != nil {
		return fmt.Errorf("workspace: 创建临时文件: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("workspace: chmod: %w", err)
	}
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("workspace: 写入: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("workspace: sync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("workspace: 关闭: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("workspace: 替换: %w", err)
	}
	return nil
}
