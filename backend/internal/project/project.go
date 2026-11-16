// Package project 负责工作目录（项目）的枚举与校验。
//
// 新建会话必须指定一个真实存在的目录作为 cwd；前端的选择列表来自这里。
package project

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Entry 是一个可选的项目目录。
type Entry struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	HasGit bool   `json:"has_git"`
}

// DefaultLimit 是枚举返回的最大条目数。
const DefaultLimit = 200

// List 列出 root 下的直接子目录（跳过隐藏目录），按名称排序。
func List(root string, limit int) ([]Entry, error) {
	if limit <= 0 {
		limit = DefaultLimit
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		abs := filepath.Join(root, e.Name())
		_, gitErr := os.Stat(filepath.Join(abs, ".git"))
		out = append(out, Entry{Name: e.Name(), Path: abs, HasGit: gitErr == nil})
		if len(out) >= limit {
			break
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// Validate 校验一个目录可作为会话 cwd。
func Validate(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", errors.New("project: 目录不能为空")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	if !st.IsDir() {
		return "", errors.New("project: 不是目录")
	}
	return abs, nil
}

// Dir 是目录选择器里的一行。
type Dir struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// BrowseResult 是目录选择器的一次浏览结果。
type BrowseResult struct {
	Path    string `json:"path"`
	Parent  string `json:"parent"`
	Entries []Dir  `json:"entries"`
}

// Browse 列出一个目录下的直接子目录，供「添加授权目录」的浏览弹窗使用。
// hidden 为 true 时连同以点开头的目录一起返回；不可读的条目跳过而不是整体失败，
// 因为 NAS 上常有 root 专属目录，用户仍然应该能进入其余目录。
func Browse(path string, hidden bool, limit int) (BrowseResult, error) {
	abs, err := Validate(path)
	if err != nil {
		return BrowseResult{}, err
	}
	if limit <= 0 {
		limit = DefaultLimit
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return BrowseResult{}, err
	}
	out := BrowseResult{Path: abs, Parent: filepath.Dir(abs), Entries: make([]Dir, 0, len(entries))}
	for _, e := range entries {
		if len(out.Entries) >= limit {
			break
		}
		name := e.Name()
		if !hidden && strings.HasPrefix(name, ".") {
			continue
		}
		child := filepath.Join(abs, name)
		isDir := e.IsDir()
		if e.Type()&os.ModeSymlink != 0 {
			// 符号链接指向目录时也允许进入；Stat 失败则按普通文件跳过。
			if st, statErr := os.Stat(child); statErr == nil && st.IsDir() {
				isDir = true
			}
		}
		if !isDir {
			continue
		}
		out.Entries = append(out.Entries, Dir{Name: name, Path: child})
	}
	sort.Slice(out.Entries, func(i, j int) bool { return out.Entries[i].Name < out.Entries[j].Name })
	return out, nil
}

// Mkdir 在 parent 下新建一个子目录，返回子目录的绝对路径。
//
// 只接受单层目录名：远程传进来的字符串不能带分隔符，也不能是 . / ..，
// 否则「新建文件夹」就成了任意路径写入口。父目录必须已存在，同名冲突直接报错
// （静默复用会让用户以为建了另一个目录）。
func Mkdir(parent, name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errors.New("project: 目录名不能为空")
	}
	if name == "." || name == ".." || strings.ContainsAny(name, "/\\") || strings.ContainsRune(name, 0) {
		return "", errors.New("project: 目录名不能包含路径分隔符")
	}
	abs, err := Validate(parent)
	if err != nil {
		return "", err
	}
	child := filepath.Join(abs, name)
	if err := os.Mkdir(child, 0o755); err != nil {
		if errors.Is(err, os.ErrExist) {
			return "", errors.New("project: 同名目录已存在")
		}
		return "", err
	}
	return child, nil
}
