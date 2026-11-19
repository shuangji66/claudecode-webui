// Package fsapi 提供「工作区内文件浏览与预览」的安全路径层。
//
// 所有路径都相对某个工作区根（会话 cwd）解释，并做两道校验：
//  1. 词法上拒绝绝对路径与 `..` 越界；
//  2. 解析符号链接后再确认真实路径仍在工作区内。
//
// 这一层刻意不碰 HTTP：网关负责鉴权与响应编码，这里只返回结构体与错误，
// 便于单测把路径穿越、符号链接逃逸、二进制/超大文件等边界固定下来。
package fsapi

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

// 预览与列举的默认上限。
const (
	// DefaultEntries 是单层目录最多返回的条目数。
	DefaultEntries = 2000
	// MaxPreviewBytes 是文本预览读取上限；超过后返回截断内容。
	MaxPreviewBytes = 1 << 20
	// MaxRawBytes 是原始文件（图片 / PDF）下载上限。
	MaxRawBytes = 16 << 20
)

var (
	// ErrOutside 表示路径逃出了工作区（含符号链接逃逸）。
	ErrOutside = errors.New("fs: 路径超出工作区")
	// ErrNotRegular 表示目标不是普通文件。
	ErrNotRegular = errors.New("fs: 不是普通文件")
	// ErrTooLarge 表示原始文件超过预览上限。
	ErrTooLarge = errors.New("fs: 文件过大")
)

// Entry 是文件树的一行。
type Entry struct {
	Name string `json:"name"`
	// Path 是相对工作区根的 POSIX 风格路径，根目录下为文件名。
	Path string `json:"path"`
	// Type 取 dir / file / other。other 包括无法跟随的符号链接与设备文件。
	Type string `json:"type"`
	Size int64  `json:"size,omitempty"`
}

// Listing 是一层目录的返回。
type Listing struct {
	Root      string  `json:"root"`
	Path      string  `json:"path"`
	Entries   []Entry `json:"entries"`
	Truncated bool    `json:"truncated"`
}

// File 是文本预览的返回。
type File struct {
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	Binary    bool   `json:"binary"`
	Truncated bool   `json:"truncated"`
	Content   string `json:"content"`
}

// Root 是一个已解析的工作区根。
//
// Dir 是用户传入的原始（绝对）路径，Real 是解析符号链接后的真实路径；
// 读取时用 Real 做包含判断，返回给前端的仍是相对路径。
type Root struct {
	Dir  string
	Real string
}

// OpenRoot 校验 cwd 是真实存在的目录并解析符号链接。
func OpenRoot(cwd string) (*Root, error) {
	abs, err := filepath.Abs(strings.TrimSpace(cwd))
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		return nil, fmt.Errorf("fs: %s 不是目录", abs)
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, err
	}
	return &Root{Dir: filepath.Clean(abs), Real: filepath.Clean(real)}, nil
}

// Resolve 把相对路径解析成工作区内的真实绝对路径。
//
// rel 为空或 "." 表示根目录。返回的 relPath 统一为 POSIX 斜杠，便于前端拼接。
func (r *Root) Resolve(rel string) (abs, real, relPath string, err error) {
	clean, err := cleanRel(rel)
	if err != nil {
		return "", "", "", err
	}
	abs = filepath.Join(r.Dir, clean)
	real, err = filepath.EvalSymlinks(abs)
	if err != nil {
		return "", "", "", err
	}
	if !within(r.Real, real) {
		return "", "", "", ErrOutside
	}
	relPath = filepath.ToSlash(clean)
	if relPath == "." {
		relPath = ""
	}
	return abs, real, relPath, nil
}

// List 列出 rel 这一层目录的直接子项。
//
// 隐藏项（以 "." 开头）默认不显示；hidden=true 时按「显示隐藏文件」的含义**全部**列出，
// 包括 `.git`——工作区里明明有 `.git` 却看不见，用户会以为仓库没被认出来。
// 浏览本身是惰性的（每层只列直接子项、单层上限 DefaultEntries），不会一次翻出整个对象库。
// 排序为目录优先、名称不区分大小写。
func (r *Root) List(rel string, hidden bool, limit int) (Listing, error) {
	return r.listDir(rel, hidden, limit, nil)
}

// listDir 是 List 的内部形态：keep 非空时只保留它认可的条目。
//
// 过滤必须发生在**截断之前**：`@` 补全会给这一层传一个「按输入片段过滤」的 keep，
// 先按 2000 条截断再过滤的话，大目录里排在后面的文件永远补不出来（工作区模式的
// 模糊搜索能搜到同一个文件，两种视图就对不上了）。
func (r *Root) listDir(rel string, hidden bool, limit int, keep func(Entry) bool) (Listing, error) {
	_, real, relPath, err := r.Resolve(rel)
	if err != nil {
		return Listing{}, err
	}
	st, err := os.Stat(real)
	if err != nil {
		return Listing{}, err
	}
	if !st.IsDir() {
		return Listing{}, fmt.Errorf("fs: %s 不是目录", relPath)
	}
	if limit <= 0 || limit > DefaultEntries {
		limit = DefaultEntries
	}
	items, err := os.ReadDir(real)
	if err != nil {
		return Listing{}, err
	}
	out := Listing{Root: r.Dir, Path: relPath, Entries: make([]Entry, 0, len(items))}
	for _, item := range items {
		name := item.Name()
		if !hidden && strings.HasPrefix(name, ".") {
			continue
		}
		if len(out.Entries) >= limit {
			out.Truncated = true
			break
		}
		childRel := name
		if relPath != "" {
			childRel = relPath + "/" + name
		}
		// 解析符号链接，但只接受仍落在工作区内的目标；指向外部的链接标记 other，
		// 既不隐藏目录内容，也不会让点击预览绕过围栏。
		var entry Entry
		target, resolveErr := filepath.EvalSymlinks(filepath.Join(real, name))
		info, statErr := os.Stat(target)
		switch {
		case resolveErr != nil || !within(r.Real, target) || statErr != nil:
			entry = Entry{Name: name, Path: childRel, Type: "other"}
		case info.IsDir():
			entry = Entry{Name: name, Path: childRel, Type: "dir"}
		case info.Mode().IsRegular():
			entry = Entry{Name: name, Path: childRel, Type: "file", Size: info.Size()}
		default:
			entry = Entry{Name: name, Path: childRel, Type: "other"}
		}
		if keep != nil && !keep(entry) {
			continue
		}
		out.Entries = append(out.Entries, entry)
	}
	sort.SliceStable(out.Entries, func(i, j int) bool {
		a, b := out.Entries[i], out.Entries[j]
		if (a.Type == "dir") != (b.Type == "dir") {
			return a.Type == "dir"
		}
		an, bn := strings.ToLower(a.Name), strings.ToLower(b.Name)
		if an != bn {
			return an < bn
		}
		return a.Name < b.Name
	})
	return out, nil
}

// Read 读取文本预览。
//
// 超限文件返回前 MaxPreviewBytes 字节并标记 Truncated；含 NUL 或整体不是
// UTF-8 的内容标记 Binary 且不返回正文，避免把二进制塞进 JSON / DOM。
// 截断可能切在多字节字符中间，这里会回退到最后一个完整 rune。
func (r *Root) Read(rel string, maxBytes int) (File, error) {
	_, real, relPath, err := r.Resolve(rel)
	if err != nil {
		return File{}, err
	}
	st, err := os.Stat(real)
	if err != nil {
		return File{}, err
	}
	if !st.Mode().IsRegular() {
		return File{}, ErrNotRegular
	}
	if maxBytes <= 0 || maxBytes > MaxPreviewBytes {
		maxBytes = MaxPreviewBytes
	}
	f, err := os.Open(real)
	if err != nil {
		return File{}, err
	}
	defer f.Close()

	buf := make([]byte, maxBytes+1)
	n, err := io.ReadFull(f, buf)
	switch {
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		n = min(n, len(buf))
	case err != nil:
		return File{}, err
	}
	raw := buf[:n]
	truncated := n > maxBytes
	if truncated {
		raw = raw[:maxBytes]
	}
	out := File{Path: relPath, Size: st.Size(), Truncated: truncated}
	if looksBinary(raw) {
		out.Binary = true
		return out, nil
	}
	if truncated {
		raw = trimPartialRune(raw)
	}
	out.Content = string(raw)
	return out, nil
}

// OpenRaw 打开一个受大小限制的普通文件，供 HTTP 层做 inline 预览。
// 调用方负责关闭返回的文件。
func (r *Root) OpenRaw(rel string) (*os.File, os.FileInfo, string, error) {
	_, real, relPath, err := r.Resolve(rel)
	if err != nil {
		return nil, nil, "", err
	}
	st, err := os.Stat(real)
	if err != nil {
		return nil, nil, "", err
	}
	if !st.Mode().IsRegular() {
		return nil, nil, "", ErrNotRegular
	}
	if st.Size() > MaxRawBytes {
		return nil, nil, "", ErrTooLarge
	}
	f, err := os.Open(real)
	if err != nil {
		return nil, nil, "", err
	}
	return f, st, relPath, nil
}

func cleanRel(rel string) (string, error) {
	// 不 TrimSpace：文件名可以以空格开头/结尾，去掉会打开另一个文件。
	if rel == "" {
		return ".", nil
	}
	// Windows 客户端可能传反斜杠；统一后再判断。
	rel = filepath.FromSlash(strings.ReplaceAll(rel, "\\", "/"))
	if filepath.IsAbs(rel) {
		return "", ErrOutside
	}
	clean := filepath.Clean(rel)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", ErrOutside
	}
	return clean, nil
}

// within 判断 abs 是否等于 root 或位于其下。两者都应已解析符号链接。
func within(root, abs string) bool {
	root = filepath.Clean(root)
	abs = filepath.Clean(abs)
	if abs == root {
		return true
	}
	return strings.HasPrefix(abs, root+string(filepath.Separator))
}

// looksBinary 以 NUL 字节为二进制信号；没有 NUL 时要求样本是合法 UTF-8。
// 文本预览只读前 1 MiB，不能要求整个文件都合法（截断本身就会切坏 rune）。
func looksBinary(raw []byte) bool {
	if len(raw) == 0 {
		return false
	}
	if bytes.IndexByte(raw, 0) >= 0 {
		return true
	}
	// 允许尾部存在被截断的一半字符：先按 UTF-8 校验，失败时最多回退 3 字节。
	if utf8.Valid(raw) {
		return false
	}
	for i := 1; i <= 3 && i < len(raw); i++ {
		if utf8.Valid(raw[:len(raw)-i]) {
			return false
		}
	}
	return true
}

func trimPartialRune(raw []byte) []byte {
	for i := 0; i < 3 && len(raw) > 0; i++ {
		if utf8.Valid(raw) {
			return raw
		}
		raw = raw[:len(raw)-1]
	}
	return raw
}
