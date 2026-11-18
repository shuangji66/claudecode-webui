// Package skills 管理 claude 的 SKILL.md 文件（个人 / 项目两级，外加只读的同步技能）。
//
// 为什么自己管文件而不是调 CLI：claude 把技能就是存成
// `<root>/<name>/SKILL.md`，并且会监听这些目录做热加载，所以「改文件」既是
// 唯一真源，也是唯一不需要重启会话的修改方式。插件技能与 bundled 技能不在
// 这里管：前者由 `claude plugin` 维护，后者的开关在 settings.json。
//
// 本包只做文件读写，不认识 HTTP，也不决定目录是否授权（由网关校验 cwd）。
package skills

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// 技能来源。与 claude 的加载位置一一对应。
const (
	// ScopePersonal 是个人技能：<claude home>/.claude/skills，所有会话可见。
	ScopePersonal = "personal"
	// ScopeProject 是项目技能：<cwd>/.claude/skills，随仓库提交。
	ScopeProject = "project"
	// ScopeSynced 是从 claude.ai 账号同步下来的技能，只读。
	ScopeSynced = "synced"
)

var (
	// ErrInvalidName 表示技能名不能作为目录名（含分隔符、以点开头等）。
	ErrInvalidName = errors.New("非法技能名")
	// ErrReadOnly 表示该来源不允许通过本接口修改。
	ErrReadOnly = errors.New("该来源只读")
	// ErrNotFound 表示技能目录或 SKILL.md 不存在。
	ErrNotFound = errors.New("技能不存在")
	// ErrTooLarge 表示 SKILL.md 超过可编辑上限。
	ErrTooLarge = errors.New("SKILL.md 过大")
	// ErrEmpty 表示内容为空。
	ErrEmpty = errors.New("SKILL.md 内容为空")
	// ErrSymlink 表示目标是符号链接，写入会落到受管目录之外。
	ErrSymlink = errors.New("技能目录是符号链接，拒绝写入")
	// ErrNotSkill 表示导入来源既不是含 SKILL.md 的目录，也不是 SKILL.md 文件。
	ErrNotSkill = errors.New("不是技能：需要一个含 SKILL.md 的目录，或 SKILL.md 文件")
)

// maxContent 是 SKILL.md 的读写上限。技能是提示词，正常只有几 KB。
const maxContent = 1 << 20

// MaxImport 是一次批量导入的来源数量上限。技能很小，但一次几百个既点不完也看不清结果。
const MaxImport = 50

// syncedDir 是 claude 存放 claude.ai 同步技能的保留目录名。
const syncedDir = "synced"

// Skill 是一条技能的元信息（不含正文）。
type Skill struct {
	Name string `json:"name"`
	// Scope 是来源：personal / project / synced。
	Scope string `json:"scope"`
	// Description 取自 frontmatter，claude 靠它判断何时自动加载。
	Description string `json:"description"`
	// Path 是 SKILL.md 的绝对路径，供界面显示与排错。
	Path string `json:"path"`
	// Updated 是 SKILL.md 的修改时间。
	Updated time.Time `json:"updated"`
	Size    int64     `json:"size"`
	// ReadOnly 为真时界面不提供编辑/删除。
	ReadOnly bool `json:"read_only"`
	// Invalid 非空表示 SKILL.md 存在但读不出来（权限/编码），仍列出便于修复。
	Invalid string `json:"invalid,omitempty"`
}

// Doc 是技能正文。
type Doc struct {
	Skill
	Content string `json:"content"`
}

// Manager 按来源解析技能目录。
type Manager struct {
	personal string
}

// New 构造管理器。personalRoot 是 claude 子进程 HOME 下的 .claude/skills。
//
// 注意不能用进程自己的 ~/.claude/skills：claude 的 HOME 被 process.CleanEnv
// 改成了 CCWEB_CLAUDE_HOME，两者通常不是同一个目录。
func New(personalRoot string) *Manager {
	return &Manager{personal: personalRoot}
}

// PersonalRoot 返回个人技能根目录，供界面提示。
func (m *Manager) PersonalRoot() string {
	return m.personal
}

// root 解析来源对应的目录，并返回是否只读。
func (m *Manager) root(scope, cwd string) (string, bool, error) {
	switch scope {
	case ScopePersonal:
		return m.personal, false, nil
	case ScopeSynced:
		return filepath.Join(m.personal, syncedDir), true, nil
	case ScopeProject:
		if cwd == "" {
			return "", false, fmt.Errorf("%w: 缺少工作目录", ErrInvalidName)
		}
		return filepath.Join(cwd, ".claude", "skills"), false, nil
	default:
		return "", false, fmt.Errorf("未知技能来源 %q", scope)
	}
}

// skillDir 拼出某个技能的目录，并做名字与保留名校验。
func (m *Manager) skillDir(scope, cwd, name string) (dir string, readOnly bool, err error) {
	root, readOnly, err := m.root(scope, cwd)
	if err != nil {
		return "", false, err
	}
	if !ValidName(name) {
		return "", false, ErrInvalidName
	}
	// synced 是保留目录：个人技能里不能有同名目录，避免和同步技能互相覆盖。
	if scope == ScopePersonal && strings.EqualFold(name, syncedDir) {
		return "", false, fmt.Errorf("%w: %q 是保留名", ErrInvalidName, syncedDir)
	}
	return filepath.Join(root, name), readOnly, nil
}

// rejectSymlinkPath 拒绝「从受管根到目标目录之间任意一层是符号链接」。
//
// 只检查叶子目录是不够的：MkdirAll / CreateTemp / RemoveAll 都会跟随中间层，
// 工作区里一个 `.claude -> /某处` 的软链就能把「保存技能」变成往工作区外写
// SKILL.md、把「删除技能」变成删工作区外的目录。所以要从工作区（个人技能则是
// 技能根）开始逐层 Lstat，遇到第一层软链就拒绝。
//
// 路径不存在是正常的（技能目录本来就可能还没建）：某一层不存在时后面的层
// 必然也不存在，MkdirAll 不会再跟随任何软链，直接放行。
func (m *Manager) rejectSymlinkPath(scope, cwd, dir string) error {
	root, _, err := m.root(scope, cwd)
	if err != nil {
		return err
	}
	// 个人技能根由应用自己创建，根本身也不允许是软链。
	if isSymlink(root) {
		return ErrSymlink
	}
	// 项目技能从 cwd 起算：`.claude` 与 `.claude/skills` 都可能被换成软链。
	base := root
	if scope == ScopeProject {
		base = cwd
	}
	rel, err := filepath.Rel(base, dir)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return ErrInvalidName
	}
	if rel == "." {
		return nil
	}
	cur := base
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		cur = filepath.Join(cur, part)
		fi, err := os.Lstat(cur)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			return ErrSymlink
		}
	}
	return nil
}

// isSymlink 报告 path 是否存在且是符号链接；不存在不算。
func isSymlink(path string) bool {
	fi, err := os.Lstat(path)
	return err == nil && fi.Mode()&os.ModeSymlink != 0
}

// ValidName 判断名字能否作为技能目录名。
//
// 规则比 claude 宽松的部分（中文、空格）保留，只挡掉会变成路径穿越、
// 隐藏目录或让 claude 静默不加载的字符。
func ValidName(name string) bool {
	if name == "" || len(name) > 64 || name == "." || name == ".." {
		return false
	}
	if strings.HasPrefix(name, ".") {
		return false
	}
	if strings.ContainsAny(name, `/\<>`) {
		return false
	}
	for _, r := range name {
		// 控制字符与零宽字符会让 claude 拒绝加载，也让界面显示异常。
		if r < 0x20 || r == 0x7f || r == 0x200b || r == 0xfeff {
			return false
		}
	}
	return true
}

// List 列出来源下的技能。目录不存在时返回空列表而不是错误：
// 大多数仓库没有 .claude/skills。
func (m *Manager) List(scope, cwd string) ([]Skill, error) {
	root, readOnly, err := m.root(scope, cwd)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return []Skill{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := make([]Skill, 0, len(entries))
	for _, e := range entries {
		name := e.Name()
		if !ValidName(name) {
			continue
		}
		// 个人根目录下的 synced 单独作为一类来源列出，不混进个人技能。
		if scope == ScopePersonal && name == syncedDir {
			continue
		}
		dir := filepath.Join(root, name)
		if !isDir(dir) {
			continue
		}
		if skill, ok := readMeta(dir, name, scope, readOnly); ok {
			out = append(out, skill)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// Read 读取技能正文。
func (m *Manager) Read(scope, cwd, name string) (Doc, error) {
	dir, readOnly, err := m.skillDir(scope, cwd, name)
	if err != nil {
		return Doc{}, err
	}
	path := filepath.Join(dir, "SKILL.md")
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Doc{}, ErrNotFound
	}
	if err != nil {
		return Doc{}, err
	}
	if len(b) > maxContent {
		return Doc{}, ErrTooLarge
	}
	info, err := os.Stat(path)
	if err != nil {
		return Doc{}, err
	}
	_, desc := ParseFrontmatter(string(b))
	return Doc{
		Skill: Skill{
			Name:        name,
			Scope:       scope,
			Description: desc,
			Path:        path,
			Updated:     info.ModTime(),
			Size:        info.Size(),
			ReadOnly:    readOnly,
		},
		Content: string(b),
	}, nil
}

// Save 写入（或新建）技能的 SKILL.md。
//
// 先写同目录临时文件再 rename：claude 会监听技能目录，半截文件会被当成
// 技能内容读进去。
func (m *Manager) Save(scope, cwd, name, content string) (Doc, error) {
	dir, readOnly, err := m.skillDir(scope, cwd, name)
	if err != nil {
		return Doc{}, err
	}
	if readOnly {
		return Doc{}, ErrReadOnly
	}
	content = strings.ReplaceAll(content, "\r\n", "\n")
	if strings.TrimSpace(content) == "" {
		return Doc{}, ErrEmpty
	}
	if len(content) > maxContent {
		return Doc{}, ErrTooLarge
	}
	// 目录（含中间层）是符号链接时，写入会落到受管目录之外（工作区里的恶意仓库、
	// 或手工建的软链都可能这样）。这里逐层确认整条路径都是真实目录。
	if err := m.rejectSymlinkPath(scope, cwd, dir); err != nil {
		return Doc{}, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Doc{}, err
	}
	tmp, err := os.CreateTemp(dir, ".SKILL-*.tmp")
	if err != nil {
		return Doc{}, err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }() // rename 成功后这里是 no-op
	if _, err := tmp.WriteString(content); err != nil {
		_ = tmp.Close()
		return Doc{}, err
	}
	if err := tmp.Close(); err != nil {
		return Doc{}, err
	}
	if err := os.Chmod(tmpName, 0o644); err != nil {
		return Doc{}, err
	}
	if err := os.Rename(tmpName, filepath.Join(dir, "SKILL.md")); err != nil {
		return Doc{}, err
	}
	return m.Read(scope, cwd, name)
}

// Delete 删除整个技能目录。
//
// 只删 skills 根目录的直接子目录，且必须真的含 SKILL.md：避免把
// 误传的名字变成对任意目录的 RemoveAll。
func (m *Manager) Delete(scope, cwd, name string) error {
	dir, readOnly, err := m.skillDir(scope, cwd, name)
	if err != nil {
		return err
	}
	if readOnly {
		return ErrReadOnly
	}
	root, _, err := m.root(scope, cwd)
	if err != nil {
		return err
	}
	if filepath.Dir(filepath.Clean(dir)) != filepath.Clean(root) {
		return ErrInvalidName
	}
	// 父目录（.claude / skills）被换成软链时，下面的 RemoveAll 会删到工作区外。
	// 叶子本身是软链的情况不在这里拦：那种只删链接、不跟进目标。
	if err := m.rejectSymlinkPath(scope, cwd, filepath.Dir(dir)); err != nil {
		return err
	}
	fi, err := os.Lstat(dir)
	if errors.Is(err, os.ErrNotExist) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	// 符号链接只删链接本身，绝不跟进去删目标目录。
	if fi.Mode()&os.ModeSymlink != 0 {
		return os.Remove(dir)
	}
	if !fi.IsDir() {
		return ErrNotFound
	}
	if _, err := os.Stat(filepath.Join(dir, "SKILL.md")); err != nil {
		return ErrNotFound
	}
	return os.RemoveAll(dir)
}

// ImportResult 是一条导入的结果。
//
// 批量导入里单条失败不影响其它条，所以原因逐条带出来而不是整批报错：
// 用户经常一次拖进好几个技能，其中一个名字不合法不该让其余全部回滚。
type ImportResult struct {
	// Path 是来源路径（界面用它标出是哪一条）。
	Path string `json:"path"`
	// Name 是写进去的技能名（失败时可能是空）。
	Name string `json:"name,omitempty"`
	OK   bool   `json:"ok"`
	// Error 是这条失败的原因（原文，界面直接显示）。
	Error string `json:"error,omitempty"`
}

// ImportFrom 从宿主路径批量导入技能。
//
// 路径来自飞牛的文件选择器：那是**用户显式挑选**的目录，但不在工作区授权里，
// 所以这里把读写边界收紧到只认 SKILL.md 这一个文件名——
//   - 传目录：读 <目录>/SKILL.md，技能名取目录名；
//   - 传文件：文件名必须是 SKILL.md，技能名取它的父目录名。
//
// 不要放宽成「读任意 .md」或「读目录里所有文件」：这条接口会把内容写进技能、
// 再经 /api/skills/doc 显示到界面上，等于给前端开了一个受控之外的宿主文件读取口。
// 来源必须是普通文件（不跟软链），避免把某个被链接过去的文件内容当技能读出来。
func (m *Manager) ImportFrom(scope, cwd string, paths []string) ([]ImportResult, error) {
	if scope != ScopePersonal && scope != ScopeProject {
		return nil, ErrReadOnly
	}
	if _, _, err := m.root(scope, cwd); err != nil {
		return nil, err
	}
	if len(paths) > MaxImport {
		paths = paths[:MaxImport]
	}
	out := make([]ImportResult, 0, len(paths))
	for _, p := range paths {
		res := ImportResult{Path: p}
		name, content, err := readSkillSource(p)
		if err != nil {
			res.Error = err.Error()
			out = append(out, res)
			continue
		}
		res.Name = name
		if _, err := m.Save(scope, cwd, name, content); err != nil {
			res.Error = err.Error()
			out = append(out, res)
			continue
		}
		res.OK = true
		out = append(out, res)
	}
	return out, nil
}

// readSkillSource 把一条来源路径解析成（技能名, 正文）。
func readSkillSource(p string) (string, string, error) {
	if !filepath.IsAbs(p) {
		return "", "", errors.New("需要绝对路径")
	}
	clean := filepath.Clean(p)
	fi, err := os.Lstat(clean)
	if err != nil {
		return "", "", err
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return "", "", ErrSymlink
	}
	dir := clean
	file := filepath.Join(clean, "SKILL.md")
	if !fi.IsDir() {
		if !strings.EqualFold(filepath.Base(clean), "SKILL.md") {
			return "", "", ErrNotSkill
		}
		dir = filepath.Dir(clean)
		file = clean
	}
	sf, err := os.Lstat(file)
	if errors.Is(err, os.ErrNotExist) {
		return "", "", ErrNotSkill
	}
	if err != nil {
		return "", "", err
	}
	if sf.Mode()&os.ModeSymlink != 0 || !sf.Mode().IsRegular() {
		return "", "", ErrNotSkill
	}
	if sf.Size() > maxContent {
		return "", "", ErrTooLarge
	}
	// Lstat 到 ReadFile 之间文件还可能变大（写日志 / 正在同步），所以真正读的时候
	// 也只读到上限多一个字节：多出这一字节就判定过大，别把几十 MB 读进内存。
	f, err := os.Open(file)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(io.LimitReader(f, maxContent+1))
	if err != nil {
		return "", "", err
	}
	if len(b) > maxContent {
		return "", "", ErrTooLarge
	}
	return filepath.Base(dir), string(b), nil
}

// readMeta 读取单个技能目录的元信息；没有 SKILL.md 的目录直接跳过。
func readMeta(dir, name, scope string, readOnly bool) (Skill, bool) {
	path := filepath.Join(dir, "SKILL.md")
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return Skill{Name: name, Scope: scope, Path: path, ReadOnly: readOnly, Invalid: err.Error()}, true
		}
		return Skill{}, false
	}
	skill := Skill{
		Name:     name,
		Scope:    scope,
		Path:     path,
		Updated:  info.ModTime(),
		Size:     info.Size(),
		ReadOnly: readOnly,
	}
	b, err := os.ReadFile(path)
	if err != nil {
		skill.Invalid = err.Error()
		return skill, true
	}
	if len(b) > maxContent {
		skill.Invalid = "文件超过 1 MiB，未读取"
		return skill, true
	}
	_, skill.Description = ParseFrontmatter(string(b))
	return skill, true
}

// isDir 跟随符号链接判断是否为目录：技能目录允许是软链（claude 支持），
// 只是不允许通过本接口往里写。
func isDir(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.IsDir()
}

// ParseFrontmatter 取出 name 与 description。
//
// 只解析这两种最常见的标量字段，支持单双引号与 > / | 块标量；其余字段
// 原样留在正文里。刻意不引 YAML 依赖：整个后端目前只用标准库。
func ParseFrontmatter(content string) (name, description string) {
	lines := strings.Split(strings.TrimPrefix(content, "\ufeff"), "\n")
	i := 0
	for i < len(lines) && strings.TrimSpace(lines[i]) == "" {
		i++
	}
	if i >= len(lines) || strings.TrimSpace(lines[i]) != "---" {
		return "", ""
	}
	for j := i + 1; j < len(lines); j++ {
		line := lines[j]
		if strings.TrimSpace(line) == "---" {
			break
		}
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if key != "name" && key != "description" {
			continue
		}
		val = strings.TrimSpace(val)
		if strings.HasPrefix(val, ">") || strings.HasPrefix(val, "|") {
			fold := strings.HasPrefix(val, ">")
			var parts []string
			for k := j + 1; k < len(lines); k++ {
				next := lines[k]
				trimmed := strings.TrimSpace(next)
				// 块标量到顶格的新 key 或 frontmatter 结束为止。
				if trimmed == "---" || (trimmed != "" && !strings.HasPrefix(next, " ") && !strings.HasPrefix(next, "\t")) {
					break
				}
				parts = append(parts, trimmed)
				j = k
			}
			if fold {
				val = strings.Join(nonEmpty(parts), " ")
			} else {
				val = strings.TrimRight(strings.Join(parts, "\n"), "\n")
			}
		}
		val = unquote(strings.TrimSpace(val))
		if key == "name" {
			name = val
		} else {
			description = val
		}
	}
	return name, description
}

func nonEmpty(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func unquote(s string) string {
	if len(s) >= 2 {
		if (s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'') {
			return s[1 : len(s)-1]
		}
	}
	return s
}
