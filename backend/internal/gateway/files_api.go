package gateway

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"ccweb/backend/internal/fsapi"
	"ccweb/backend/internal/project"
)

// errCwdForbidden 区分「目录不存在」与「目录未授权」，前者 400、后者 403。
var errCwdForbidden = errors.New("目录未授权")

// authorizedCwd 校验请求里的 cwd：先确认是真实目录，再确认落在授权工作区内。
func (s *Server) authorizedCwd(raw string) (string, error) {
	abs, err := project.Validate(raw)
	if err != nil {
		return "", err
	}
	if err := s.ensureCwdAuthorized(abs); err != nil {
		return "", errCwdForbidden
	}
	return abs, nil
}

func (s *Server) writeCwdError(w http.ResponseWriter, err error) {
	code := http.StatusBadRequest
	if errors.Is(err, errCwdForbidden) {
		code = http.StatusForbidden
		err = errors.New("目录未授权：请先在左侧「工作区」里添加该目录")
	}
	writeErr(w, err.Error(), code)
}

func (s *Server) openFsRoot(w http.ResponseWriter, r *http.Request) (*fsapi.Root, bool) {
	cwd, err := s.authorizedCwd(r.URL.Query().Get("cwd"))
	if err != nil {
		s.writeCwdError(w, err)
		return nil, false
	}
	root, err := fsapi.OpenRoot(cwd)
	if err != nil {
		writeErr(w, err.Error(), http.StatusBadRequest)
		return nil, false
	}
	return root, true
}

// handleFsTree 列出工作区内的一层目录（懒加载的树每次只请求一层）。
func (s *Server) handleFsTree(w http.ResponseWriter, r *http.Request) {
	root, ok := s.openFsRoot(w, r)
	if !ok {
		return
	}
	hidden := false
	if raw := r.URL.Query().Get("hidden"); raw != "" {
		if v, err := strconv.ParseBool(raw); err == nil {
			hidden = v
		}
	}
	limit := 0
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil {
			limit = v
		}
	}
	listing, err := root.List(r.URL.Query().Get("path"), hidden, limit)
	if err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, fsapi.ErrOutside) {
			code = http.StatusForbidden
		}
		writeErr(w, err.Error(), code)
		return
	}
	writeJSON(w, listing)
}

// handleFsFile 返回文本预览；超大文件截断，二进制文件只返回元数据。
func (s *Server) handleFsFile(w http.ResponseWriter, r *http.Request) {
	root, ok := s.openFsRoot(w, r)
	if !ok {
		return
	}
	rel := r.URL.Query().Get("path")
	if strings.TrimSpace(rel) == "" {
		writeErr(w, "missing path", http.StatusBadRequest)
		return
	}
	file, err := root.Read(rel, 0)
	if err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, fsapi.ErrOutside) {
			code = http.StatusForbidden
		}
		writeErr(w, err.Error(), code)
		return
	}
	writeJSON(w, file)
}

// allowedRawTypes 是可直接 inline 预览的类型白名单。
//
// 绝不能把 HTML / SVG 当同源资源直接返回：工作区里的文件可能带脚本，
// 一旦以同源 inline 打开就能读到 localStorage 里的 token 并调用 API。
// 文本走 /api/fs/file 的 JSON（React 转义），SVG 只显示源码。
var allowedRawTypes = map[string]bool{
	"image/png":       true,
	"image/jpeg":      true,
	"image/gif":       true,
	"image/webp":      true,
	"image/bmp":       true,
	"image/x-icon":    true,
	"application/pdf": true,
	// 纯文本安全（nosniff + sandbox），让「新窗口打开」对源码/日志也有意义。
	"text/plain": true,
}

// handleFsRaw 返回图片 / PDF 原始字节，供 <img>/<iframe> 预览。
func (s *Server) handleFsRaw(w http.ResponseWriter, r *http.Request) {
	root, ok := s.openFsRoot(w, r)
	if !ok {
		return
	}
	rel := r.URL.Query().Get("path")
	if strings.TrimSpace(rel) == "" {
		writeErr(w, "missing path", http.StatusBadRequest)
		return
	}
	f, info, relPath, err := root.OpenRaw(rel)
	if err != nil {
		code := http.StatusBadRequest
		switch {
		case errors.Is(err, fsapi.ErrOutside):
			code = http.StatusForbidden
		case errors.Is(err, fsapi.ErrTooLarge):
			code = http.StatusRequestEntityTooLarge
		}
		writeErr(w, err.Error(), code)
		return
	}
	defer f.Close()

	// 先按扩展名给出保守类型，再让 ServeContent 嗅探；只放行白名单。
	ctype := rawContentType(relPath)
	if ctype == "" {
		buf := make([]byte, 512)
		n, _ := f.Read(buf)
		ctype = http.DetectContentType(buf[:n])
		if _, err := f.Seek(0, 0); err != nil {
			writeErr(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	// DetectContentType 会给文本带上 "; charset=utf-8"，白名单只比对媒体类型。
	mediaType := strings.TrimSpace(strings.SplitN(ctype, ";", 2)[0])
	if !allowedRawTypes[mediaType] {
		writeErr(w, "该文件类型不支持内嵌预览", http.StatusUnsupportedMediaType)
		return
	}
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "no-store")
	// 即使将来放行了可执行内容，沙箱也能兜住脚本。
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'")
	h.Set("Content-Disposition", "inline")
	http.ServeContent(w, r, path.Base(relPath), info.ModTime(), f)
}

// maxHostFileBytes 是「从飞牛选择」读取宿主文件的上限，与前端附件的单文件上限一致。
const maxHostFileBytes = 8 << 20

// hostFileTypes 是允许经 API 读取并转成附件的扩展名 → 期望类型。
var hostFileTypes = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".pdf":  "application/pdf",
}

// handleFsHostFile 读取飞牛目录选择器挑中的宿主文件，转成对话附件。
//
// 这是**唯一一个不受工作区围栏约束**的读文件接口：选择器可以把用户自己的任意目录
// 交给应用，而这些文件本来就不在工作区里。所以边界收得很紧：只放行图片/PDF
// （扩展名 + 内容嗅探双重确认）、必须是普通文件、单文件 ≤ 8MB，且必须挂鉴权。
// 其他类型不读取——前端把路径作为引用写进消息，claude 自己用 Read 工具去读。
func (s *Server) handleFsHostFile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	abs := filepath.Clean(strings.TrimSpace(req.Path))
	if !filepath.IsAbs(abs) {
		writeErr(w, "需要绝对路径", http.StatusBadRequest)
		return
	}
	if _, ok := hostFileTypes[strings.ToLower(filepath.Ext(abs))]; !ok {
		writeErr(w, "只支持把图片或 PDF 读成附件；其他文件请用路径引用", http.StatusUnsupportedMediaType)
		return
	}
	st, err := os.Stat(abs)
	if err != nil {
		writeErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if !st.Mode().IsRegular() {
		writeErr(w, "不是普通文件", http.StatusBadRequest)
		return
	}
	if st.Size() > maxHostFileBytes {
		writeErr(w, "文件超过 8MB", http.StatusRequestEntityTooLarge)
		return
	}
	raw, err := os.ReadFile(abs)
	if err != nil {
		writeErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	// 扩展名只用来初筛，真正放行看内容：改名的 HTML/SVG 不能被当成图片读走。
	head := raw
	if len(head) > 512 {
		head = head[:512]
	}
	mediaType := strings.TrimSpace(strings.SplitN(http.DetectContentType(head), ";", 2)[0])
	if !allowedRawTypes[mediaType] || mediaType == "text/plain" {
		writeErr(w, "文件内容不是图片或 PDF", http.StatusUnsupportedMediaType)
		return
	}
	writeJSON(w, map[string]any{
		"name":       filepath.Base(abs),
		"media_type": mediaType,
		"size":       st.Size(),
		"data":       base64.StdEncoding.EncodeToString(raw),
	})
}

// rawContentType 按扩展名返回可预览类型；未知类型返回空串交给嗅探。
func rawContentType(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	case ".ico":
		return "image/x-icon"
	case ".pdf":
		return "application/pdf"
	default:
		return ""
	}
}
