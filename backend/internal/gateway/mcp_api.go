package gateway

import (
	"encoding/json"
	"errors"
	"net/http"

	"ccweb/backend/internal/mcp"
)

// MCP 管理：读写 claude 的两份配置（用户级 .claude.json / 项目级 .mcp.json）。
//
// 为什么不走 claude CLI：`claude mcp add` 是交互式的，本应用把 claude 当常驻
// 子进程跑（--input-format stream-json），没有终端给它。文件就是唯一真源，
// 改完由用户重开会话生效——MCP server 是会话启动时连接的，不会热加载。
//
// 安全边界：
//   - 项目级的一切操作都必须过 authorizedCwd（工作区之外的文件一律不碰）；
//   - 探测只接受「已保存的服务名」，不接受请求里带命令进来——否则这条接口
//     就等于「免审批执行任意命令」；
//   - 停用是「把配置摘到本应用自己的暂存文件」，不是删配置。

// mcpTarget 解析作用域并校验项目级 cwd。返回解析后的 cwd（用户级为空）。
func (s *Server) mcpTarget(w http.ResponseWriter, scope, cwd string) (string, bool) {
	if s.d.Mcp == nil {
		writeErr(w, "MCP 管理未启用", http.StatusServiceUnavailable)
		return "", false
	}
	switch scope {
	case mcp.ScopeUser:
		return "", true
	case mcp.ScopeProject:
		if cwd == "" {
			writeErr(w, "缺少 cwd", http.StatusBadRequest)
			return "", false
		}
		abs, err := s.authorizedCwd(cwd)
		if err != nil {
			s.writeCwdError(w, err)
			return "", false
		}
		return abs, true
	case "":
		writeErr(w, "缺少 scope", http.StatusBadRequest)
		return "", false
	default:
		writeErr(w, "未知作用域", http.StatusBadRequest)
		return "", false
	}
}

// writeMcpError 把 mcp 包的哨兵错误映射成状态码。
func writeMcpError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, mcp.ErrInvalidName), errors.Is(err, mcp.ErrInvalidSpec), errors.Is(err, mcp.ErrBadScope):
		writeErr(w, err.Error(), http.StatusBadRequest)
	case errors.Is(err, mcp.ErrNotFound):
		writeErr(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, mcp.ErrDisabled):
		writeErr(w, err.Error(), http.StatusConflict)
	case errors.Is(err, mcp.ErrSymlink):
		writeErr(w, err.Error(), http.StatusForbidden)
	default:
		writeErr(w, err.Error(), http.StatusInternalServerError)
	}
}

// handleListMcp 列出用户级与项目级服务（含停用项）。
func (s *Server) handleListMcp(w http.ResponseWriter, r *http.Request) {
	if s.d.Mcp == nil {
		writeErr(w, "MCP 管理未启用", http.StatusServiceUnavailable)
		return
	}
	cwd := ""
	if raw := r.URL.Query().Get("cwd"); raw != "" {
		abs, err := s.authorizedCwd(raw)
		if err != nil {
			s.writeCwdError(w, err)
			return
		}
		cwd = abs
	}
	payload, err := s.d.Mcp.List(cwd)
	if err != nil {
		writeErr(w, "读取 MCP 配置失败: "+err.Error(), http.StatusInternalServerError)
		return
	}
	markBuiltinMcp(&payload)
	writeJSON(w, payload)
}

// markBuiltinMcp 给 ccweb 自己维护的服务打标（界面据此只留探测与启停）。
//
// 这个标记只在这里算：mcp 包不认识「哪些名字是内置的」，那属于装配/网关的事。
func markBuiltinMcp(payload *mcp.Payload) {
	for i := range payload.User {
		if isBuiltinMcp(payload.User[i].Scope, payload.User[i].Name) {
			payload.User[i].Builtin = true
		}
	}
}

// handleSaveMcp 新增或覆盖一条服务。
func (s *Server) handleSaveMcp(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Cwd    string     `json:"cwd"`
		Server mcp.Server `json:"server"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	cwd, ok := s.mcpTarget(w, body.Server.Scope, body.Cwd)
	if !ok {
		return
	}
	// 内置服务也不许编辑：改了下次启动被 EnsureScheduleMCP 覆盖回原样，中间那段时间
	// 会话里跑的是「用户以为改过、实际马上会消失」的配置。启停仍然开放（那是暂存语义）。
	if isBuiltinMcp(body.Server.Scope, body.Server.Name) {
		writeErr(w, "内置服务由 ccweb 自动维护（自动化任务的模型入口），不能编辑；需要临时关掉请用「停用」",
			http.StatusConflict)
		return
	}
	saved, err := s.d.Mcp.Save(cwd, body.Server)
	if err != nil {
		writeMcpError(w, err)
		return
	}
	writeJSON(w, saved)
}

// handleDeleteMcp 删除一条服务（停用暂存里的同名条目一并删掉）。
func (s *Server) handleDeleteMcp(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	cwd, ok := s.mcpTarget(w, q.Get("scope"), q.Get("cwd"))
	if !ok {
		return
	}
	// 内置服务（自动化任务的 ccweb-schedule）删不得：删掉之后模型立刻没有那三个工具，
	// 下次启动 EnsureScheduleMCP 又原样写回来——用户看到的是「删了又自己长出来」。
	// 只想暂时关掉就用「停用」（写进暂存文件，重启后仍然保持）。
	if isBuiltinMcp(q.Get("scope"), q.Get("name")) {
		writeErr(w, "内置服务由 ccweb 自动维护（自动化任务的模型入口），不能删除；需要临时关掉请用「停用」",
			http.StatusConflict)
		return
	}
	if err := s.d.Mcp.Delete(cwd, q.Get("scope"), q.Get("name")); err != nil {
		writeMcpError(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// handleSetMcpEnabled 停用 / 启用一条服务。
func (s *Server) handleSetMcpEnabled(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Cwd     string `json:"cwd"`
		Scope   string `json:"scope"`
		Name    string `json:"name"`
		Enabled bool   `json:"enabled"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	cwd, ok := s.mcpTarget(w, body.Scope, body.Cwd)
	if !ok {
		return
	}
	if err := s.d.Mcp.SetEnabled(cwd, body.Scope, body.Name, body.Enabled); err != nil {
		writeMcpError(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// handleProbeMcp 探一次连通性。只认已保存的服务名。
func (s *Server) handleProbeMcp(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Cwd   string `json:"cwd"`
		Scope string `json:"scope"`
		Name  string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	cwd, ok := s.mcpTarget(w, body.Scope, body.Cwd)
	if !ok {
		return
	}
	res, err := s.d.Mcp.Probe(cwd, body.Scope, body.Name)
	if err != nil {
		writeMcpError(w, err)
		return
	}
	writeJSON(w, res)
}
