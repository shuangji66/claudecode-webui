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
