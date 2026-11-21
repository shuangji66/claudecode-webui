//go:build linux

package history

import (
	"os"
	"syscall"
)

// fileIdentity 返回「同一路径下这份内容」的额外标识：inode + ctime（纳秒）。
//
// 缓存键里只有 mtime+size 时，有两种情况会命中旧条目：
//   - 保留 mtime 的整文件替换（`rsync -a` / `cp -p` / `tar -x -p` 从备份恢复同名转录，
//     NAS 上很常见的运维动作）；
//   - 秒级 mtime 粒度的文件系统上，同一秒内 `/rewind` 截断后重写到相同字节数。
//
// ctime（inode 变更时间）在这两种情况下都会变，而且**不能用 utimes 伪造**。
func fileIdentity(info os.FileInfo) (inode uint64, ctime int64) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0
	}
	return uint64(st.Ino), st.Ctim.Sec*1e9 + st.Ctim.Nsec
}
