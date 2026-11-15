package gateway

import (
	"io/fs"
	"net/http"
	"path"
	"strings"

	"ccweb/backend/internal/webui"
)

// handleSPA 提供内嵌的前端产物，并为 index.html 注入运行时 <base href>。
//
// 为什么要注入 base：前端资源用相对路径（vite base:'./'），SPA 路由一旦是
// `/app/ccweb/session/xx` 这种多级路径，`./assets/x.js` 就会解析到
// `/app/ccweb/session/assets/x.js`。注入 <base> 后所有相对路径都以 baseurl 为基准。
func (s *Server) handleSPA(w http.ResponseWriter, r *http.Request) {
	root, err := webui.FS()
	if err != nil {
		http.Error(w, "前端产物缺失", http.StatusInternalServerError)
		return
	}
	p := strings.TrimPrefix(r.URL.Path, "/")
	if p == "" {
		p = "index.html"
	}
	if b, err := fs.ReadFile(root, p); err == nil {
		if p == "index.html" {
			b = rewriteBase(b, s.d.Cfg.BaseURL)
		}
		serveBytes(w, p, b)
		return
	}
	// 找不到实体文件 → 交给前端路由处理。
	b, err := fs.ReadFile(root, "index.html")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	serveBytes(w, "index.html", rewriteBase(b, s.d.Cfg.BaseURL))
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
		return "no-cache, must-revalidate"
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
