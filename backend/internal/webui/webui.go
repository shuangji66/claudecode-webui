// Package webui 把前端构建产物打进二进制。
//
// 构建流程（见 Makefile / build.sh）：`vite build` 的产物拷到 embed/ 下，
// `go build` 时由 go:embed 收进二进制；运行时通过 gateway 的 SPA handler 提供。
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:embed
var files embed.FS

// FS 返回以 embed/ 为根的只读文件系统。
func FS() (fs.FS, error) {
	return fs.Sub(files, "embed")
}

// HasIndex 报告二进制里是否真的带了前端产物（构建时忘了拷 dist 会返回 false）。
func HasIndex() bool {
	_, err := files.ReadFile("embed/index.html")
	return err == nil
}
