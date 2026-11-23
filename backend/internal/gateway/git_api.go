package gateway

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strconv"

	"ccweb/backend/internal/gitctl"
)

// gitReq 是 Git 面板 POST 的统一请求体。
type gitReq struct {
	Cwd     string `json:"cwd"`
	Path    string `json:"path,omitempty"`
	Message string `json:"message,omitempty"`
	Hash    string `json:"hash,omitempty"`
	Branch  string `json:"branch,omitempty"`
}

func (s *Server) decodeGitReq(w http.ResponseWriter, r *http.Request) (gitReq, string, bool) {
	var req gitReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return req, "", false
	}
	cwd, err := s.authorizedCwd(req.Cwd)
	if err != nil {
		s.writeCwdError(w, err)
		return req, "", false
	}
	if !s.gitRootAuthorized(w, cwd) {
		return req, "", false
	}
	return req, cwd, true
}

// gitCwd 只校验请求里的 cwd 落在授权工作区内。
//
// **不校验仓库根**：`GET /api/git/repos` 用它列举工作区里的仓库，而「cwd 属于一个
// 在工作区之外的仓库」正是它要报告的那件事（响应里的 `cwd_repo`），不能在这里挡掉。
// 真正执行 git 的接口改用 gitExecCwd（见 gitRootAuthorized 的注释）。
func (s *Server) gitCwd(w http.ResponseWriter, r *http.Request) (string, bool) {
	cwd, err := s.authorizedCwd(r.URL.Query().Get("cwd"))
	if err != nil {
		s.writeCwdError(w, err)
		return "", false
	}
	return cwd, true
}

// gitExecCwd 是「要真正跑 git」的查询接口用的：cwd 与**仓库根**都要在授权范围内。
func (s *Server) gitExecCwd(w http.ResponseWriter, r *http.Request) (string, bool) {
	cwd, ok := s.gitCwd(w, r)
	if !ok {
		return "", false
	}
	if !s.gitRootAuthorized(w, cwd) {
		return "", false
	}
	return cwd, true
}

// gitRootAuthorized 校验「git 实际会执行的那个目录」也落在授权工作区内。
//
// **只校验传入的 cwd 是不够的**：`gitctl` 的每条命令都先用 `rev-parse --show-toplevel`
// 把 `-C` 提到**仓库根**再执行（见 repoRoot），所以工作区只授权到仓库的某个子目录时
// （AGENTS 4.5 明写这是常见部署），status / diff / stage / discard / commit / pull /
// checkout 全都在工作区**外面**操作：能读到工作区外文件的 diff，也能 discard 掉工作区外
// 未提交的改动——那是数据丢失。
//
// 这里用 `gitctl.EnclosingRepo`（纯文件系统查找 `.git`，不 spawn git）拿到同一个根，
// 再过一次工作区围栏。仓库根不在授权范围内时直接 403：界面本来也不该把那个仓库列出来
// （见 withEnclosingRepo 的同一条判断）。
//
// cwd 本身不是仓库时 EnclosingRepo 返回空串，此时 git 命令会因为「不是一个仓库」失败，
// 没有可执行目录，放行即可。
func (s *Server) gitRootAuthorized(w http.ResponseWriter, cwd string) bool {
	root := gitctl.EnclosingRepo(cwd)
	if root == "" || root == cwd {
		return true
	}
	if err := s.ensureCwdAuthorized(root); err != nil {
		writeErr(w, "该目录属于一个更大的 Git 仓库（"+root+"），而它在授权工作区之外；"+
			"请把那个仓库根加为工作区，或直接在仓库根上使用 Git 面板", http.StatusForbidden)
		return false
	}
	return true
}

func writeGitError(w http.ResponseWriter, err error) {
	writeErr(w, err.Error(), http.StatusBadRequest)
}

// handleGitRepos 列出工作区内的 Git 仓库，供 Git 面板的仓库切换用。
//
// 返回的 root 是绝对路径，前端直接把它当后续 /api/git/* 的 cwd —— 子目录同样能
// 过 authorizedCwd 的工作区校验，所以不需要为「选中的仓库」再加一套鉴权参数。
//
// 扫描从**授权目录**开始，而不是从会话目录开始：会话常常开在某个仓库的子目录里
// （甚至只授权了仓库下面的一层），只扫 cwd 的子树会把旁边的兄弟仓库、以及 cwd
// 所在仓库内部的嵌套仓库全漏掉，界面上就只剩「已经进入的那一个仓库」。
func (s *Server) handleGitRepos(w http.ResponseWriter, r *http.Request) {
	cwd, ok := s.gitCwd(w, r)
	if !ok {
		return
	}
	scanRoot := cwd
	if s.d.Workspaces != nil {
		if root := s.d.Workspaces.Containing(cwd); root != "" {
			scanRoot = root
		}
	}
	repos, err := gitctl.FindRepos(scanRoot, 0)
	if err != nil {
		writeGitError(w, err)
		return
	}
	// cwd 所在的仓库可能不在列表里（工作区只授权了仓库下面的一层，那个仓库根
	// 过不了围栏）。把它单独告诉前端：这种情况下不该自动选中列表里的**另一个**
	// 仓库，否则面板会悄悄从「当前对话的仓库」跳到别的仓库上。
	enclosing := gitctl.EnclosingRepo(cwd)
	repos = s.withEnclosingRepo(enclosing, scanRoot, repos)
	writeJSON(w, map[string]any{"repos": repos, "root": scanRoot, "cwd_repo": enclosing})
}

// withEnclosingRepo 把「cwd 属于、但扫描根在它里面」的那个仓库补到列表最前面。
//
// 典型场景：工作区只授权了仓库下面的一层（`<repo>/app`）。从工作区往下扫是看不到
// 仓库根的，可 `git` 在 cwd 上本来就把整个仓库当上下文——不补的话，面板会从
// 「进入的仓库」跳到列表里另一个仓库。授权范围外的仓库一律不补：后面每条
// /api/git/* 都要过同一个围栏，列出来只会变成一串 403。
func (s *Server) withEnclosingRepo(enclosing, scanRoot string, repos []gitctl.Repo) []gitctl.Repo {
	if enclosing == "" || enclosing == scanRoot {
		return repos
	}
	for _, r := range repos {
		if r.Root == enclosing {
			return repos
		}
	}
	if err := s.ensureCwdAuthorized(enclosing); err != nil {
		return repos
	}
	path := ""
	if rel, err := filepath.Rel(scanRoot, enclosing); err == nil && rel != "." {
		path = filepath.ToSlash(rel)
	}
	head := gitctl.Repo{Path: path, Name: filepath.Base(enclosing), Root: enclosing}
	return append([]gitctl.Repo{head}, repos...)
}

// handleGitStatus 返回 Git 面板快照；不是仓库时返回 is_repo=false。
func (s *Server) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	cwd, ok := s.gitExecCwd(w, r)
	if !ok {
		return
	}
	status, err := gitctl.ReadStatus(r.Context(), cwd)
	if err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, status)
}

// handleGitDiff 返回工作区或索引侧的补丁。
func (s *Server) handleGitDiff(w http.ResponseWriter, r *http.Request) {
	cwd, ok := s.gitExecCwd(w, r)
	if !ok {
		return
	}
	staged := false
	if raw := r.URL.Query().Get("staged"); raw != "" {
		staged, _ = strconv.ParseBool(raw)
	}
	diff, err := gitctl.Diff(r.Context(), cwd, r.URL.Query().Get("path"), staged)
	if err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, map[string]string{"diff": diff})
}

// handleGitShow 返回一次提交的详情（元数据 + 补丁）。
//
// 界面把它拆成「提交详情 / 差异」两页，但两页描述的是同一次提交：分成两个
// 接口只会让点开一次提交发两次 git show（大提交各跑一遍，慢一倍）。
func (s *Server) handleGitShow(w http.ResponseWriter, r *http.Request) {
	cwd, ok := s.gitExecCwd(w, r)
	if !ok {
		return
	}
	commit, err := gitctl.CommitDetails(r.Context(), cwd, r.URL.Query().Get("hash"))
	if err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, commit)
}

// handleGitLog 返回最近提交。
func (s *Server) handleGitLog(w http.ResponseWriter, r *http.Request) {
	cwd, ok := s.gitExecCwd(w, r)
	if !ok {
		return
	}
	count, _ := strconv.Atoi(r.URL.Query().Get("count"))
	skip, _ := strconv.Atoi(r.URL.Query().Get("skip"))
	entries, err := gitctl.Log(r.Context(), cwd, count, skip)
	if err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, map[string]any{"entries": entries})
}

// handleGitBranches 返回本地分支清单。
func (s *Server) handleGitBranches(w http.ResponseWriter, r *http.Request) {
	cwd, ok := s.gitExecCwd(w, r)
	if !ok {
		return
	}
	branches, err := gitctl.ListBranches(r.Context(), cwd)
	if err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, branches)
}

// handleGitStage 暂存单个文件或全部（path 为空）。
func (s *Server) handleGitStage(w http.ResponseWriter, r *http.Request) {
	req, cwd, ok := s.decodeGitReq(w, r)
	if !ok {
		return
	}
	if err := gitctl.Stage(r.Context(), cwd, req.Path); err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handleGitUnstage 取消暂存单个文件或全部。
func (s *Server) handleGitUnstage(w http.ResponseWriter, r *http.Request) {
	req, cwd, ok := s.decodeGitReq(w, r)
	if !ok {
		return
	}
	if err := gitctl.Unstage(r.Context(), cwd, req.Path); err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handleGitDiscard 丢弃一个已跟踪文件的工作区改动。
func (s *Server) handleGitDiscard(w http.ResponseWriter, r *http.Request) {
	req, cwd, ok := s.decodeGitReq(w, r)
	if !ok {
		return
	}
	if err := gitctl.Discard(r.Context(), cwd, req.Path); err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handleGitCommit 提交已暂存内容（沿用用户 git 身份）。
func (s *Server) handleGitCommit(w http.ResponseWriter, r *http.Request) {
	req, cwd, ok := s.decodeGitReq(w, r)
	if !ok {
		return
	}
	if err := gitctl.Commit(r.Context(), cwd, req.Message); err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handleGitCheckout 切换本地分支。
func (s *Server) handleGitCheckout(w http.ResponseWriter, r *http.Request) {
	req, cwd, ok := s.decodeGitReq(w, r)
	if !ok {
		return
	}
	if err := gitctl.Checkout(r.Context(), cwd, req.Branch); err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handleGitPull 只做 fast-forward pull。
//
// **不 push**：这是本机开发用的面板，把改动推上去属于明确的对外动作，不该由
// 侧栏一个图标顺手完成。需要推送时用户自己开终端 `git push`。
func (s *Server) handleGitPull(w http.ResponseWriter, r *http.Request) {
	_, cwd, ok := s.decodeGitReq(w, r)
	if !ok {
		return
	}
	if err := gitctl.Pull(r.Context(), cwd); err != nil {
		writeGitError(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}
