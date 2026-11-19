package gateway

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime"
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
//
// 返回的是**解析符号链接后的真实路径**：围栏必须以真实路径为锚点。原先只做词法
// 校验，而下游 fsapi.OpenRoot 又把 EvalSymlinks(cwd) 当围栏根，于是工作区里一个
// `<ws>/link -> /etc` 就能让 /api/fs、/api/git、/ws/terminal、/api/skills 全部
// 落到工作区外（授权判的是软链路径，围栏判的是链接目标，两边各说各话）。
func (s *Server) authorizedCwd(raw string) (string, error) {
	abs, err := project.Validate(raw)
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	if err := s.ensureCwdAuthorized(real); err != nil {
		return "", errCwdForbidden
	}
	return real, nil
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

// handleFsComplete 为输入框的 `@` 补全返回工作区内的候选路径。
//
// 只回相对路径：选中的值作为 `@相对路径` 插进草稿，文件内容留给 claude 自己用
// Read 工具去读——补全接口不做宿主文件读取。与文件树一样先过 authorizedCwd，
// 再走 fsapi 的路径围栏。
func (s *Server) handleFsComplete(w http.ResponseWriter, r *http.Request) {
	root, ok := s.openFsRoot(w, r)
	if !ok {
		return
	}
	limit := 0
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil {
			limit = v
		}
	}
	listing, err := root.Complete(r.Context(), r.URL.Query().Get("q"), limit)
	if err != nil {
		writeErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, listing)
}

// countingWriter 记录已经写出去的字节数：打包失败时用它判断还能不能改状态码。
type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

// attachmentHeader 生成 Content-Disposition：文件名走 RFC 2231，中文名也能正确落盘。
func attachmentHeader(name string) string {
	return mime.FormatMediaType("attachment", map[string]string{"filename": name})
}

// handleFsDownload 下载工作区里的文件（原样流式）或目录（打包成 zip）。
//
// 与 /api/fs/raw 的分工：raw 是**同源 inline 预览**，只放行图片/PDF 并带 CSP；
// 下载一律 `Content-Disposition: attachment`，浏览器不会渲染它，所以不设类型白名单，
// 也不把整个文件读进内存（大文件在 NAS 上很常见）。
func (s *Server) handleFsDownload(w http.ResponseWriter, r *http.Request) {
	root, ok := s.openFsRoot(w, r)
	if !ok {
		return
	}
	rel := r.URL.Query().Get("path")
	if strings.TrimSpace(rel) == "" {
		writeErr(w, "missing path", http.StatusBadRequest)
		return
	}
	info, relPath, err := root.Stat(rel)
	if err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, fsapi.ErrOutside) {
			code = http.StatusForbidden
		}
		writeErr(w, err.Error(), code)
		return
	}

	if info.IsDir() {
		// 头先摆好（Zip 会直接往 w 写，写之前必须先定好 Content-Type）。
		// 打包先走完清单再落笔，所以预算超限时一个字节都没出去，头也还没 flush，
		// 还能把它们撤掉换成一个正常的错误响应。
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", attachmentHeader(root.ArchiveName(relPath)))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// 与 /api/fs/raw 一致：下载内容不进任何缓存（共用浏览器/前置代理时那是越权读取面）。
		w.Header().Set("Cache-Control", "no-store")
		out := &countingWriter{w: w}
		if _, err := root.Zip(r.Context(), rel, out); err != nil {
			if out.n == 0 {
				for _, key := range []string{"Content-Type", "Content-Disposition", "X-Content-Type-Options", "Cache-Control"} {
					w.Header().Del(key)
				}
				code := http.StatusBadRequest
				switch {
				case errors.Is(err, fsapi.ErrArchiveTooLarge):
					// 「太大」是拒绝，不是请求写错了。
					code = http.StatusRequestEntityTooLarge
				case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
					// 浏览器自己取消了请求，没什么可回的。
					return
				}
				writeErr(w, err.Error(), code)
				return
			}
			// 已经开始写正文（磁盘错误、客户端断开）：改不了状态码，至少留下原因。
			s.log.Printf("打包下载失败（%s，已写 %d 字节）: %v", relPath, out.n, err)
			return
		}
		return
	}

	f, fileInfo, relPath, err := root.OpenDownload(rel)
	if err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, fsapi.ErrOutside) {
			code = http.StatusForbidden
		}
		writeErr(w, err.Error(), code)
		return
	}
	defer f.Close()
	name := path.Base(relPath)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", attachmentHeader(name))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	// ServeContent 负责 Range / Content-Length；ReadSeeker 就是 *os.File。
	http.ServeContent(w, r, name, fileInfo.ModTime(), f)
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

// officePreviewExts 是前端能在浏览器里就地渲染的 Office 扩展名（OOXML 三类 + 宏变体）。
//
// 老格式（.doc/.xls/.ppt）是 OLE 复合文档，浏览器端没有可用的解析库，不列进来：
// 它们继续走 /api/fs/file 的 binary 占位 + 下载。
var officePreviewExts = map[string]bool{
	".docx": true, ".docm": true,
	".xlsx": true, ".xlsm": true,
	".pptx": true, ".pptm": true,
}

// maxOfficePreviewBytes 是 Office 预览读取上限。
//
// 字节会整份留在浏览器内存里（解析器需要完整的 zip），NAS 上一份几十 MB 的 pptx
// 读进来就能把标签页拖垮。32MB 覆盖绝大多数字面文档，超限让用户下载后自己看。
const maxOfficePreviewBytes = 32 << 20

// handleFsBlob 返回 Office 文档的原始字节，供前端在浏览器里解析渲染。
//
// 与 /api/fs/raw 的分工：raw 是**同源 inline 预览**（图片/PDF 由浏览器自己渲染，
// 带 CSP sandbox）；这条只回 `application/octet-stream` + nosniff，前端 fetch 成
// ArrayBuffer 交给解析器，浏览器永远不会把它当页面执行，所以不需要 inline 那套 CSP。
//
// 仍然收在扩展名白名单里：前端只需要这三类字节，不要把这条接口做成「读工作区任意
// 文件」的通道——那种需求走 /api/fs/download（attachment，不经过 DOM）。
func (s *Server) handleFsBlob(w http.ResponseWriter, r *http.Request) {
	root, ok := s.openFsRoot(w, r)
	if !ok {
		return
	}
	rel := r.URL.Query().Get("path")
	if strings.TrimSpace(rel) == "" {
		writeErr(w, "missing path", http.StatusBadRequest)
		return
	}
	info, relPath, err := root.Stat(rel)
	if err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, fsapi.ErrOutside) {
			code = http.StatusForbidden
		}
		writeErr(w, err.Error(), code)
		return
	}
	if !info.Mode().IsRegular() {
		writeErr(w, "目录不能预览", http.StatusBadRequest)
		return
	}
	if !officePreviewExts[strings.ToLower(filepath.Ext(relPath))] {
		writeErr(w, "该文件类型不支持内嵌预览", http.StatusUnsupportedMediaType)
		return
	}
	if info.Size() > maxOfficePreviewBytes {
		writeErr(w, "文件超过 32MB，请下载后打开", http.StatusRequestEntityTooLarge)
		return
	}
	f, fileInfo, filePath, err := root.OpenDownload(rel)
	if err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, fsapi.ErrOutside) {
			code = http.StatusForbidden
		}
		writeErr(w, err.Error(), code)
		return
	}
	defer f.Close()
	// Stat 与打开之间文件还可能变大，按打开后的真实大小再挡一次。
	if fileInfo.Size() > maxOfficePreviewBytes {
		writeErr(w, "文件超过 32MB，请下载后打开", http.StatusRequestEntityTooLarge)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, path.Base(filePath), fileInfo.ModTime(), f)
}

// allowedRawTypes 是可直接 inline 预览的类型白名单。
//
// 绝不能把 HTML / SVG 当同源资源直接返回：工作区里的文件可能带脚本，
// 一旦以同源 inline 打开就能读到 localStorage 里的 token 并调用 API。
// 文本走 /api/fs/file 的 JSON（React 转义），SVG 只显示源码。
// 白名单只保留图片与 PDF：`text/plain` 曾经被放进来「让源码也能新窗口打开」，
// 但那是把任意文本文件变成一个同源 URL（token 还在 query 上），收益不抵边界成本。
var allowedRawTypes = map[string]bool{
	"image/png":       true,
	"image/jpeg":      true,
	"image/gif":       true,
	"image/webp":      true,
	"image/bmp":       true,
	"image/x-icon":    true,
	"application/pdf": true,
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
