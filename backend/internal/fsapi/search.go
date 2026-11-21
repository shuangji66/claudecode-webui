package fsapi

import (
	"context"
	"os"
	"path/filepath"
	"strings"
)

// 文件页搜索的预算与上限。
//
// 与 `@` 补全共用同一套目录排除名单（版本库、依赖、构建产物），但搜索是**显式**
// 的：用户输入什么就找什么，不做子序列模糊匹配（那会把一堆无关文件摊在结果里）。
const (
	// DefaultSearchLimit 是文件页搜索返回的候选数。
	DefaultSearchLimit = 200
	// MaxSearchLimit 是调用方可以要求的硬上限。
	MaxSearchLimit = 500
	// searchMaxEntries 是一次搜索最多考察的条目数：工作区可能有几十万文件，
	// 按预算截断比让一次按键扫完整块盘更实际。
	searchMaxEntries = 8000
	// searchMaxMatches 先收集这么多匹配再统一排序：边扫边按 limit 截断会让
	// 「精确命中」被前面碰到的路径包含挤掉。超过就停并标记 truncated。
	searchMaxMatches = 2000
	// searchMaxQuery 是查询长度上限（按 rune），与补全同一个数量级。
	searchMaxQuery = 256
)

// Search 在工作区内按「文件名 / 相对路径」做大小写不敏感的子串搜索。
//
// hidden 决定点开头的条目是否参与（与文件树的「显示隐藏文件」同一个开关）；
// `.git` 与依赖/构建目录永远跳过——它们不是用户要找的文件，翻它们只是让一次
// 按键在 NAS 上跑几秒。符号链接不跟随：链接可能指向工作区外，搜索结果不该
// 变成一条可读的越界路径。ctx 用于浏览器取消请求时尽快停下遍历。
func (r *Root) Search(ctx context.Context, query string, hidden bool, limit int) (Listing, error) {
	q := strings.ReplaceAll(query, "\\", "/")
	q = strings.TrimSpace(q)
	if runes := []rune(q); len(runes) > searchMaxQuery {
		q = string(runes[:searchMaxQuery])
	}
	out := Listing{Root: r.Dir, Entries: make([]Entry, 0)}
	if q == "" {
		return out, nil
	}
	if limit <= 0 {
		limit = DefaultSearchLimit
	}
	if limit > MaxSearchLimit {
		limit = MaxSearchLimit
	}
	needle := strings.ToLower(q)

	type pending struct{ abs, rel string }
	queue := []pending{{abs: r.Real}}
	matches := make([]Entry, 0, 64)
	considered := 0
	truncated := false

scan:
	for i := 0; i < len(queue); i++ {
		if ctx.Err() != nil {
			truncated = true
			break
		}
		dir := queue[i]
		items, err := os.ReadDir(dir.abs)
		if err != nil {
			// 读不了的子树只是少几条结果，别的分支照旧可用；但结果**不完整**这件事
			// 要告诉界面（NAS 上 ACL 缺一条很常见），否则用户会把「没搜到」当成真的没有。
			truncated = true
			continue
		}
		for _, item := range items {
			name := item.Name()
			if considered >= searchMaxEntries {
				truncated = true
				break scan
			}
			considered++
			// `.git` 永远跳过：对象库动辄几万条，而且用户找的从来不是它。
			if name == ".git" || item.Type()&os.ModeSymlink != 0 {
				continue
			}
			isDir := item.IsDir()
			if isDir && excludedName(name) {
				continue
			}
			if !hidden && strings.HasPrefix(name, ".") {
				continue
			}
			rel := name
			if dir.rel != "" {
				rel = dir.rel + "/" + name
			}
			kind := ""
			switch {
			case isDir:
				kind = "dir"
			case item.Type().IsRegular():
				kind = "file"
			default:
				// 设备文件 / 管道 / socket：不可预览，也不该出现在结果里。
				continue
			}
			if _, ok := searchScore(rel, kind, needle); ok {
				matches = append(matches, Entry{Name: name, Path: rel, Type: kind, Size: entrySize(item, kind)})
				if len(matches) >= searchMaxMatches {
					truncated = true
					break scan
				}
			}
			if isDir {
				queue = append(queue, pending{abs: filepath.Join(dir.abs, name), rel: rel})
			}
		}
	}

	if len(matches) > limit {
		truncated = true
	}
	out.Entries = rankEntriesWith(matches, q, limit, searchScore)
	out.Truncated = truncated
	return out, nil
}

// entrySize 给文件带上体积（前端的结果行显示它）；目录不带。
func entrySize(item os.DirEntry, kind string) int64 {
	if kind != "file" {
		return 0
	}
	info, err := item.Info()
	if err != nil {
		return 0
	}
	return info.Size()
}

// searchScore 只认子串（名字完全命中 > 前缀 > 名字包含 > 路径包含），
// needle 已经小写。目录额外加分，与补全的排序口径一致。
func searchScore(path, kind, needle string) (int, bool) {
	bonus := 0
	if kind == "dir" {
		bonus = 25
	}
	lowerPath := strings.ToLower(path)
	name := lowerPath
	if i := strings.LastIndex(lowerPath, "/"); i >= 0 {
		name = lowerPath[i+1:]
	}
	switch {
	case name == needle:
		return 1000 + bonus, true
	case strings.HasPrefix(name, needle):
		return 900 + bonus, true
	case strings.Contains(name, needle):
		return 700 + bonus, true
	case strings.Contains(lowerPath, needle):
		return 500 + bonus, true
	}
	return 0, false
}
