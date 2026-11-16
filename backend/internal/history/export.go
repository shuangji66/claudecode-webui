package history

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// 导出上限：单文件与整包都设个界，避免一次点「下载」把 NAS 读穿。
var (
	maxExportFileBytes = 64 << 20
	maxExportTotal     = 512 << 20
	maxExportDepth     = 4
)

// SessionLogExists 判断这条会话有没有可导出的转录（先判存在再写响应头，
// 否则 404 只能表现为「下载了一个坏 zip」）。
func SessionLogExists(projectsDir, id string) bool {
	if !validSessionID(id) {
		return false
	}
	_, err := findTranscript(projectsDir, id)
	return err == nil
}

// WriteSessionZip 把一次会话的原始日志打包成 zip。
//
// 内容是 claude 自己写的文件，原样收进去、不解析不改写：主转录 <id>.jsonl，
// 以及会话目录下的子代理转录 / meta / workflows（深度与单文件大小都有上限）。
// 用标准库 archive/zip，不引第三方依赖。
func WriteSessionZip(w io.Writer, projectsDir, id string) error {
	if !validSessionID(id) {
		return ErrTranscriptNotFound
	}
	path, err := findTranscript(projectsDir, id)
	if err != nil {
		return err
	}

	zw := zip.NewWriter(w)
	total := 0
	add := func(name, file string) error {
		n, err := addFileToZip(zw, name, file)
		total += n
		if err != nil {
			return err
		}
		if total > maxExportTotal {
			return fmt.Errorf("history: 导出内容超过 %d MB", maxExportTotal>>20)
		}
		return nil
	}

	if err := add(id+".jsonl", path); err != nil {
		return err
	}

	// 会话目录：<project>/<id>/ 下面放 subagents、workflows 等旁路文件。
	// 目录可能不存在（没开过子代理），那不是错误。
	root := filepath.Join(filepath.Dir(path), id)
	if st, err := os.Stat(root); err == nil && st.IsDir() {
		err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return nil // 读不了的条目跳过，不让一个坏文件毁掉整次导出
			}
			rel, relErr := filepath.Rel(root, p)
			if relErr != nil || rel == "." {
				return nil
			}
			depth := strings.Count(rel, string(filepath.Separator))
			if depth > maxExportDepth {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if d.IsDir() {
				return nil
			}
			// 只收普通文件：符号链接可能指向工作区外。
			if !d.Type().IsRegular() {
				return nil
			}
			return add(filepath.ToSlash(filepath.Join(id, rel)), p)
		})
		if err != nil {
			return err
		}
	}
	return zw.Close()
}

// addFileToZip 把单个文件写进 zip，返回写入的字节数（用于总量控制）。
func addFileToZip(zw *zip.Writer, name, path string) (int, error) {
	src, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer src.Close()
	st, err := src.Stat()
	if err != nil {
		return 0, err
	}
	if st.Size() > int64(maxExportFileBytes) {
		return 0, fmt.Errorf("history: %s 超过 %d MB，未导出", name, maxExportFileBytes>>20)
	}
	hdr, err := zip.FileInfoHeader(st)
	if err != nil {
		return 0, err
	}
	hdr.Name = name
	hdr.Method = zip.Deflate
	dst, err := zw.CreateHeader(hdr)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(dst, src)
	return int(n), err
}
