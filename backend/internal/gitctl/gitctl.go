// Package gitctl 是右侧栏 Git 面板的只读/轻写后端。
//
// 实现参考 dsh-better-sidebar 的 src/git.ts（MIT，见 THIRD_PARTY_NOTICES.md）：
// 每次都 spawn 系统 git（无状态、无 libgit2），输出用 -z / 单元分隔符解析，
// 固定 -C <cwd> --no-pager -c color.ui=false -c core.quotePath=false，
// 让中文路径与空白路径原样返回。提交沿用用户全局身份，绝不设置 user.name/email。
//
// 安全边界：
//   - cwd 由网关校验必须落在授权目录内；
//   - path 只接受仓库内相对路径，拒绝绝对路径与 `..` 分量；
//   - 所有路径参数前加 --literal-pathspecs，防止 `a[1].txt` 被当通配符误伤；
//   - rev / hash / 分支前加 --end-of-options，防止以 `-` 开头的参数变成选项。
package gitctl

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"ccweb/backend/internal/netproxy"
)

// 输出与行数上限：一个病态仓库不能把网关内存打爆。
const (
	maxOutputBytes = 8 << 20
	maxEntries     = 2000
	commandTimeout = 25 * time.Second
)

// LineCounts 是一侧的增删行数；Binary 为 true 时表示 git 报告 `-`/`-`。
type LineCounts struct {
	Additions int  `json:"additions"`
	Deletions int  `json:"deletions"`
	Binary    bool `json:"binary,omitempty"`
}

// StatusEntry 是 `git status --porcelain=v2` 的一条文件记录。
//
// XY 保留 git 的两位语义（X=索引侧，Y=工作区侧，`??` 表示未跟踪）。
// Staged/Unstaged 是该侧 numstat 的结果；nil 表示 git 没有这一侧的统计
// （未跟踪文件没有统计），不要把它渲染成 +0 −0。
type StatusEntry struct {
	Path     string      `json:"path"`
	XY       string      `json:"xy"`
	Staged   *LineCounts `json:"staged,omitempty"`
	Unstaged *LineCounts `json:"unstaged,omitempty"`
}

// Snapshot 是 Git 面板快照。
type Snapshot struct {
	IsRepo    bool          `json:"is_repo"`
	Branch    string        `json:"branch,omitempty"`
	Upstream  string        `json:"upstream,omitempty"`
	Ahead     int           `json:"ahead,omitempty"`
	Behind    int           `json:"behind,omitempty"`
	Detached  bool          `json:"detached,omitempty"`
	Entries   []StatusEntry `json:"entries"`
	Truncated bool          `json:"truncated,omitempty"`
	Root      string        `json:"root,omitempty"`
}

// LogEntry 是 `git log` 的一行。
type LogEntry struct {
	Hash     string   `json:"hash"`
	HashFull string   `json:"hash_full"`
	Parents  []string `json:"parents"`
	Subject  string   `json:"subject"`
	Author   string   `json:"author"`
	Date     string   `json:"date"`
	Refs     string   `json:"refs"`
}

// BranchList 是本地分支清单。
type BranchList struct {
	Current string   `json:"current"`
	Names   []string `json:"names"`
}

// CommandError 是一次 git 失败；Message 优先取 stderr，便于前端直接展示。
type CommandError struct {
	Args    []string
	Message string
	Code    int
}

func (e *CommandError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return fmt.Sprintf("git %s 退出码 %d", strings.Join(e.Args, " "), e.Code)
}

// IsNotRepo 判断错误是否只是「不在仓库里」。
func IsNotRepo(err error) bool {
	if err == nil {
		return false
	}
	var ce *CommandError
	if errors.As(err, &ce) {
		return strings.Contains(strings.ToLower(ce.Message), "not a git repository")
	}
	return false
}

// ReadStatus 读取仓库快照；cwd 不在仓库内时返回 IsRepo=false 而不是错误。
func ReadStatus(ctx context.Context, cwd string) (Snapshot, error) {
	root, err := repoRoot(ctx, cwd)
	if err != nil {
		if IsNotRepo(err) {
			return Snapshot{IsRepo: false, Entries: []StatusEntry{}}, nil
		}
		return Snapshot{}, err
	}
	raw, err := run(ctx, root,
		"status", "--porcelain=v2", "--branch", "--ahead-behind", "-z", "--untracked-files=all")
	if err != nil {
		return Snapshot{}, err
	}
	status := parseStatus(raw)
	status.Root = root
	if len(status.Entries) > maxEntries {
		status.Truncated = true
		status.Entries = status.Entries[:maxEntries]
	}
	if len(status.Entries) == 0 {
		return status, nil
	}

	// numstat 只是 UI 的行数徽标，失败时降级为「没有统计」，不能拖垮整个面板。
	if staged, err := run(ctx, root, "diff", "--cached", "--numstat", "-z"); err == nil {
		applyCounts(status.Entries, parseNumstat(staged), true)
	}
	if unstaged, err := run(ctx, root, "diff", "--numstat", "-z"); err == nil {
		applyCounts(status.Entries, parseNumstat(unstaged), false)
	}
	return status, nil
}

// Diff 返回工作区（staged=false）或索引（staged=true）相对 HEAD 的补丁。
func Diff(ctx context.Context, cwd, path string, staged bool) (string, error) {
	root, err := repoRoot(ctx, cwd)
	if err != nil {
		return "", err
	}
	path, err = cleanPath(path)
	if err != nil {
		return "", err
	}
	args := []string{"--literal-pathspecs", "diff", "--no-ext-diff", "--no-color", "-U3"}
	if staged {
		args = append(args, "--cached")
	}
	if path != "" {
		args = append(args, "--", path)
	}
	return run(ctx, root, args...)
}

// Show 返回一次提交的补丁（合并提交取第一父）。
func Show(ctx context.Context, cwd, hash string) (string, error) {
	root, err := repoRoot(ctx, cwd)
	if err != nil {
		return "", err
	}
	hash = strings.TrimSpace(hash)
	if !validHash(hash) {
		return "", errors.New("git: 非法的提交 ID")
	}
	return run(ctx, root, "show", "--no-ext-diff", "--no-color", "--format=", "-m", "--first-parent", "--end-of-options", hash)
}

// Log 返回最近的提交；count 默认 30，最多 100。
func Log(ctx context.Context, cwd string, count, skip int) ([]LogEntry, error) {
	root, err := repoRoot(ctx, cwd)
	if err != nil {
		return nil, err
	}
	if count <= 0 {
		count = 30
	}
	if count > 100 {
		count = 100
	}
	if skip < 0 {
		skip = 0
	}
	raw, err := run(ctx, root, "log", "--all", "--topo-order",
		"-n", strconv.Itoa(count), "--skip", strconv.Itoa(skip), "--decorate=short",
		"--pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D%x1f%P")
	if err != nil {
		if IsNotRepo(err) || strings.Contains(strings.ToLower(err.Error()), "does not have any commits") {
			return []LogEntry{}, nil
		}
		return nil, err
	}
	return parseLog(raw), nil
}

// ListBranches 返回本地分支，当前分支排在最前。
func ListBranches(ctx context.Context, cwd string) (BranchList, error) {
	root, err := repoRoot(ctx, cwd)
	if err != nil {
		return BranchList{}, err
	}
	current := ""
	if raw, err := run(ctx, root, "symbolic-ref", "--short", "-q", "HEAD"); err == nil {
		current = strings.TrimSpace(raw)
	}
	raw, err := run(ctx, root, "for-each-ref", "--format=%(refname:short)", "refs/heads")
	if err != nil {
		return BranchList{}, err
	}
	names := make([]string, 0, 8)
	seen := make(map[string]bool)
	if current != "" {
		names = append(names, current)
		seen[current] = true
	}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || seen[line] {
			continue
		}
		names = append(names, line)
		seen[line] = true
	}
	return BranchList{Current: current, Names: names}, nil
}

// Checkout 切换到已有本地分支。
func Checkout(ctx context.Context, cwd, branch string) error {
	root, err := repoRoot(ctx, cwd)
	if err != nil {
		return err
	}
	branch = strings.TrimSpace(branch)
	if branch == "" || len(branch) > 255 || strings.ContainsRune(branch, 0) {
		return errors.New("git: 非法的分支名")
	}
	_, err = run(ctx, root, "checkout", "--end-of-options", branch)
	return err
}

// Stage 暂存一个路径；path 为空表示全部。
func Stage(ctx context.Context, cwd, path string) error {
	root, err := repoRoot(ctx, cwd)
	if err != nil {
		return err
	}
	path, err = cleanPath(path)
	if err != nil {
		return err
	}
	args := []string{"--literal-pathspecs", "add", "-A"}
	if path != "" {
		args = append(args, "--", path)
	}
	_, err = run(ctx, root, args...)
	return err
}

// Unstage 取消暂存一个路径；path 为空表示全部。
func Unstage(ctx context.Context, cwd, path string) error {
	root, err := repoRoot(ctx, cwd)
	if err != nil {
		return err
	}
	path, err = cleanPath(path)
	if err != nil {
		return err
	}
	args := []string{"--literal-pathspecs", "reset", "-q"}
	if path != "" {
		args = append(args, "--", path)
	}
	_, err = run(ctx, root, args...)
	return err
}

// Discard 丢弃一个已跟踪文件的工作区改动（索引不动）。
func Discard(ctx context.Context, cwd, path string) error {
	root, err := repoRoot(ctx, cwd)
	if err != nil {
		return err
	}
	path, err = cleanPath(path)
	if err != nil {
		return err
	}
	if path == "" {
		return errors.New("git: 丢弃改动必须指定文件")
	}
	_, err = run(ctx, root, "--literal-pathspecs", "checkout", "--", path)
	return err
}

// Commit 用给定消息提交已暂存内容。作者身份完全沿用用户 git 配置。
func Commit(ctx context.Context, cwd, message string) error {
	root, err := repoRoot(ctx, cwd)
	if err != nil {
		return err
	}
	message = strings.TrimSpace(message)
	if message == "" {
		return errors.New("git: 提交信息不能为空")
	}
	if len(message) > 100<<10 {
		return errors.New("git: 提交信息过长")
	}
	_, err = run(ctx, root, "commit", "-m", message)
	return err
}

func repoRoot(ctx context.Context, cwd string) (string, error) {
	raw, err := runAt(ctx, cwd, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}
	root := strings.TrimSpace(raw)
	if root == "" {
		return "", errors.New("git: 无法确定仓库根目录")
	}
	return root, nil
}

// run 以仓库根为 -C 执行命令；调用方通常已拿到 root。
func run(ctx context.Context, cwd string, args ...string) (string, error) {
	return runAt(ctx, cwd, args...)
}

// runAt 固定 git 的机器可读参数与环境。
func runAt(ctx context.Context, cwd string, args ...string) (string, error) {
	if strings.TrimSpace(cwd) == "" {
		return "", errors.New("git: 缺少工作目录")
	}
	base := []string{"-C", cwd, "--no-pager", "-c", "color.ui=false", "-c", "core.quotePath=false"}
	full := append(base, args...)

	cctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, "git", full...)
	cmd.Env = gitEnv()
	cmd.WaitDelay = 2 * time.Second
	var stdout, stderr limitedBuffer
	stdout.max = maxOutputBytes
	stderr.max = 32 << 10
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		if stdout.truncated {
			return "", &CommandError{Args: args, Message: "git 输出超过 8MB，已中止"}
		}
		return stdout.String(), nil
	}
	var exitErr *exec.ExitError
	code := -1
	if errors.As(err, &exitErr) {
		code = exitErr.ExitCode()
	}
	msg := strings.TrimSpace(stderr.String())
	if msg == "" {
		msg = err.Error()
	}
	return "", &CommandError{Args: args, Message: msg, Code: code}
}

// gitEnv 继承操作者环境，但剔除会把 -C 重定向到别处的仓库变量。
// 否则部署环境里一个 GIT_DIR 就能让面板读写另一个仓库。
// proxySource 返回面板设置里的代理地址（空 = 直连）。
//
// 为什么要显式传：git 自己只看环境变量，而「设置里的代理」不在进程环境里；
// 不注入的话 `git pull` 永远是直连——用户在代理里看不到任何流量。
var proxySource func() string

// SetProxySource 注册代理来源（装配层在启动时注入）。
func SetProxySource(fn func() string) {
	proxySource = fn
}

func gitEnv() []string {
	src := os.Environ()
	out := make([]string, 0, len(src)+10)
	for _, kv := range src {
		skip := false
		for _, key := range []string{"GIT_DIR=", "GIT_WORK_TREE=", "GIT_INDEX_FILE=", "GIT_OBJECT_DIRECTORY=", "GIT_ALTERNATE_OBJECT_DIRECTORIES="} {
			if strings.HasPrefix(kv, key) {
				skip = true
				break
			}
		}
		if !skip {
			out = append(out, kv)
		}
	}
	// 继承的代理变量先剔除，再按设置注入：否则宿主机环境会和面板设置打架，
	// 出现「面板里填了代理却按宿主机变量直连」这种难查的状态。
	out = netproxy.StripEnv(out)
	if proxySource != nil {
		out = append(out, netproxy.Env(proxySource())...)
	}
	return append(out, "LC_ALL=C", "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0", "GIT_NO_LAZY_FETCH=1")
}

// limitedBuffer 是带上限的 stdout/stderr 收集器；超过上限只标记，不无限增长。
type limitedBuffer struct {
	buf       bytes.Buffer
	max       int
	truncated bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.max <= 0 {
		return b.buf.Write(p)
	}
	room := b.max - b.buf.Len()
	if room <= 0 {
		b.truncated = true
		return len(p), nil
	}
	if len(p) > room {
		_, _ = b.buf.Write(p[:room])
		b.truncated = true
		return len(p), nil
	}
	return b.buf.Write(p)
}

func (b *limitedBuffer) String() string { return b.buf.String() }

// --- porcelain / numstat / log 解析（纯函数，单测覆盖） ---

func parseStatus(raw string) Snapshot {
	out := Snapshot{IsRepo: true, Entries: make([]StatusEntry, 0, 16)}
	tokens := strings.Split(raw, "\x00")
	for i := 0; i < len(tokens); i++ {
		field := tokens[i]
		if field == "" {
			continue
		}
		if strings.HasPrefix(field, "# ") {
			parseHeader(&out, field[2:])
			continue
		}
		switch {
		case strings.HasPrefix(field, "? "):
			out.Entries = append(out.Entries, StatusEntry{Path: field[2:], XY: "??"})
		case strings.HasPrefix(field, "1 "):
			path, ok := fieldsAfter(field, 8)
			if !ok {
				continue
			}
			out.Entries = append(out.Entries, StatusEntry{Path: path, XY: normalizeXY(field[2:4])})
		case strings.HasPrefix(field, "2 "):
			path, ok := fieldsAfter(field, 9)
			if !ok {
				continue
			}
			out.Entries = append(out.Entries, StatusEntry{Path: path, XY: normalizeXY(field[2:4])})
			// 重命名/复制记录的下一个 NUL 字段是原路径，跳过。
			if i+1 < len(tokens) {
				i++
			}
		case strings.HasPrefix(field, "u "):
			path, ok := fieldsAfter(field, 10)
			if !ok {
				continue
			}
			out.Entries = append(out.Entries, StatusEntry{Path: path, XY: normalizeXY(field[2:4])})
		}
	}
	return out
}

func parseHeader(s *Snapshot, line string) {
	switch {
	case strings.HasPrefix(line, "branch.oid "):
		if strings.TrimSpace(line[len("branch.oid "):]) == "(initial)" {
			s.Branch = ""
		}
	case strings.HasPrefix(line, "branch.head "):
		head := strings.TrimSpace(line[len("branch.head "):])
		if head == "(detached)" {
			s.Detached = true
			s.Branch = ""
			return
		}
		s.Branch = head
	case strings.HasPrefix(line, "branch.upstream "):
		s.Upstream = strings.TrimSpace(line[len("branch.upstream "):])
	case strings.HasPrefix(line, "branch.ab "):
		fields := strings.Fields(line[len("branch.ab "):])
		for _, f := range fields {
			if strings.HasPrefix(f, "+") {
				s.Ahead, _ = strconv.Atoi(f[1:])
			} else if strings.HasPrefix(f, "-") {
				s.Behind, _ = strconv.Atoi(f[1:])
			}
		}
	}
}

// fieldsAfter 跳过 n 个空格分隔字段，返回剩下的原始文本（保留路径内的连续空格）。
func fieldsAfter(s string, n int) (string, bool) {
	idx := 0
	for i := 0; i < n; i++ {
		j := strings.IndexByte(s[idx:], ' ')
		if j < 0 {
			return "", false
		}
		idx += j + 1
	}
	if idx >= len(s) {
		return "", false
	}
	return s[idx:], true
}

func normalizeXY(xy string) string {
	if len(xy) != 2 {
		return xy
	}
	return strings.ReplaceAll(xy, ".", " ")
}

func parseNumstat(raw string) map[string]*LineCounts {
	out := make(map[string]*LineCounts)
	tokens := strings.Split(raw, "\x00")
	for i := 0; i < len(tokens); i++ {
		token := tokens[i]
		if token == "" {
			continue
		}
		parts := strings.SplitN(token, "\t", 3)
		if len(parts) < 3 {
			continue
		}
		add, del, path := parts[0], parts[1], parts[2]
		if path == "" {
			// rename: 下两个字段是 old, new。
			if i+2 < len(tokens) {
				path = tokens[i+2]
				i += 2
			} else {
				continue
			}
		}
		counts := &LineCounts{}
		if add == "-" || del == "-" {
			counts.Binary = true
		} else {
			counts.Additions, _ = strconv.Atoi(add)
			counts.Deletions, _ = strconv.Atoi(del)
		}
		out[path] = counts
	}
	return out
}

func applyCounts(entries []StatusEntry, counts map[string]*LineCounts, staged bool) {
	for i := range entries {
		if c, ok := counts[entries[i].Path]; ok {
			if staged {
				entries[i].Staged = c
			} else {
				entries[i].Unstaged = c
			}
		}
	}
}

func parseLog(raw string) []LogEntry {
	lines := strings.Split(raw, "\n")
	out := make([]LogEntry, 0, len(lines))
	for _, line := range lines {
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\x1f")
		if len(parts) < 7 {
			continue
		}
		parents := []string{}
		if strings.TrimSpace(parts[6]) != "" {
			parents = strings.Fields(parts[6])
		}
		out = append(out, LogEntry{
			Hash:     parts[0],
			Subject:  parts[1],
			Author:   parts[2],
			Date:     parts[3],
			HashFull: parts[4],
			Refs:     parts[5],
			Parents:  parents,
		})
	}
	return out
}

func cleanPath(path string) (string, error) {
	// 不能 TrimSpace：git 允许文件名以空格开头/结尾，去掉会指向另一个文件。
	if path == "" {
		return "", nil
	}
	if strings.ContainsRune(path, 0) {
		return "", errors.New("git: 路径包含非法字符")
	}
	path = filepath.ToSlash(path)
	if strings.HasPrefix(path, "/") || strings.HasPrefix(path, "../") || path == ".." {
		return "", errors.New("git: 路径必须在仓库内")
	}
	for _, part := range strings.Split(path, "/") {
		if part == ".." {
			return "", errors.New("git: 路径必须在仓库内")
		}
	}
	return path, nil
}

func validHash(hash string) bool {
	if len(hash) < 7 || len(hash) > 64 {
		return false
	}
	for _, r := range hash {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') && (r < 'A' || r > 'F') {
			return false
		}
	}
	return true
}

// Pull 拉取上游（仅 fast-forward）。分叉时明确失败，不在无头面板里制造 merge commit。
func Pull(ctx context.Context, cwd string) error {
	root, err := repoRoot(ctx, cwd)
	if err != nil {
		return err
	}
	_, err = run(ctx, root, "pull", "--ff-only")
	return err
}
