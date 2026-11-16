package gateway

import (
	"encoding/json"
	"errors"
	"net/http"

	"ccweb/backend/internal/skills"
)

// 技能管理：文件层面的 SKILL.md 读写。
//
// 只覆盖 personal / project 两类（真源就是文件，改完 claude 会热加载）。
// synced 只读列出；插件技能与 bundled 技能不在这里管——前者归 `claude plugin`，
// 后者的开关在 settings.json 的 skillOverrides 里。

type skillsPayload struct {
	Personal []skills.Skill `json:"personal"`
	Project  []skills.Skill `json:"project"`
	Synced   []skills.Skill `json:"synced"`
	// ProjectRoot 是项目技能的 cwd；空表示没传或未授权，项目列必为空。
	ProjectRoot string `json:"project_root"`
	// PersonalRoot 供界面显示「个人技能存在哪」。
	PersonalRoot string `json:"personal_root"`
}

// handleListSkills 列出三类技能。项目技能必须过 cwd 授权；个人技能与宿主目录无关。
func (s *Server) handleListSkills(w http.ResponseWriter, r *http.Request) {
	if s.d.Skills == nil {
		writeErr(w, "技能管理未启用", http.StatusServiceUnavailable)
		return
	}
	payload := skillsPayload{
		Personal:     []skills.Skill{},
		Project:      []skills.Skill{},
		Synced:       []skills.Skill{},
		PersonalRoot: s.d.Skills.PersonalRoot(),
	}

	personal, err := s.d.Skills.List(skills.ScopePersonal, "")
	if err != nil {
		writeErr(w, "读取个人技能失败: "+err.Error(), http.StatusInternalServerError)
		return
	}
	payload.Personal = personal

	// 同步技能只读；读失败不影响其它列表。
	if synced, err := s.d.Skills.List(skills.ScopeSynced, ""); err == nil {
		payload.Synced = synced
	}

	if raw := r.URL.Query().Get("cwd"); raw != "" {
		cwd, err := s.authorizedCwd(raw)
		if err != nil {
			s.writeCwdError(w, err)
			return
		}
		project, err := s.d.Skills.List(skills.ScopeProject, cwd)
		if err != nil {
			writeErr(w, "读取项目技能失败: "+err.Error(), http.StatusInternalServerError)
			return
		}
		payload.Project = project
		payload.ProjectRoot = cwd
	}
	writeJSON(w, payload)
}

// skillsTarget 解析「改哪个技能」：scope + name（+ 项目技能需要的 cwd）。
func (s *Server) skillsTarget(w http.ResponseWriter, r *http.Request, cwd, scope, name string) (string, bool) {
	if s.d.Skills == nil {
		writeErr(w, "技能管理未启用", http.StatusServiceUnavailable)
		return "", false
	}
	switch scope {
	case skills.ScopePersonal, skills.ScopeProject:
	case skills.ScopeSynced:
		writeErr(w, "该来源只读", http.StatusForbidden)
		return "", false
	case "":
		writeErr(w, "缺少 scope", http.StatusBadRequest)
		return "", false
	default:
		writeErr(w, "未知技能来源", http.StatusBadRequest)
		return "", false
	}
	if scope != skills.ScopeProject {
		return "", true
	}
	abs, err := s.authorizedCwd(cwd)
	if err != nil {
		s.writeCwdError(w, err)
		return "", false
	}
	return abs, true
}

// writeSkillsError 把 skills 包的哨兵错误映射成状态码。
func writeSkillsError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, skills.ErrInvalidName), errors.Is(err, skills.ErrEmpty):
		writeErr(w, err.Error(), http.StatusBadRequest)
	case errors.Is(err, skills.ErrReadOnly), errors.Is(err, skills.ErrSymlink):
		writeErr(w, err.Error(), http.StatusForbidden)
	case errors.Is(err, skills.ErrNotFound):
		writeErr(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, skills.ErrTooLarge):
		writeErr(w, err.Error(), http.StatusRequestEntityTooLarge)
	default:
		writeErr(w, err.Error(), http.StatusInternalServerError)
	}
}

// handleGetSkill 读取单个技能的 SKILL.md。
func (s *Server) handleGetSkill(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	cwd, ok := s.skillsTarget(w, r, q.Get("cwd"), q.Get("scope"), q.Get("name"))
	if !ok {
		return
	}
	doc, err := s.d.Skills.Read(q.Get("scope"), cwd, q.Get("name"))
	if err != nil {
		writeSkillsError(w, err)
		return
	}
	writeJSON(w, doc)
}

type skillSaveRequest struct {
	Cwd     string `json:"cwd"`
	Scope   string `json:"scope"`
	Name    string `json:"name"`
	Content string `json:"content"`
}

// handleSaveSkill 新建或覆盖 SKILL.md。
func (s *Server) handleSaveSkill(w http.ResponseWriter, r *http.Request) {
	var req skillSaveRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	cwd, ok := s.skillsTarget(w, r, req.Cwd, req.Scope, req.Name)
	if !ok {
		return
	}
	doc, err := s.d.Skills.Save(req.Scope, cwd, req.Name, req.Content)
	if err != nil {
		writeSkillsError(w, err)
		return
	}
	writeJSON(w, doc)
}

// handleDeleteSkill 删除整个技能目录。
func (s *Server) handleDeleteSkill(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	cwd, ok := s.skillsTarget(w, r, q.Get("cwd"), q.Get("scope"), q.Get("name"))
	if !ok {
		return
	}
	if err := s.d.Skills.Delete(q.Get("scope"), cwd, q.Get("name")); err != nil {
		writeSkillsError(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}
