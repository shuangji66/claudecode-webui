// Package mcp 管理 claude 的 MCP server 配置。
//
// 为什么改文件而不是调 CLI：claude 读的就是这两份配置——
//   - 用户级：$HOME/.claude.json 的 mcpServers（本项目里 HOME 是 CCWEB_CLAUDE_HOME）
//   - 项目级：<工作区>/.mcp.json 的 mcpServers（跟随仓库，可入库共享）
//
// 而 `claude mcp add` 是交互式 CLI，本应用把 claude 当常驻子进程跑，没有终端给它。
// 文件既是唯一真源，也不用为「改配置」重启整个应用；改完由用户重开会话生效
// （MCP server 是会话启动时连接的，不会热加载）。
//
// 本包只碰这两份文件与自己的停用暂存文件，不认识 HTTP，也不判断目录是否授权
// （由网关校验 cwd）。
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"ccweb/backend/internal/envpath"
	"ccweb/backend/internal/netproxy"
)

// 作用域。与界面的「用户级 / 项目级」一一对应。
const (
	// ScopeUser 是 $HOME/.claude.json 里的 mcpServers，对所有项目生效。
	ScopeUser = "user"
	// ScopeProject 是 <cwd>/.mcp.json 里的 mcpServers，只对该工作区生效。
	ScopeProject = "project"
)

// 传输类型。只写 command 而不写 type 时按 stdio 处理，与 claude 自己的默认一致。
const (
	TypeStdio = "stdio"
	TypeSSE   = "sse"
	TypeHTTP  = "http"
)

var (
	// ErrInvalidName 表示 server 名不合法（它会成为配置里的 key 与工具名前缀）。
	ErrInvalidName = errors.New("非法的 MCP 服务名")
	// ErrInvalidSpec 表示配置内容不完整（stdio 缺 command、远程缺 url）。
	ErrInvalidSpec = errors.New("MCP 配置不完整")
	// ErrNotFound 表示该作用域下没有这个 server。
	ErrNotFound = errors.New("MCP 服务不存在")
	// ErrDisabled 表示服务处于停用状态（已经摘出 claude 的配置）。
	ErrDisabled = errors.New("MCP 服务已停用")
	// ErrSymlink 表示目标文件或工作区内的某一层上级是符号链接。
	ErrSymlink = errors.New("配置路径经过符号链接，拒绝写入")
	// ErrBadScope 表示作用域不合法。
	ErrBadScope = errors.New("未知的作用域")
)

// maxConfig 是配置文件大小上限。.claude.json 几十 KB 很正常，但别读进来一个 GB。
const maxConfig = 8 << 20

// serversKey 是两份配置文件里存放 MCP server 的键名（claude 的约定）。
const serversKey = "mcpServers"

// Server 是界面上的一条 MCP 服务。
//
// Name/Scope/Type/Command/Args/URL/Env/Headers 对应配置文件里的字段；
// Disabled/ConfigPath 只是展示信息，不写回文件。
type Server struct {
	Name       string            `json:"name"`
	Scope      string            `json:"scope"`
	Type       string            `json:"type"`
	Command    string            `json:"command,omitempty"`
	Args       []string          `json:"args,omitempty"`
	URL        string            `json:"url,omitempty"`
	Env        map[string]string `json:"env,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
	Disabled   bool              `json:"disabled"`
	ConfigPath string            `json:"config_path"`
}

// Payload 是 GET /api/mcp 的返回。
type Payload struct {
	User    []Server `json:"user"`
	Project []Server `json:"project"`
	// ProjectRoot 是项目级配置所在的工作区；空表示没传或未授权。
	ProjectRoot string `json:"project_root"`
	// UserPath / ProjectPath 供界面显示「配置实际写在哪」。
	UserPath    string `json:"user_path"`
	ProjectPath string `json:"project_path"`
}

// ProbeResult 是探测结果。只报真拿到的数据，不猜。
type ProbeResult struct {
	OK            bool   `json:"ok"`
	LatencyMs     int64  `json:"latency_ms"`
	Error         string `json:"error,omitempty"`
	ServerName    string `json:"server_name,omitempty"`
	ServerVersion string `json:"server_version,omitempty"`
	Protocol      string `json:"protocol,omitempty"`
}

// Manager 指向用户级配置与停用暂存文件；项目级配置按 cwd 现算。
type Manager struct {
	userConfig string
	disabled   string
}

// New 构造管理器。userConfig 通常是 <CCWEB_CLAUDE_HOME>/.claude.json；
// disabledFile 是本应用自己的停用暂存（放在数据目录，不污染 claude 的配置）。
func New(userConfig, disabledFile string) *Manager {
	return &Manager{userConfig: userConfig, disabled: disabledFile}
}

// UserPath 返回用户级配置文件路径，供界面显示。
func (m *Manager) UserPath() string { return m.userConfig }

// projectPath 返回工作区里的 .mcp.json。
func projectPath(cwd string) string { return filepath.Join(cwd, ".mcp.json") }

// configFor 解析作用域 → 配置文件路径。
func (m *Manager) configFor(scope, cwd string) (string, error) {
	switch scope {
	case ScopeUser:
		return m.userConfig, nil
	case ScopeProject:
		if cwd == "" {
			return "", fmt.Errorf("%w: 缺少工作目录", ErrBadScope)
		}
		return projectPath(cwd), nil
	default:
		return "", fmt.Errorf("%w: %q", ErrBadScope, scope)
	}
}

// baseFor 返回「可以信任的起点」：用户级是本应用自己建的 claude HOME，
// 项目级是被授权的工作区。只从这一层往下拒绝符号链接——工作区本身可能是软链
// （授权就是这么授权的），把它也算进去会把正常工作区误杀。
func (m *Manager) baseFor(scope, cwd string) (string, error) {
	switch scope {
	case ScopeUser:
		return filepath.Dir(m.userConfig), nil
	case ScopeProject:
		return cwd, nil
	default:
		return "", fmt.Errorf("%w: %q", ErrBadScope, scope)
	}
}

// nameRE 限制服务名：它会成为配置里的 key 与工具名前缀（mcp__<name>__<tool>），
// 空格、斜杠、控制字符都会让 claude 侧的名字解析出问题。
var nameRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// ValidName 报告服务名是否可以写进配置。
func ValidName(name string) bool { return nameRE.MatchString(name) }

// envKeyRE 限制环境变量名：写进子进程环境时等号与空白会被拆错。
var envKeyRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// Normalize 校验并补全一条配置：类型缺省按 stdio，stdio 必须有 command、
// 远程必须有 http(s) URL，env 的键必须能写进子进程环境。
func Normalize(s Server) (Server, error) {
	if !ValidName(s.Name) {
		return Server{}, ErrInvalidName
	}
	s.Type = strings.ToLower(strings.TrimSpace(s.Type))
	if s.Type == "" {
		s.Type = TypeStdio
	}
	switch s.Type {
	case TypeStdio:
		s.Command = strings.TrimSpace(s.Command)
		if s.Command == "" {
			return Server{}, fmt.Errorf("%w: stdio 需要 command", ErrInvalidSpec)
		}
		s.URL = ""
		s.Headers = nil
		s.Args = cleanList(s.Args)
	case TypeSSE, TypeHTTP:
		s.URL = strings.TrimSpace(s.URL)
		if !strings.HasPrefix(s.URL, "http://") && !strings.HasPrefix(s.URL, "https://") {
			return Server{}, fmt.Errorf("%w: %s 需要 http(s) 地址", ErrInvalidSpec, s.Type)
		}
		s.Command = ""
		s.Args = nil
		s.Env = nil
	default:
		return Server{}, fmt.Errorf("%w: 未知类型 %q", ErrInvalidSpec, s.Type)
	}
	for k := range s.Env {
		if !envKeyRE.MatchString(k) {
			return Server{}, fmt.Errorf("%w: 非法环境变量名 %q", ErrInvalidSpec, k)
		}
	}
	return s, nil
}

// cleanList 去掉参数里的首尾空白与空项；顺序保持原样。
func cleanList(in []string) []string {
	out := make([]string, 0, len(in))
	for _, v := range in {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// marshalSpec 按 claude 认得的形状序列化：stdio 不写 type（那是默认值），
// 远程才写 type。多写一个 "type":"stdio" 也能被接受，但和人手写的配置就不像了。
func (s Server) marshalSpec() (json.RawMessage, error) {
	out := map[string]any{}
	if s.Type != "" && s.Type != TypeStdio {
		out["type"] = s.Type
	}
	if s.Command != "" {
		out["command"] = s.Command
	}
	if len(s.Args) > 0 {
		out["args"] = s.Args
	}
	if s.URL != "" {
		out["url"] = s.URL
	}
	if len(s.Env) > 0 {
		out["env"] = s.Env
	}
	if len(s.Headers) > 0 {
		out["headers"] = s.Headers
	}
	return json.Marshal(out)
}

// parseSpec 把配置里的原始 JSON 读成 Server（不含 Name/Scope）。
func parseSpec(name, scope, path string, raw json.RawMessage) Server {
	var spec struct {
		Type      string            `json:"type"`
		Transport string            `json:"transport"`
		Command   string            `json:"command"`
		Args      []string          `json:"args"`
		URL       string            `json:"url"`
		Env       map[string]string `json:"env"`
		Headers   map[string]string `json:"headers"`
	}
	_ = json.Unmarshal(raw, &spec)
	typ := strings.ToLower(strings.TrimSpace(spec.Type))
	if typ == "" {
		// 早期配置用 transport 字段，claude 两种都认。
		typ = strings.ToLower(strings.TrimSpace(spec.Transport))
	}
	if typ == "" {
		if spec.URL != "" {
			typ = TypeHTTP
		} else {
			typ = TypeStdio
		}
	}
	return Server{
		Name:       name,
		Scope:      scope,
		Type:       typ,
		Command:    spec.Command,
		Args:       spec.Args,
		URL:        spec.URL,
		Env:        spec.Env,
		Headers:    spec.Headers,
		ConfigPath: path,
	}
}

// readTop 读取整个 JSON 对象的顶层键值，**保留原始字节**。
//
// 关键点：.claude.json 里还有 projects / 计数 / 迁移标记，我们只碰 mcpServers。
// 用 map[string]json.RawMessage 而不是 map[string]any，避免数字被 float64 改写、
// 未知结构被重新排版——那等于把 claude 自己的状态文件改成另一份东西。
func readTop(path string) (map[string]json.RawMessage, error) {
	top := map[string]json.RawMessage{}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return top, nil
	}
	if err != nil {
		return nil, fmt.Errorf("mcp: 读取配置: %w", err)
	}
	if len(b) > maxConfig {
		return nil, fmt.Errorf("mcp: %s 超过 %d 字节，拒绝读取", path, maxConfig)
	}
	if len(bytes.TrimSpace(b)) == 0 {
		return top, nil
	}
	if err := json.Unmarshal(b, &top); err != nil {
		return nil, fmt.Errorf("mcp: %s 不是合法的 JSON: %w", path, err)
	}
	return top, nil
}

// serversOf 从顶层对象里取出 mcpServers，缺失时返回空表。
func serversOf(top map[string]json.RawMessage) (map[string]json.RawMessage, error) {
	servers := map[string]json.RawMessage{}
	raw, ok := top[serversKey]
	if !ok {
		return servers, nil
	}
	if trimmed := bytes.TrimSpace(raw); len(trimmed) == 0 || string(trimmed) == "null" {
		return servers, nil
	}
	if err := json.Unmarshal(raw, &servers); err != nil {
		return nil, fmt.Errorf("mcp: %s 不是合法对象: %w", serversKey, err)
	}
	return servers, nil
}

// ensureWritable 从 base 起逐层拒绝符号链接，并保证目标父目录存在。
//
// 只 Lstat 叶子不够：临时文件建在父目录里、rename 覆盖的也是父目录里的名字，
// 中间任何一层软链都会把写操作带到受管目录之外（工作区里一个
// `.claude.json -> /某处` 或 `.mcp.json -> /某处` 就够）。
func ensureWritable(base, target string) error {
	if base == "" {
		base = filepath.Dir(target)
	}
	clean := filepath.Clean(target)
	rel, err := filepath.Rel(filepath.Clean(base), clean)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("%w: 目标不在受管目录内", ErrSymlink)
	}
	if err := os.MkdirAll(filepath.Dir(clean), 0o755); err != nil {
		return fmt.Errorf("mcp: 建目录: %w", err)
	}
	if rel == "." {
		return nil
	}
	cur := filepath.Clean(base)
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		cur = filepath.Join(cur, part)
		fi, err := os.Lstat(cur)
		if errors.Is(err, os.ErrNotExist) {
			// 这一层还没建：后面的层必然也没有，MkdirAll 不会再跟随任何软链。
			return nil
		}
		if err != nil {
			return fmt.Errorf("mcp: 检查路径: %w", err)
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			return ErrSymlink
		}
	}
	return nil
}

// writeJSONFile 原子写回一个 JSON 文件：同目录临时文件 + rename。
//
// claude 会在新建会话时随时读这份配置，写到一半被读到就是「配置损坏」。
func writeJSONFile(path string, v any, defaultMode os.FileMode) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("mcp: 序列化配置: %w", err)
	}
	b = append(b, '\n')
	mode := defaultMode
	if fi, err := os.Stat(path); err == nil {
		mode = fi.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".mcp-*.tmp")
	if err != nil {
		return fmt.Errorf("mcp: 建临时文件: %w", err)
	}
	name := tmp.Name()
	defer func() { _ = os.Remove(name) }() // rename 成功后这里是 no-op
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("mcp: 写临时文件: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("mcp: 关闭临时文件: %w", err)
	}
	if err := os.Chmod(name, mode); err != nil {
		return fmt.Errorf("mcp: 设置权限: %w", err)
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("mcp: 落盘: %w", err)
	}
	return nil
}

// writeConfig 把「顶层对象」整体写回某个配置文件。
func (m *Manager) writeConfig(scope, cwd string, top map[string]json.RawMessage) error {
	path, err := m.configFor(scope, cwd)
	if err != nil {
		return err
	}
	base, err := m.baseFor(scope, cwd)
	if err != nil {
		return err
	}
	if err := ensureWritable(base, path); err != nil {
		return err
	}
	// 项目级配置是仓库文件（可能入库），权限跟着普通文件；用户级是 claude 的
	// 状态文件，只有本人可读。
	mode := os.FileMode(0o644)
	if scope == ScopeUser {
		mode = 0o600
	}
	return writeJSONFile(path, top, mode)
}

// readScope 读出某个作用域下所有 server（按名字排序）。
func (m *Manager) readScope(scope, cwd string) (map[string]Server, error) {
	path, err := m.configFor(scope, cwd)
	if err != nil {
		return nil, err
	}
	top, err := readTop(path)
	if err != nil {
		return nil, err
	}
	raws, err := serversOf(top)
	if err != nil {
		return nil, err
	}
	out := make(map[string]Server, len(raws))
	for name, raw := range raws {
		out[name] = parseSpec(name, scope, path, raw)
	}
	return out, nil
}

// update 在指定作用域里改写 mcpServers（mutate 拿到当前表，就地修改）。
func (m *Manager) update(scope, cwd string, mutate func(map[string]json.RawMessage) error) error {
	path, err := m.configFor(scope, cwd)
	if err != nil {
		return err
	}
	top, err := readTop(path)
	if err != nil {
		return err
	}
	raws, err := serversOf(top)
	if err != nil {
		return err
	}
	if err := mutate(raws); err != nil {
		return err
	}
	encoded, err := json.Marshal(raws)
	if err != nil {
		return fmt.Errorf("mcp: 序列化 mcpServers: %w", err)
	}
	top[serversKey] = encoded
	return m.writeConfig(scope, cwd, top)
}

// List 列出用户级与项目级的服务，并把「已停用」的补回来（标记 Disabled）。
func (m *Manager) List(cwd string) (Payload, error) {
	out := Payload{User: []Server{}, Project: []Server{}, UserPath: m.userConfig}
	user, err := m.readScope(ScopeUser, "")
	if err != nil {
		return out, err
	}
	out.User = sortedServers(user)
	if cwd != "" {
		out.ProjectRoot = cwd
		out.ProjectPath = projectPath(cwd)
		project, err := m.readScope(ScopeProject, cwd)
		if err != nil {
			return out, err
		}
		out.Project = sortedServers(project)
	}
	// 停用的服务不在配置里，界面仍然要能看到并「启用」它们。
	stash, err := m.readStash()
	if err != nil {
		return out, err
	}
	for _, e := range stash.Servers {
		if !ValidName(e.Name) {
			continue
		}
		srv := parseSpec(e.Name, e.Scope, "", e.Spec)
		srv.Disabled = true
		switch e.Scope {
		case ScopeUser:
			srv.ConfigPath = m.userConfig
			out.User = append(out.User, srv)
		case ScopeProject:
			if cwd == "" {
				continue
			}
			srv.ConfigPath = projectPath(cwd)
			out.Project = append(out.Project, srv)
		}
	}
	sortServers(out.User)
	sortServers(out.Project)
	return out, nil
}

// Find 按作用域 + 名字取一条服务（含停用中的）。
func (m *Manager) Find(cwd, scope, name string) (Server, error) {
	if !ValidName(name) {
		return Server{}, ErrInvalidName
	}
	servers, err := m.readScope(scope, cwd)
	if err != nil {
		return Server{}, err
	}
	if srv, ok := servers[name]; ok {
		return srv, nil
	}
	stash, err := m.readStash()
	if err != nil {
		return Server{}, err
	}
	if i := m.findStash(stash, scope, name); i >= 0 {
		srv := parseSpec(name, scope, "", stash.Servers[i].Spec)
		srv.Disabled = true
		return srv, nil
	}
	return Server{}, ErrNotFound
}

// Save 新增或覆盖一条服务。停用中的服务只改暂存内容，不会被顺手启用。
func (m *Manager) Save(cwd string, in Server) (Server, error) {
	srv, err := Normalize(in)
	if err != nil {
		return Server{}, err
	}
	switch srv.Scope {
	case ScopeUser, ScopeProject:
	default:
		return Server{}, fmt.Errorf("%w: %q", ErrBadScope, srv.Scope)
	}
	spec, err := srv.marshalSpec()
	if err != nil {
		return Server{}, fmt.Errorf("mcp: 序列化配置: %w", err)
	}

	stash, err := m.readStash()
	if err != nil {
		return Server{}, err
	}
	if i := m.findStash(stash, srv.Scope, srv.Name); i >= 0 {
		// 停用中的服务：改的是暂存副本，用户点「启用」时才回到配置里。
		stash.Servers[i].Spec = spec
		if err := m.writeStash(stash); err != nil {
			return Server{}, err
		}
		saved := srv
		saved.Disabled = true
		return saved, nil
	}

	if err := m.update(srv.Scope, cwd, func(raws map[string]json.RawMessage) error {
		raws[srv.Name] = spec
		return nil
	}); err != nil {
		return Server{}, err
	}
	path, err := m.configFor(srv.Scope, cwd)
	if err == nil {
		srv.ConfigPath = path
	}
	return srv, nil
}

// Delete 从配置里删掉一条服务；停用暂存里的同名条目一并删掉。
func (m *Manager) Delete(cwd, scope, name string) error {
	if !ValidName(name) {
		return ErrInvalidName
	}
	servers, err := m.readScope(scope, cwd)
	if err != nil {
		return err
	}
	_, inConfig := servers[name]
	stash, err := m.readStash()
	if err != nil {
		return err
	}
	idx := m.findStash(stash, scope, name)
	if !inConfig && idx < 0 {
		return ErrNotFound
	}
	if inConfig {
		if err := m.update(scope, cwd, func(raws map[string]json.RawMessage) error {
			delete(raws, name)
			return nil
		}); err != nil {
			return err
		}
	}
	if idx >= 0 {
		stash.Servers = append(stash.Servers[:idx], stash.Servers[idx+1:]...)
		if err := m.writeStash(stash); err != nil {
			return err
		}
	}
	return nil
}

// SetEnabled 停用 / 启用一条服务。
//
// 停用 = 把整条配置从 claude 的配置里摘出来、存进本应用自己的暂存文件；启用 = 原样写回。
// 为什么不用 claude 的 disabledMcpjsonServers：那个只对项目级 .mcp.json 生效，
// 用户级没有对应的官方开关，两种作用域用同一个语义才不会一半能停一半不能。
// 代价：停用期间外部工具（`claude mcp list`）看不到这条配置，界面上会明说。
func (m *Manager) SetEnabled(cwd, scope, name string, enabled bool) error {
	if !ValidName(name) {
		return ErrInvalidName
	}
	stash, err := m.readStash()
	if err != nil {
		return err
	}
	if enabled {
		idx := m.findStash(stash, scope, name)
		if idx < 0 {
			return ErrNotFound
		}
		entry := stash.Servers[idx]
		if err := m.update(scope, cwd, func(raws map[string]json.RawMessage) error {
			raws[name] = entry.Spec
			return nil
		}); err != nil {
			return err
		}
		stash.Servers = append(stash.Servers[:idx], stash.Servers[idx+1:]...)
		return m.writeStash(stash)
	}

	servers, err := m.readScope(scope, cwd)
	if err != nil {
		return err
	}
	srv, ok := servers[name]
	if !ok {
		return ErrNotFound
	}
	spec, err := srv.marshalSpec()
	if err != nil {
		return fmt.Errorf("mcp: 序列化配置: %w", err)
	}
	if err := m.update(scope, cwd, func(raws map[string]json.RawMessage) error {
		delete(raws, name)
		return nil
	}); err != nil {
		return err
	}
	return m.upsertStash(stash, stashEntry{Scope: scope, Name: name, Spec: spec})
}

// ---- 停用暂存 ----

type stashEntry struct {
	Scope string          `json:"scope"`
	Name  string          `json:"name"`
	Spec  json.RawMessage `json:"spec"`
}

type stashFile struct {
	Servers []stashEntry `json:"servers"`
}

func (m *Manager) readStash() (stashFile, error) {
	var out stashFile
	if m.disabled == "" {
		return out, nil
	}
	b, err := os.ReadFile(m.disabled)
	if errors.Is(err, os.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return out, fmt.Errorf("mcp: 读取停用暂存: %w", err)
	}
	if len(bytes.TrimSpace(b)) == 0 {
		return out, nil
	}
	if err := json.Unmarshal(b, &out); err != nil {
		// 暂存文件坏了不能让整个设置页打不开：丢弃内容，下次写入时重建。
		return stashFile{}, nil
	}
	return out, nil
}

func (m *Manager) writeStash(s stashFile) error {
	if m.disabled == "" {
		return errors.New("mcp: 未配置停用暂存文件")
	}
	sort.Slice(s.Servers, func(i, j int) bool {
		if s.Servers[i].Scope != s.Servers[j].Scope {
			return s.Servers[i].Scope < s.Servers[j].Scope
		}
		return s.Servers[i].Name < s.Servers[j].Name
	})
	if s.Servers == nil {
		s.Servers = []stashEntry{}
	}
	// 暂存文件是本应用自己的数据文件：同样逐层拒绝软链、原子替换。
	if err := ensureWritable(filepath.Dir(m.disabled), m.disabled); err != nil {
		return err
	}
	return writeJSONFile(m.disabled, s, 0o600)
}

func (m *Manager) upsertStash(s stashFile, e stashEntry) error {
	if i := m.findStash(s, e.Scope, e.Name); i >= 0 {
		s.Servers[i] = e
	} else {
		s.Servers = append(s.Servers, e)
	}
	return m.writeStash(s)
}

func (m *Manager) findStash(s stashFile, scope, name string) int {
	for i, e := range s.Servers {
		if e.Scope == scope && e.Name == name {
			return i
		}
	}
	return -1
}

// sortedServers 把 map 转成按名字排序的切片。
func sortedServers(in map[string]Server) []Server {
	out := make([]Server, 0, len(in))
	for _, v := range in {
		out = append(out, v)
	}
	sortServers(out)
	return out
}

func sortServers(s []Server) {
	sort.Slice(s, func(i, j int) bool { return s[i].Name < s[j].Name })
}

// ---- 连通性探测 ----

// probeTimeout 是单次探测的总预算。MCP server 冷启动（npx 拉包）可能很慢，
// 但界面是同步等结果，超过这个时间就让用户自己看命令是否写对。
const probeTimeout = 12 * time.Second

var (
	proxyMu  sync.RWMutex
	proxyNow = func() string { return "" }
)

// SetProxySource 接上「当前代理」的取值函数。
//
// 探测是面板自己发出的出站请求，不会自动继承设置里的代理（Go 的
// http.ProxyFromEnvironment 只读进程启动时的环境变量），必须像 git/模型列表
// 那样由装配层注入，否则「配了代理但探测不走」。
func SetProxySource(f func() string) {
	if f == nil {
		return
	}
	proxyMu.Lock()
	proxyNow = f
	proxyMu.Unlock()
}

func currentProxy() string {
	proxyMu.RLock()
	defer proxyMu.RUnlock()
	return proxyNow()
}

// probeProtocolVersion 是 initialize 里声明的协议版本。
const probeProtocolVersion = "2025-06-18"

// Probe 连一次 MCP server：stdio 走 JSON-RPC initialize，远程走 HTTP/SSE。
//
// 只探测**已经存进配置的服务**（按 scope+name 取），不接受调用方传命令进来——
// 否则这条接口就成了「免审批执行任意命令」。
func (m *Manager) Probe(cwd, scope, name string) (ProbeResult, error) {
	srv, err := m.Find(cwd, scope, name)
	if err != nil {
		return ProbeResult{}, err
	}
	if srv.Disabled {
		return ProbeResult{}, ErrDisabled
	}
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	switch srv.Type {
	case TypeStdio:
		return probeStdio(ctx, srv), nil
	case TypeSSE, TypeHTTP:
		return probeRemote(ctx, srv), nil
	default:
		return ProbeResult{}, fmt.Errorf("%w: 无法探测类型 %q", ErrInvalidSpec, srv.Type)
	}
}

// probeStdio 起一个子进程，发 initialize，读回第一帧 JSON-RPC。
func probeStdio(ctx context.Context, srv Server) ProbeResult {
	start := time.Now()
	cmd := exec.CommandContext(ctx, srv.Command, srv.Args...)
	cmd.Env = envpath.Ensure(append(os.Environ(), envPairs(srv.Env)...))
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return ProbeResult{Error: err.Error()}
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return ProbeResult{Error: err.Error()}
	}
	// stderr 只留尾部用于报错（MCP server 常把启动失败写在这里），
	// 且必须持续排空，否则管道写满会把子进程卡住。
	var stderr bytes.Buffer
	cmd.Stderr = &limitedWriter{buf: &stderr, limit: 4 << 10}
	if err := cmd.Start(); err != nil {
		return ProbeResult{Error: err.Error()}
	}
	defer func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	line, _ := json.Marshal(initializeRequest())
	if _, err := stdin.Write(append(line, '\n')); err != nil {
		return ProbeResult{Error: err.Error(), LatencyMs: time.Since(start).Milliseconds()}
	}

	// 读循环：MCP server 可能在 initialize 之前先打日志，所以一直读到 JSON-RPC 回包。
	type readResult struct {
		line string
		err  error
	}
	ch := make(chan readResult, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
		for sc.Scan() {
			text := sc.Text()
			trimmed := strings.TrimSpace(text)
			if strings.HasPrefix(trimmed, "{") && strings.Contains(trimmed, `"jsonrpc"`) {
				ch <- readResult{line: trimmed}
				return
			}
		}
		ch <- readResult{err: sc.Err()}
	}()

	select {
	case res := <-ch:
		latency := time.Since(start).Milliseconds()
		if res.err != nil {
			return ProbeResult{Error: res.err.Error(), LatencyMs: latency}
		}
		return parseProbeLine(res.line, latency, stderr.String())
	case <-ctx.Done():
		msg := stderr.String()
		if msg == "" {
			msg = "探测超时（" + probeTimeout.String() + "）"
		}
		return ProbeResult{Error: msg, LatencyMs: time.Since(start).Milliseconds()}
	}
}

// parseProbeLine 解析 initialize 的回包；报错帧也算「连上了但握手失败」。
func parseProbeLine(line string, latency int64, stderr string) ProbeResult {
	var env struct {
		Result *struct {
			ProtocolVersion string `json:"protocolVersion"`
			ServerInfo      struct {
				Name    string `json:"name"`
				Version string `json:"version"`
			} `json:"serverInfo"`
		} `json:"result"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(line), &env); err != nil {
		return ProbeResult{Error: "无法解析 initialize 回包: " + err.Error(), LatencyMs: latency}
	}
	if env.Error != nil && env.Error.Message != "" {
		return ProbeResult{Error: env.Error.Message, LatencyMs: latency}
	}
	out := ProbeResult{OK: true, LatencyMs: latency}
	if env.Result != nil {
		out.Protocol = env.Result.ProtocolVersion
		out.ServerName = env.Result.ServerInfo.Name
		out.ServerVersion = env.Result.ServerInfo.Version
	}
	return out
}

// initializeRequest 是探测用的 MCP 握手帧（客户端实现的固定部分）。
func initializeRequest() map[string]any {
	return map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "initialize",
		"params": map[string]any{
			"protocolVersion": probeProtocolVersion,
			"capabilities":    map[string]any{},
			"clientInfo":      map[string]any{"name": "ccweb", "version": "1"},
		},
	}
}

// probeClient 带代理与超时的 HTTP 客户端。
func probeClient() *http.Client {
	return &http.Client{
		Timeout:   probeTimeout,
		Transport: &http.Transport{Proxy: netproxy.Func(currentProxy())},
	}
}

// probeRemote 探测 http / sse 类型的远端 server。
//
// http：POST 一帧 initialize，看是否回 JSON-RPC（能解析就带出 serverInfo）。
// sse：GET 打开事件流，只看握手是否成功——流会一直开着，读完就是超时。
func probeRemote(ctx context.Context, srv Server) ProbeResult {
	start := time.Now()
	var req *http.Request
	var err error
	if srv.Type == TypeSSE {
		req, err = http.NewRequestWithContext(ctx, http.MethodGet, srv.URL, nil)
	} else {
		body, _ := json.Marshal(initializeRequest())
		req, err = http.NewRequestWithContext(ctx, http.MethodPost, srv.URL, bytes.NewReader(body))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
		}
	}
	if err != nil {
		return ProbeResult{Error: err.Error()}
	}
	req.Header.Set("Accept", "application/json, text/event-stream")
	for k, v := range srv.Headers {
		req.Header.Set(k, v)
	}

	resp, err := probeClient().Do(req)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return ProbeResult{Error: err.Error(), LatencyMs: latency}
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		msg := strings.TrimSpace(string(snippet))
		if msg == "" {
			msg = http.StatusText(resp.StatusCode)
		}
		return ProbeResult{Error: fmt.Sprintf("HTTP %d: %s", resp.StatusCode, msg), LatencyMs: latency}
	}
	if srv.Type == TypeSSE {
		// 事件流不会自己结束，握手成功就算连通；serverInfo 只在 initialize 里有。
		return ProbeResult{OK: true, LatencyMs: latency}
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	return parseServerInfo(body, latency)
}

// parseServerInfo 从 JSON（或 SSE 的 data: 行）里尽力取出 serverInfo。
func parseServerInfo(body []byte, latency int64) ProbeResult {
	out := ProbeResult{OK: true, LatencyMs: latency}
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		line = strings.TrimPrefix(line, "data:")
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "{") || !strings.Contains(line, "serverInfo") {
			continue
		}
		parsed := parseProbeLine(line, latency, "")
		if parsed.OK {
			return parsed
		}
	}
	return out
}

// envPairs 把 map 展平成 KEY=VALUE。
func envPairs(env map[string]string) []string {
	if len(env) == 0 {
		return nil
	}
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k+"="+env[k])
	}
	return out
}

// limitedWriter 只保留前 limit 字节，后续写入丢弃：stderr 可能刷屏。
type limitedWriter struct {
	buf   *bytes.Buffer
	limit int
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	if room := w.limit - w.buf.Len(); room > 0 {
		if len(p) > room {
			w.buf.Write(p[:room])
		} else {
			w.buf.Write(p)
		}
	}
	return len(p), nil
}
