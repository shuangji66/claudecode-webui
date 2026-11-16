package history

import (
	"archive/zip"
	"errors"
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
	// add 把「跳过某个文件」与「真的失败」分开：超大文件只该少一个条目，
	// 不该在响应头已发出之后终止打包（客户端会拿到 200 + 一个没有中央目录的坏 zip）。
	add := func(name, file string, limit int64) error {
		n, skipped, err := addFileToZip(zw, name, file, limit)
		if err != nil {
			return err
		}
		if skipped {
			return nil
		}
		total += n
		if total > maxExportTotal {
			// 总量超限：停在这里，zip 仍然是完整可打开的（已写入的条目保留）。
			return filepath.SkipAll
		}
		return nil
	}

	// 主转录是用户要的东西本身，不受单文件上限约束（流式写入，不占内存）。
	if err := add(id+".jsonl", path, 0); err != nil {
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
			return add(filepath.ToSlash(filepath.Join(id, rel)), p, int64(maxExportFileBytes))
		})
		if err != nil && !errors.Is(err, filepath.SkipAll) {
			return err
		}
	}
	return zw.Close()
}

// addFileToZip 把单个文件写进 zip，返回写入字节数与「是否因超限被跳过」。
// limit 为 0 表示不检查单文件大小。
func addFileToZip(zw *zip.Writer, name, path string, limit int64) (int, bool, error) {
	src, err := os.Open(path)
	if err != nil {
		return 0, false, err
	}
	defer src.Close()
	st, err := src.Stat()
	if err != nil {
		return 0, false, err
	}
	if limit > 0 && st.Size() > limit {
		return 0, true, nil
	}
	hdr, err := zip.FileInfoHeader(st)
	if err != nil {
		return 0, false, err
	}
	hdr.Name = name
	hdr.Method = zip.Deflate
	dst, err := zw.CreateHeader(hdr)
	if err != nil {
		return 0, false, err
	}
	n, err := io.Copy(dst, src)
	return int(n), false, err
}
