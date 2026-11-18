package gateway

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"ccweb/backend/internal/authz"
)

// DirAuth 是飞牛「用户授权目录」的读写入口（scope `trim.file.userAccess`）。
//
// 只有查询和删除：**授权本身不能由应用发起**，飞牛要求用户在选择器或授权页上确认
// （前端 `lib/fnos.ts` 的 pickUserFile / openAppAuth），所以这里没有 Add。
type DirAuth interface {
	List(uid int) ([]string, error)
	Remove(uid int, path string) error
}

// dirsPayload 是 /api/dirs 的返回。
//
// Error 非空表示这次没查成（不在统一网关下 / 缺 token / scope 没声明 / 网关报错），
// 前端必须把它显示出来，不能当成「还没有授权目录」——两者对用户意味着完全不同的动作。
type dirsPayload struct {
	Dirs []string `json:"dirs"`
	UID  int      `json:"uid,omitempty"`
	// Protected 是「不能撤销」的路径（应用自己的安装目录 / 数据目录）。
	// 界面据此不给撤销按钮：撤销它等于让运行中的进程读不到自己的二进制。
	Protected []string `json:"protected,omitempty"`
	Error     string   `json:"error,omitempty"`
}

// gatewayUID 从网关转发的 Header 里取当前用户 UID。
//
// **只认 `X-Trim-Userid`，而且只认 unix socket 通道上的那一份**：飞牛统一网关
// 校验登录态之后才注入它，客户端自己传的 uid 一律不信（AGENTS 里那条「不要信任
// 客户端传入的用户 ID」）。
//
// TCP 通道的请求不经过飞牛网关：那个头是浏览器随便写的。认它就等于让任何拿到
// 访问密码的人带上 `X-Trim-Userid: 1000` 去查、甚至撤销别人的目录授权。
// 拿不到可信 uid 时授权无从查起（TCP 直连 / make dev），回空列表 + 原因。
func gatewayUID(r *http.Request) (int, bool) {
	if channelOf(r) != authz.ChannelUnix {
		return 0, false
	}
	v := strings.TrimSpace(r.Header.Get("X-Trim-Userid"))
	if v == "" {
		return 0, false
	}
	uid, err := strconv.Atoi(v)
	if err != nil || uid <= 0 {
		return 0, false
	}
	return uid, true
}

// ProtectedDirs 返回「撤销即自断手脚」的目录：本二进制所在目录与其安装根、数据目录、
// claude HOME。fpk 装好后 target 是指向 @appcenter 的软链，所以一律取 realpath。
func ProtectedDirs(dataDir, claudeHome string) []string {
	out := make([]string, 0, 4)
	add := func(p string) {
		if strings.TrimSpace(p) == "" {
			return
		}
		real, err := filepath.EvalSymlinks(p)
		if err != nil {
			real = p
		}
		real = filepath.Clean(real)
		for _, have := range out {
			if have == real {
				return
			}
		}
		out = append(out, real)
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		add(dir)
		// bin/ 的上一级就是安装根：整个根被撤销，二进制同样读不到。
		add(filepath.Dir(dir))
	}
	add(dataDir)
	add(claudeHome)
	return out
}

// protectedConflict 判断撤销 path 会不会碰到应用自己的目录。
//
// 三条都算冲突：**path 就是**受保护目录、path 是它的**祖先**（trim_acl 一并失效，
// 二进制同样读不到）、path 在它**里面**（安装树里的文件同样是应用自己在用）。
// 宁可多挡一层，也不要让用户在界面上把应用自己的目录撤掉。
func (s *Server) protectedConflict(path string) (string, bool) {
	for _, p := range s.d.DirsProtected {
		guard := filepath.Clean(p)
		if guard == "" {
			continue
		}
		if path == guard ||
			strings.HasPrefix(guard+string(filepath.Separator), path+string(filepath.Separator)) ||
			strings.HasPrefix(path+string(filepath.Separator), guard+string(filepath.Separator)) {
			return guard, true
		}
	}
	return "", false
}

// handleListDirs 返回当前飞牛用户授权给本应用的目录（「设置 → 目录」）。
func (s *Server) handleListDirs(w http.ResponseWriter, r *http.Request) {
	uid, ok := gatewayUID(r)
	if !ok {
		writeJSON(w, dirsPayload{
			Dirs:  []string{},
			Error: "拿不到当前飞牛用户：请从飞牛桌面或 App 打开本应用（直连端口访问没有用户身份）",
		})
		return
	}
	if s.d.Dirs == nil {
		writeJSON(w, dirsPayload{Dirs: []string{}, UID: uid, Error: "本部署没有接飞牛目录接口"})
		return
	}
	dirs, err := s.d.Dirs.List(uid)
	if err != nil {
		writeJSON(w, dirsPayload{Dirs: []string{}, UID: uid, Protected: s.d.DirsProtected, Error: err.Error()})
		return
	}
	writeJSON(w, dirsPayload{Dirs: dirs, UID: uid, Protected: s.d.DirsProtected})
}

// handleRemoveDir 撤销当前飞牛用户对某个目录的授权。
//
// 删除是破坏性动作（撤销后 claude 立刻失去该目录的读写权），前端会先确认一次；
// 这里返回撤销后的完整列表，前端不必再查一次。
func (s *Server) handleRemoveDir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	path := filepath.Clean(strings.TrimSpace(req.Path))
	if !filepath.IsAbs(path) {
		writeErr(w, "path 必须是绝对路径", http.StatusBadRequest)
		return
	}
	uid, ok := gatewayUID(r)
	if !ok {
		writeErr(w, "拿不到当前飞牛用户：请从飞牛桌面或 App 打开本应用", http.StatusForbidden)
		return
	}
	if s.d.Dirs == nil {
		writeErr(w, "本部署没有接飞牛目录接口", http.StatusServiceUnavailable)
		return
	}
	if guard, blocked := s.protectedConflict(path); blocked {
		writeErr(w, "这是应用自己的目录（"+guard+"），不能撤销授权", http.StatusBadRequest)
		return
	}
	if err := s.d.Dirs.Remove(uid, path); err != nil {
		writeErr(w, err.Error(), http.StatusBadGateway)
		return
	}
	dirs, err := s.d.Dirs.List(uid)
	if err != nil {
		// 撤销成功但回读失败：回空列表 + 原因，不要报成删除失败（用户会重复点）。
		writeJSON(w, dirsPayload{Dirs: []string{}, UID: uid, Error: err.Error()})
		return
	}
	writeJSON(w, dirsPayload{Dirs: dirs, UID: uid, Protected: s.d.DirsProtected})
}
