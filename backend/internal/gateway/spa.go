package gateway

import (
	"io/fs"
	"net/http"
	"path"
	"strings"

	"ccweb/backend/internal/webui"
)

// spaFS 返回内嵌的前端产物。抽成变量是为了让网关单测能用内存文件系统
// 覆盖 SPA 回退逻辑，而不依赖构建时是否拷过 frontend/dist。
var spaFS = webui.FS

// handleSPA 提供内嵌的前端产物，并为 index.html 注入运行时 <base href>。
//
// 为什么要注入 base：前端资源用相对路径（vite base:'./'），SPA 路由一旦是
// `/app/ccweb/session/xx` 这种多级路径，`./assets/x.js` 就会解析到
// `/app/ccweb/session/assets/x.js`。注入 <base> 后所有相对路径都以 baseurl 为基准。
//
// TCP 直连通道的 baseurl 是空串（根路径），此时不注入 <base>，相对路径原样生效。
func (s *Server) handleSPA(w http.ResponseWriter, r *http.Request) {
	root, err := spaFS()
	if err != nil {
		http.Error(w, "前端产物缺失", http.StatusInternalServerError)
		return
	}
	base := s.baseOf(r)
	p := strings.TrimPrefix(r.URL.Path, "/")
	if p == "" {
		p = "index.html"
	}
	if b, err := fs.ReadFile(root, p); err == nil {
		if p == "index.html" {
			b = rewriteBase(b, base)
		}
		serveBytes(w, p, b)
		return
	}
	// 带扩展名的请求（assets/*.js、favicon.ico 等）找不到就应当 404。
	// 若这里回退到 index.html，浏览器会拿到 200 + text/html 的"JS"，
	// 拒绝按模块执行 → 整页白屏，且原因极难看出（旧缓存 index 引用了已不存在的哈希）。
	if path.Ext(p) != "" {
		http.NotFound(w, r)
		return
	}

	// 其余（前端路由）才回退到 index.html。
	b, err := fs.ReadFile(root, "index.html")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	serveBytes(w, "index.html", rewriteBase(b, base))
}

// rewriteBase 把 index.html 里的相对资源改成带 base 前缀的绝对路径，并插入 <base>。
func rewriteBase(body []byte, base string) []byte {
	base = strings.TrimRight(base, "/")
	if base == "" {
		return body
	}
	s := string(body)
	s = strings.ReplaceAll(s, `src="./assets/`, `src="`+base+`/assets/`)
	s = strings.ReplaceAll(s, `href="./assets/`, `href="`+base+`/assets/`)
	tag := `<base href="` + base + `/">`
	if i := strings.Index(strings.ToLower(s), "<head"); i >= 0 {
		if j := strings.Index(s[i:], ">"); j >= 0 {
			pos := i + j + 1
			return []byte(s[:pos] + tag + s[pos:])
		}
	}
	return []byte(tag + s)
}

// cacheControlFor 返回静态资源的缓存策略。
// index.html 绝不能缓存：它在响应时才注入 <base>，且引用的资源名带内容哈希。
func cacheControlFor(name string) string {
	switch {
	case strings.HasSuffix(name, ".html"):
		// 必须 no-store：index.html 在响应时才注入 <base>，且它引用的资源名带
		// 内容哈希——一旦被浏览器或中间层存住，下次构建后旧哈希资源已不存在，
		// 页面会直接白屏。no-cache 仍允许"存下来再问我"，no-store 更彻底。
		return "no-store, must-revalidate"
	case strings.HasPrefix(path.Clean(name), "assets/"):
		return "public, max-age=31536000, immutable"
	default:
		return "public, max-age=86400"
	}
}

var contentTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "application/javascript; charset=utf-8",
	".mjs":   "application/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".webp":  "image/webp",
	".ico":   "image/x-icon",
	".woff2": "font/woff2",
	".map":   "application/json; charset=utf-8",
}

func serveBytes(w http.ResponseWriter, name string, b []byte) {
	ct := "text/plain; charset=utf-8"
	if v, ok := contentTypes[path.Ext(name)]; ok {
		ct = v
	}
	w.Header().Set("Cache-Control", cacheControlFor(name))
	w.Header().Set("Content-Type", ct)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(b)
}
