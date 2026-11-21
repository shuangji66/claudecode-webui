package gitctl

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"
)

// snapshotKey 把仓库快照压成一个短字符串：同一份界面数据必须得到同一个键。
//
// 用 ReadStatus 的完整输出（含两侧 numstat）而不是 `git status --porcelain`
// 的原文：porcelain 只有路径与 XY，一个已经标成 M 的文件被再改一次时它一个
// 字节都不变，面板会停在旧的 +/− 行数上——「源码变了但界面没动」正是要修的现象。
func snapshotKey(s Snapshot) string {
	raw, err := json.Marshal(s)
	if err != nil {
		// Snapshot 全是基础类型，序列化不会失败；真失败了就当「没变化」，
		// 不要让一个空键把每轮都变成一次推送。
		return ""
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:16])
}

// WatchSet 盯住一组仓库：任一仓库的快照发生变化时调用 notify(cwd)，直到 ctx 结束。
//
// `set` 每轮调用一次，返回**当前**要盯的仓库（可以随面板开关变化）。同一个连接上
// 两个 Git 面板各看一个仓库时，用**一个**监督协程顺序读取，而不是每个仓库一个协程：
// 后者在 NAS 上会同时起多条 git status（彼此抢 IO），而且退订一个仓库时容易把
// 另一个的协程状态搅乱。
//
// 每个仓库第一轮只建立基线、不推送（调用方刚拉过一遍状态）；退订的仓库从基线表里
// 清掉，重新订阅时重新建立基线。
func WatchSet(ctx context.Context, set func() []string, interval time.Duration, notify func(cwd string)) {
	if interval <= 0 {
		interval = 3 * time.Second
	}
	last := make(map[string]string)
	// dirty 记「这个仓库上一轮读失败了」：恢复后即使快照与失败前一致也要推一次——
	// 失败期间发生的改动我们没测到，静默丢掉等于「改完文件面板不动」。
	dirty := make(map[string]bool)
	for {
		if ctx.Err() != nil {
			return
		}
		repos := set()
		keep := make(map[string]struct{}, len(repos))
		for _, cwd := range repos {
			if cwd == "" {
				continue
			}
			if _, dup := keep[cwd]; dup {
				continue
			}
			keep[cwd] = struct{}{}
			snap, err := ReadStatus(ctx, cwd)
			if err != nil {
				// 读失败（git 缺失、超时、索引锁、权限抖动）时不推送：面板有自己的
				// 错误展示，这里推只会让前端再失败一次。基线**保留**并标记 dirty，
				// 恢复那一轮无条件推一次（见上）。
				dirty[cwd] = true
				continue
			}
			key := snapshotKey(snap)
			prev, seen := last[cwd]
			// 正常变化才推；另外「上一轮读失败过」无论如何补推一次（哪怕还没有基线：
			// 那段失败期里发生的变化我们没测到）。
			if dirty[cwd] || (seen && prev != key) {
				notify(cwd)
			}
			last[cwd] = key
			delete(dirty, cwd)
		}
		for cwd := range last {
			if _, held := keep[cwd]; !held {
				delete(last, cwd)
				delete(dirty, cwd)
			}
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
