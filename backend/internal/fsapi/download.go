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
//
// **先把清单走完、再开始写**：边遍历边写的话，预算超限时已经吐出去半个 zip，
// 调用方既改不了状态码也收不回来（客户端只会得到一个「200 + 坏包」）。
// 清单只存路径与 FileInfo，20000 条是几 MB，换的是「超限时一个字节都不写」。
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

	type planned struct {
		abs  string
		name string
		info fs.FileInfo
	}
	plan := make([]planned, 0, 64)
	var total, written int64
	walkErr := filepath.WalkDir(real, func(current string, entry fs.DirEntry, dirErr error) error {
		// 读不了的子树跳过：其余部分照样能下载。
		if dirErr != nil {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		// `.git` 只在子树里跳过：直接打包一个 `.git` 目录时，跳过条件会连根一起
		// 跳过，结果是 200 + 一个只有根条目的空包。
		if entry.Name() == ".git" && current != real {
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
		if len(plan)+1 > MaxArchiveEntries {
			return ErrArchiveTooLarge
		}
		if !fileInfo.IsDir() {
			total += fileInfo.Size()
			if total > MaxArchiveBytes {
				return ErrArchiveTooLarge
			}
		}
		entryName := path.Join(root, filepath.ToSlash(relInRoot))
		if fileInfo.IsDir() {
			entryName += "/"
		}
		plan = append(plan, planned{abs: current, name: entryName, info: fileInfo})
		return nil
	})
	if walkErr != nil {
		return "", walkErr
	}

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
	for _, item := range plan {
		header, headerErr := zip.FileInfoHeader(item.info)
		if headerErr != nil {
			continue
		}
		header.Name = item.name
		if item.info.IsDir() {
			header.Method = zip.Store
			if _, err := zw.CreateHeader(header); err != nil {
				_ = zw.Close()
				return "", err
			}
			continue
		}
		header.Method = zip.Deflate
		dst, createErr := zw.CreateHeader(header)
		if createErr != nil {
			_ = zw.Close()
			return "", createErr
		}
		src, openErr := os.Open(item.abs)
		if openErr != nil {
			// 清单与读取之间文件没了：留一个空条目比整个包失败好。
			continue
		}
		// 清单已经核过预算；这里仍按剩余额度读：清单之后文件可能被写大（claude 正在
		// 这个目录里干活），超额要报错而不是悄悄把响应撑破。
		n, copyErr := io.CopyN(dst, src, MaxArchiveBytes-written+1)
		_ = src.Close()
		written += n
		if written > MaxArchiveBytes {
			_ = zw.Close()
			return "", ErrArchiveTooLarge
		}
		if copyErr != nil && !errors.Is(copyErr, io.EOF) {
			_ = zw.Close()
			return "", copyErr
		}
	}
	if err := zw.Close(); err != nil {
		return "", err
	}
	return name, nil
}
