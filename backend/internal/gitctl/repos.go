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
	// maxRepoScanDepth 是相对工作区根的最大深度（0 = 只看根自己）。
	maxRepoScanDepth = 3
	// maxRepoScanDirs 是一次扫描最多读取的目录数，超出就停。
	maxRepoScanDirs = 4000
	// maxRepos 是最多返回的仓库数。
	maxRepos = 50
)

// Repo 是工作区里的一个 Git 仓库。
type Repo struct {
	// Path 是相对工作区根的 POSIX 路径；工作区根自己就是仓库时为 ""。
	Path string `json:"path"`
	// Name 是展示名：仓库目录名（根仓库用工作区目录名）。
	Name string `json:"name"`
	// Root 是仓库的绝对路径，前端直接拿它当 git 请求的 cwd。
	Root string `json:"root"`
}

// FindRepos 列出 root 及其子目录里的 Git 仓库。
//
// 为什么需要它：一个工作区里常常并排放着好几个仓库，以前 Git 面板只看工作区根，
// 根不是仓库时整块面板就是「不是 Git 仓库」，明明子目录里就有仓库。
//
// 扫描刻意保守：不进隐藏目录、不进 node_modules（依赖里全是别人的 .git），
// 命中仓库后也不再往里钻（子模块/嵌套仓库不单独列出）；符号链接不跟随，
// 免得把扫描带出工作区。maxDepth<=0 时用默认深度。
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

	out := make([]Repo, 0, 4)
	scanned := 0
	var walk func(dir string, depth int) bool
	walk = func(dir string, depth int) bool {
		if scanned >= maxRepoScanDirs {
			return false
		}
		scanned++
		if hasGitDir(dir) {
			out = append(out, Repo{Path: relPath(abs, dir), Name: repoName(abs, dir), Root: dir})
			// 命中仓库就不再往下：子模块与嵌套仓库不属于这个面板的视角。
			return len(out) < maxRepos
		}
		if depth >= maxDepth {
			return true
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			// 没权限的子目录跳过即可，不该让整个列表失败。
			return true
		}
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			name := e.Name()
			if name == "node_modules" || strings.HasPrefix(name, ".") {
				continue
			}
			if !walk(filepath.Join(dir, name), depth+1) {
				return false
			}
		}
		return true
	}
	walk(abs, 0)

	sort.SliceStable(out, func(i, j int) bool {
		// 根仓库排最前，其余按名称（不区分大小写）排序。
		if (out[i].Path == "") != (out[j].Path == "") {
			return out[i].Path == ""
		}
		a, b := strings.ToLower(out[i].Name), strings.ToLower(out[j].Name)
		if a != b {
			return a < b
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// hasGitDir 判断目录是不是仓库根：.git 可能是目录（普通仓库）也可能是文件（worktree）。
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
