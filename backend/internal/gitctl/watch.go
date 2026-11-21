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
				// 读失败（git 缺失、超时、权限）时不推送：面板有自己的错误展示，
				// 这里推送也只会让前端再失败一次。下一轮恢复后照常比对。
				delete(last, cwd)
				continue
			}
			key := snapshotKey(snap)
			prev, seen := last[cwd]
			if seen && prev != key {
				notify(cwd)
			}
			last[cwd] = key
		}
		for cwd := range last {
			if _, held := keep[cwd]; !held {
				delete(last, cwd)
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

// Watch 盯住一个仓库：快照发生变化时调用 notify，直到 ctx 结束。
//
// 面板自己不再定时拉状态（原来前端每 15 秒拉一遍完整快照），轮询搬到这里：
// 每个标签页只花一次 push，而判断「变了没有」用的就是 ReadStatus 的完整输出，
// 与界面拿到的是同一份数据，不会出现「后端认为没变、界面却有差异」。
//
// 节奏是「读完一轮再等一个间隔」，不是固定 ticker：大仓库上 status 本身可能要
// 几百毫秒，ticker 会让请求叠加，串行循环天然限流。
func Watch(ctx context.Context, cwd string, interval time.Duration, notify func()) {
	if interval <= 0 {
		interval = 3 * time.Second
	}
	last := ""
	for {
		if ctx.Err() != nil {
			return
		}
		// 读失败（git 缺失、超时、权限）时不推送：面板有自己的错误展示，
		// 这里推送也只会让前端再失败一次。下一轮恢复后照常比对。
		if snap, err := ReadStatus(ctx, cwd); err == nil {
			key := snapshotKey(snap)
			// 第一轮只建立基线：调用方刚拉过一遍状态，不用立刻再推一次。
			if last != "" && key != last {
				notify()
			}
			last = key
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
