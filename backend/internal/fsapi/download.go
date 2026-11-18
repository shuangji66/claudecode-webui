package fsapi

import (
	"archive/zip"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// 下载与打包的上限：一次点击不该把整块盘打进一个响应里。
const (
	// MaxArchiveEntries 是打包目录时最多写入的条目数。
	MaxArchiveEntries = 20000
	// MaxArchiveBytes 是打包目录时最多写入的原始字节数（压缩后的体积自然更小）。
	MaxArchiveBytes = 2 << 30
)

var (
	// ErrNotDirectory 表示打包目标不是目录。
	ErrNotDirectory = errors.New("fs: 不是目录")
	// ErrArchiveTooLarge 表示目录超过打包预算。
	ErrArchiveTooLarge = errors.New("fs: 目录太大，无法打包下载")
)

// Stat 解析 rel 并返回文件信息，用于下载前决定「直接给文件」还是「打包成 zip」。
func (r *Root) Stat(rel string) (os.FileInfo, string, error) {
	_, real, relPath, err := r.Resolve(rel)
	if err != nil {
		return nil, "", err
	}
	info, err := os.Stat(real)
	if err != nil {
		return nil, "", err
	}
	return info, relPath, nil
}

// OpenDownload 打开一个普通文件供下载：不限制大小、不做类型白名单。
//
// 与 OpenRaw 的分工要分清楚：那条路是**同源 inline 预览**，只放行图片/PDF 并带
// `CSP: sandbox`；下载一律走 `Content-Disposition: attachment`，浏览器只负责存盘，
// 不会把它当页面渲染，所以这里可以放开类型。
func (r *Root) OpenDownload(rel string) (*os.File, os.FileInfo, string, error) {
	_, real, relPath, err := r.Resolve(rel)
	if err != nil {
		return nil, nil, "", err
	}
	info, err := os.Stat(real)
	if err != nil {
		return nil, nil, "", err
	}
	if !info.Mode().IsRegular() {
		return nil, nil, "", ErrNotRegular
	}
	f, err := os.Open(real)
	if err != nil {
		return nil, nil, "", err
	}
	return f, info, relPath, nil
}

// ArchiveName 给出打包 rel 时的 zip 文件名（目录名 + .zip，工作区根用目录名）。
func (r *Root) ArchiveName(relPath string) string {
	base := filepath.Base(relPath)
	if relPath == "" || base == "." || base == string(filepath.Separator) {
		base = filepath.Base(r.Dir)
	}
	if base == "" || base == "." || base == string(filepath.Separator) {
		base = "workspace"
	}
	return base + ".zip"
}

// Zip 把目录打包成 zip 写到 w，返回建议的下载文件名。
//
// 三条边界：**不跟随符号链接**（链接可能指向工作区外）、跳过 `.git`（对象库重新压
// 一遍既慢又没人要）、超出条目/字节预算直接失败而不是悄悄少给几个文件。
// 读不了的子树跳过（下载是尽力而为），但预算超限必须是错误。
func (r *Root) Zip(ctx context.Context, rel string, w io.Writer) (string, error) {
	_, real, relPath, err := r.Resolve(rel)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(real)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", ErrNotDirectory
	}
	name := r.ArchiveName(relPath)
	root := strings.TrimSuffix(name, ".zip")
	zw := zip.NewWriter(w)
	// 先写一条根目录条目：不少解压工具据此创建顶层文件夹（只有文件路径也能建，
	// 但多一条不影响，反而更像常见的 zip）。
	if header, headerErr := zip.FileInfoHeader(info); headerErr == nil {
		header.Name = root + "/"
		header.Method = zip.Store
		if _, err := zw.CreateHeader(header); err != nil {
			_ = zw.Close()
			return "", err
		}
	}
	entries := 0
	var total int64

	walkErr := filepath.WalkDir(real, func(current string, entry fs.DirEntry, dirErr error) error {
		// 读不了的子树跳过：其余部分照样能下载。
		if dirErr != nil {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.Name() == ".git" {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		// 不跟随符号链接：zip 里的名字按实际路径算，链接会把工作区外的内容带进来。
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		relInRoot, relErr := filepath.Rel(real, current)
		if relErr != nil || relInRoot == "." {
			return nil
		}
		fileInfo, infoErr := entry.Info()
		if infoErr != nil {
			return nil
		}
		if !fileInfo.IsDir() && !fileInfo.Mode().IsRegular() {
			return nil
		}
		entries++
		if entries > MaxArchiveEntries {
			return ErrArchiveTooLarge
		}
		header, headerErr := zip.FileInfoHeader(fileInfo)
		if headerErr != nil {
			return nil
		}
		header.Name = path.Join(root, filepath.ToSlash(relInRoot))
		if fileInfo.IsDir() {
			header.Name += "/"
			header.Method = zip.Store
			_, err := zw.CreateHeader(header)
			return err
		}
		header.Method = zip.Deflate
		dst, createErr := zw.CreateHeader(header)
		if createErr != nil {
			return createErr
		}
		src, openErr := os.Open(current)
		if openErr != nil {
			return nil
		}
		n, copyErr := io.Copy(dst, src)
		_ = src.Close()
		total += n
		if total > MaxArchiveBytes {
			return ErrArchiveTooLarge
		}
		return copyErr
	})
	if walkErr != nil {
		// 已经写出去的部分无法撤回；调用方按「已写字节数」决定还能不能报错。
		_ = zw.Close()
		return "", walkErr
	}
	if err := zw.Close(); err != nil {
		return "", err
	}
	return name, nil
}
