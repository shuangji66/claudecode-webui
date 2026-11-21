package gateway

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"time"

	"ccweb/backend/internal/gitctl"
	"ccweb/backend/internal/project"
)

// watchKey 是 Git 订阅的键：与 authorizedCwd 一样取 realpath（软链两侧必须同一个键），
// 但**不做授权检查**——退订不能因为「目录刚被撤销」而失败。
func watchKey(raw string) string {
	raw = strings.TrimSpace(raw)
	abs, err := project.Validate(raw)
	if err != nil {
		return raw
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		return real
	}
	return abs
}

// gitWatchInterval 是后端盯仓库的轮询间隔。
//
// 面板不再自己定时拉状态，所以这个值直接决定「改完文件多久能看到」。
// 3 秒对 NAS 上的中小仓库是几十毫秒的开销（一次 status + 两次 numstat），
// 比原来前端每 15 秒拉一遍完整快照还轻。变量而不是常量：测试要把它调小。
var gitWatchInterval = 3 * time.Second

// startGitWatch 让这条连接开始盯一个仓库；同一个仓库重复订阅只替换观察者，
// **其它仓库的观察者不受影响**（分栏后两栏可以各看一个仓库）。
//
// 为什么按连接订阅而不是全局按仓库共享：多标签页/多设备各自订阅自己的路径，
// 服务端多花一两次 git status 就能省掉「谁在看什么」的引用计数与清理——
// 连接一关 ctx 就取消，不会漏掉观察者。
func (s *Server) startGitWatch(c *wsClient, cwd, alias string) {
	// 已经有监督协程时只把仓库加进集合，下一轮就会读到它（第一轮建立基线）。
	if !c.addWatch(cwd, alias) {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	c.setWatchCancel(cancel)
	go gitctl.WatchSet(ctx, c.watchRepos, gitWatchInterval, func(changed string) {
		// 推送里回客户端订阅时用的那个写法（工作区是软链时 realpath 与它不同）。
		data, err := json.Marshal(map[string]string{"cwd": c.watchLabel(changed)})
		if err != nil {
			return
		}
		// 连接已关时 SendJSON 直接失败（它只入队），读循环那边会随之退出，这里不用管。
		_ = c.SendJSON(WireEvent{Kind: "git.changed", Data: data})
	})
}
