//go:build !linux

package history

import "os"

// fileIdentity 在非 Linux 平台上退化成 0（只按 mtime+size 判）：
// 本项目只部署在 Linux（PTY、fpk 都依赖它），别的平台只要能编译。
func fileIdentity(info os.FileInfo) (inode uint64, ctime int64) {
	return 0, 0
}
