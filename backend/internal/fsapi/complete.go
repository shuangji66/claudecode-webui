package fsapi

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// 输入框 `@` 补全的两种模式（与 DSH 的 file-reference 补全一致）：
//
//   - 查询为空、或者查询里出现过 `/`：只列 `src/co` 那样的**一层目录**，按最后一段
//     过滤。用户 Tab 进入目录后走的就是这条路，因此它必须实时反映磁盘。
//   - 查询里没有 `/`：在工作区里做**有界遍历**，按文件名/路径模糊打分排序。
//
// 两条路都只返回工作区内的相对路径：值被插入草稿，文件内容始终留给模型自己用
// Read 工具去读——补全索引里不装正文。

// 补全的预算与上限。
const (
	// DefaultCompleteLimit 是一次补全返回的候选数（与 DSH 的 20 条一致）。
	DefaultCompleteLimit = 20
	// MaxCompleteLimit 是调用方可以要求的硬上限：再多也显示不下。
	MaxCompleteLimit = 100
	// completeMaxEntries 是模糊搜索一次最多收集的条目数。工作区可能有几十万文件，
	// 按预算截断比让一次按键扫完整块盘更实际。
	completeMaxEntries = 8000
)

// completeSkipDirs 是两种模式都不进入/不展示的目录名。
//
// 与 DSH 的 DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES 同一份名单：版本库、依赖与
// 构建产物。`lib` 故意不在里面——Ruby / 部分 npm 包的源码就放在那儿。
var completeSkipDirs = map[string]struct{}{
	".git":          {},
	"node_modules":  {},
	"dist":          {},
	"build":         {},
	"out":           {},
	"coverage":      {},
	"target":        {},
	".next":         {},
	".nuxt":         {},
	".turbo":        {},
	".venv":         {},
	"__pycache__":   {},
	".pytest_cache": {},
	".mypy_cache":   {},
	".gradle":       {},
}

// Complete 返回 `@` 补全的候选。
//
// query 是 `@` 后面那段文本（引号写法里是引号内的内容）。目录不存在、越界、读不了
// 都只返回空候选而不是错误：用户还在打字，菜单需要的是一份列表，不是红字。
// ctx 用于在浏览器取消请求时尽快停下遍历。
func (r *Root) Complete(ctx context.Context, query string, limit int) (Listing, error) {
	if limit <= 0 {
		limit = DefaultCompleteLimit
	}
	if limit > MaxCompleteLimit {
		limit = MaxCompleteLimit
	}
	// Windows 客户端可能传反斜杠；统一成 POSIX 分隔符后再判断模式。
	q := strings.ReplaceAll(query, "\\", "/")
	if slash := strings.LastIndex(q, "/"); slash >= 0 {
		return r.completeInDir(q[:slash+1], q[slash+1:], limit), nil
	}
	if q == "" {
		return r.completeInDir("", "", limit), nil
	}
	return r.completeWorkspace(ctx, q, limit), nil
}

// completeInDir 列出 dir 这一层，按 fragment 过滤后排序。
func (r *Root) completeInDir(dir, fragment string, limit int) Listing {
	clean := strings.TrimSuffix(dir, "/")
	// 切片的空值必须是 `[]` 而不是 nil：JSON 里是 `null`，前端 `entries.filter`
	// 会当场 TypeError（与 settings 的「对外切片字段永远不能是 nil」同一条规矩）。
	empty := Listing{Root: r.Dir, Path: clean, Entries: make([]Entry, 0)}
	if clean != "" && excludedPath(clean) {
		return empty
	}
	listing, err := r.List(clean, true, 0)
	if err != nil {
		// 目录还不存在（用户正一路敲下去）、越界、没权限：空候选即可。
		return empty
	}
	// 隐藏项只在查询本身以 `.` 开头时才出现，否则 .env / .gitignore 会挤满菜单。
	hiddenQuery := strings.HasPrefix(fragment, ".")
	entries := make([]Entry, 0, len(listing.Entries))
	for _, entry := range listing.Entries {
		if entry.Type == "other" {
			continue
		}
		if !hiddenQuery && strings.HasPrefix(entry.Name, ".") {
			continue
		}
		if entry.Type == "dir" && excludedName(entry.Name) {
			continue
		}
		entries = append(entries, entry)
	}
	return Listing{Root: listing.Root, Path: listing.Path, Entries: rankEntries(entries, fragment, limit)}
}

// completeWorkspace 在工作区内做一次有界遍历，返回模糊匹配的前 limit 条。
//
// 广度优先（目录按名字顺序入队）而不是深度优先：预算被截断时至少先把浅层列全，
// 深层目录在菜单里本来也很少被选中。
func (r *Root) completeWorkspace(ctx context.Context, query string, limit int) Listing {
	hiddenQuery := strings.HasPrefix(query, ".") || strings.Contains(query, "/.")
	type pending struct{ abs, rel string }
	queue := []pending{{abs: r.Real}}
	entries := make([]Entry, 0, 256)
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
			// 读不了的子树只是少几条候选，别的分支照旧可用。
			continue
		}
		for _, item := range items {
			name := item.Name()
			if name == ".git" {
				continue
			}
			if !hiddenQuery && strings.HasPrefix(name, ".") {
				continue
			}
			// 不跟随符号链接：链接可能指向工作区外，补全不该把它写成可读路径。
			if item.Type()&os.ModeSymlink != 0 {
				continue
			}
			rel := name
			if dir.rel != "" {
				rel = dir.rel + "/" + name
			}
			switch {
			case item.IsDir():
				if excludedName(name) {
					continue
				}
				entries = append(entries, Entry{Name: name, Path: rel, Type: "dir"})
				queue = append(queue, pending{abs: filepath.Join(dir.abs, name), rel: rel})
			case item.Type().IsRegular():
				entries = append(entries, Entry{Name: name, Path: rel, Type: "file"})
			}
			if len(entries) >= completeMaxEntries {
				truncated = true
				break scan
			}
		}
	}
	return Listing{Root: r.Dir, Entries: rankEntries(entries, query, limit), Truncated: truncated}
}

// rankEntries 按「名字完全命中 > 前缀 > 名字包含 > 路径包含 > 子序列」排序。
//
// 分数与 DSH 的 scoreCandidate 同一套阈值（目录额外加分），排序的后续键是
// 「目录优先 → 路径短的优先 → 字典序」，保证同一份输入每次给出同一个顺序。
func rankEntries(entries []Entry, query string, limit int) []Entry {
	type scored struct {
		entry Entry
		score int
	}
	ranked := make([]scored, 0, len(entries))
	for _, entry := range entries {
		if score, ok := scoreEntry(entry.Path, entry.Type, query); ok {
			ranked = append(ranked, scored{entry: entry, score: score})
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		a, b := ranked[i], ranked[j]
		if a.score != b.score {
			return a.score > b.score
		}
		if (a.entry.Type == "dir") != (b.entry.Type == "dir") {
			return a.entry.Type == "dir"
		}
		if query != "" && len(a.entry.Path) != len(b.entry.Path) {
			return len(a.entry.Path) < len(b.entry.Path)
		}
		return a.entry.Path < b.entry.Path
	})
	if len(ranked) > limit {
		ranked = ranked[:limit]
	}
	out := make([]Entry, len(ranked))
	for i, item := range ranked {
		out[i] = item.entry
	}
	return out
}

func scoreEntry(path, kind, query string) (int, bool) {
	bonus := 0
	if kind == "dir" {
		bonus = 25
	}
	if query == "" {
		return bonus, true
	}
	lowerPath := strings.ToLower(path)
	name := lowerPath
	if i := strings.LastIndex(lowerPath, "/"); i >= 0 {
		name = lowerPath[i+1:]
	}
	needle := strings.ToLower(query)
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
	if score, ok := subsequenceScore(lowerPath, needle); ok {
		return 300 + score + bonus, true
	}
	return 0, false
}

// subsequenceScore 要求 needle 的字符按序出现在 target 里，间隔越小分越高。
func subsequenceScore(target, needle string) (int, bool) {
	targetIndex := 0
	gap := 0
	for _, char := range needle {
		found := strings.IndexRune(target[targetIndex:], char)
		if found < 0 {
			return 0, false
		}
		gap += found
		targetIndex += found + len(string(char))
	}
	return max(0, 100-gap), true
}

func excludedName(name string) bool {
	_, ok := completeSkipDirs[name]
	return ok
}

// excludedPath 判断相对路径的任意一段是否为不进入的目录。
func excludedPath(rel string) bool {
	for _, segment := range strings.Split(rel, "/") {
		if excludedName(segment) {
			return true
		}
	}
	return false
}
