package gitctl

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// 扫描上限：一个工作区里可能挂着几百个目录，扫描必须廉价且有界。
const (
	// maxRepoScanDepth 是相对扫描根的最大深度（0 = 只看根自己）。
	maxRepoScanDepth = 3
	// maxNestedRepoDepth 是命中仓库之后、在它内部继续找嵌套仓库的层数。
	// 子模块与独立检出常挂在 `vendor/<名字>` / `third_party/<名字>`，
	// 再往深处翻只是在别人的仓库里走目录。
	maxNestedRepoDepth = 3
	// maxRepoScanDirs / maxNestedScanDirs 是两遍扫描各自最多读取的目录数。
	// 分开计数：一棵目录很多的大仓库不能把「旁边的兄弟仓库」的预算吃光。
	maxRepoScanDirs   = 4000
	maxNestedScanDirs = 1200
	// maxRepos 是最多返回的仓库数。
	maxRepos = 50
)

// Repo 是工作区里的一个 Git 仓库。
type Repo struct {
	// Path 是相对扫描根的 POSIX 路径；扫描根自己就是仓库时为 ""。
	Path string `json:"path"`
	// Name 是展示名：仓库目录名（根仓库用工作区目录名）。
	Name string `json:"name"`
	// Root 是仓库的绝对路径，前端直接拿它当 git 请求的 cwd。
	Root string `json:"root"`
	// Nested 表示这个仓库落在另一个仓库里面（子模块 / 嵌套检出）。
	// 界面据此把它排在父仓库后面并标出层级，而不是当成并列的兄弟仓库。
	Nested bool `json:"nested,omitempty"`
}

// FindRepos 列出 root 及其子目录里的 Git 仓库，包括仓库内部的嵌套仓库。
//
// 为什么需要它：一个工作区里常常并排放着好几个仓库，以前 Git 面板只看工作区根，
// 根不是仓库时整块面板就是「不是 Git 仓库」，明明子目录里就有仓库。
//
// 扫描分两遍：
//  1. 从 root 向下找仓库，**命中即停**（子目录里可能有几万个文件，没必要继续翻）；
//  2. 再对每个命中的仓库做一次浅扫描（maxNestedRepoDepth 层），把子模块与嵌套检出
//     单独列出来。
//
// 分两遍而不是「一遍命中后继续下钻」：后者会让第一个大仓库在预算里跑光，
// 排在它后面的兄弟仓库一个都出不来。两遍各自记账、第二遍按广度优先，先近后远。
//
// 两遍都刻意保守：不进隐藏目录、不进 node_modules（依赖里全是别人的 .git）、
// 符号链接不跟随，免得把扫描带出工作区。maxDepth<=0 时用默认深度。
func FindRepos(root string, maxDepth int) ([]Repo, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("git: 解析工作区路径: %w", err)
	}
	st, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		return nil, fmt.Errorf("git: %s 不是目录", abs)
	}
	if maxDepth <= 0 {
		maxDepth = maxRepoScanDepth
	}

	// 第一遍：外层仓库（命中即停）。
	//
	// 按**广度优先**走：同一层的目录先全部看完，再进下一层。深度优先时排在前面
	// 的一棵大树（它不一定是仓库）能把目录预算吃光，同层的兄弟仓库就一个都出不来。
	outer := make([]string, 0, 4)
	scanned := 0
	type scanItem struct {
		dir   string
		depth int
	}
	queue := []scanItem{{dir: abs}}
	for i := 0; i < len(queue); i++ {
		if scanned >= maxRepoScanDirs || len(outer) >= maxRepos {
			break
		}
		it := queue[i]
		scanned++
		if hasGitDir(it.dir) {
			outer = append(outer, it.dir)
			// 命中仓库就不再往下：嵌套仓库交给第二遍。
			continue
		}
		if it.depth >= maxDepth {
			continue
		}
		entries, err := os.ReadDir(it.dir)
		if err != nil {
			// 没权限的子目录跳过即可，不该让整个列表失败。
			continue
		}
		for _, e := range entries {
			if !e.IsDir() || skipScanDir(e.Name()) {
				continue
			}
			queue = append(queue, scanItem{dir: filepath.Join(it.dir, e.Name()), depth: it.depth + 1})
		}
	}

	// 第二遍：外层仓库内部的嵌套仓库。即便预算用尽，已经找到的仓库照常返回。
	nested := make([]string, 0, 4)
	budget := maxNestedScanDirs
	for _, repo := range outer {
		if len(outer)+len(nested) >= maxRepos || budget <= 0 {
			break
		}
		scanNestedRepos(repo, &nested, &budget, maxRepos-len(outer))
	}

	out := make([]Repo, 0, len(outer)+len(nested))
	seen := make(map[string]bool, len(outer)+len(nested))
	appendRepo := func(dir string, isNested bool) {
		if seen[dir] || len(out) >= maxRepos {
			return
		}
		seen[dir] = true
		out = append(out, Repo{Path: relPath(abs, dir), Name: repoName(abs, dir), Root: dir, Nested: isNested})
	}
	for _, dir := range outer {
		appendRepo(dir, false)
	}
	for _, dir := range nested {
		appendRepo(dir, true)
	}

	sort.SliceStable(out, func(i, j int) bool {
		// 根仓库排最前，其余按相对路径排：父仓库在前、它内部的嵌套仓库紧随其后。
		if (out[i].Path == "") != (out[j].Path == "") {
			return out[i].Path == ""
		}
		a, b := strings.ToLower(out[i].Path), strings.ToLower(out[j].Path)
		if a != b {
			return a < b
		}
		return out[i].Path < out[j].Path
	})
	return out, nil
}

// scanNestedRepos 在 repo 内部按广度优先找嵌套仓库。
//
// budget 是跨仓库共享的目录预算；remaining 是嵌套仓库的总名额。
// 命中之后**继续下钻**：嵌套仓库里还可能有下一层（子模块套子模块），
// 深度上限本来就很小，不必为它单开一遍递归。
func scanNestedRepos(repo string, out *[]string, budget *int, remaining int) {
	type item struct {
		dir   string
		depth int
	}
	queue := []item{{dir: repo}}
	for i := 0; i < len(queue); i++ {
		it := queue[i]
		if it.depth >= maxNestedRepoDepth {
			continue
		}
		entries, err := os.ReadDir(it.dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() || skipScanDir(e.Name()) {
				continue
			}
			if *budget <= 0 || len(*out) >= remaining {
				return
			}
			*budget--
			child := filepath.Join(it.dir, e.Name())
			if hasGitDir(child) {
				*out = append(*out, child)
			}
			queue = append(queue, item{dir: child, depth: it.depth + 1})
		}
	}
}

// skipScanDir 是扫描时一律不进目录名：点开头的（含 .git）与依赖目录。
func skipScanDir(name string) bool {
	return name == "node_modules" || strings.HasPrefix(name, ".")
}

// EnclosingRepo 返回包含 dir 的最内层仓库根；不在任何仓库里时返回空串。
//
// 会话目录可能落在仓库的子目录里（工作区只授权了仓库下面的一层），
// 只从工作区往下扫是找不到那个仓库的。这里从 dir 往上找 `.git`：
// 与 FindRepos 用同一个判据，worktree / 子模块也能认出来。
func EnclosingRepo(dir string) string {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return ""
	}
	for {
		if hasGitDir(abs) {
			return abs
		}
		parent := filepath.Dir(abs)
		if parent == abs {
			return ""
		}
		abs = parent
	}
}

// hasGitDir 判断目录是不是仓库根：.git 可能是目录（普通仓库）也可能是文件（worktree/子模块）。
func hasGitDir(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil
}

// relPath 返回 dir 相对 base 的 POSIX 路径；根目录返回空串。
func relPath(base, dir string) string {
	rel, err := filepath.Rel(base, dir)
	if err != nil || rel == "." {
		return ""
	}
	return filepath.ToSlash(rel)
}

// repoName 是仓库的展示名：仓库目录名；根仓库用工作区目录名（根目录名可能是 / 或 .）。
func repoName(base, dir string) string {
	name := filepath.Base(dir)
	if dir == base {
		if name == "/" || name == "." || name == string(filepath.Separator) {
			return dir
		}
	}
	return name
}
