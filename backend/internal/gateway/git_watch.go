package gateway

import (
	"context"
	"encoding/json"
	"time"

	"ccweb/backend/internal/gitctl"
)

// gitWatchInterval 是后端盯仓库的轮询间隔。
//
// 面板不再自己定时拉状态，所以这个值直接决定「改完文件多久能看到」。
// 3 秒对 NAS 上的中小仓库是几十毫秒的开销（一次 status + 两次 numstat），
// 比原来前端每 15 秒拉一遍完整快照还轻。变量而不是常量：测试要把它调小。
var gitWatchInterval = 3 * time.Second

// startGitWatch 让这条连接开始盯一个仓库；之前盯的那个先停掉。
//
// 为什么按连接订阅而不是全局按仓库共享：同一时刻只有一个 Git 面板在看一个仓库，
// 多标签页/多设备各自订阅自己的路径，服务端多花一两次 git status 就能省掉
// 「谁在看什么」的引用计数与清理——连接一关 ctx 就取消，不会漏掉观察者。
func (s *Server) startGitWatch(c *wsClient, cwd string) {
	ctx, cancel := context.WithCancel(context.Background())
	c.setWatch(cancel)
	go gitctl.Watch(ctx, cwd, gitWatchInterval, func() {
		data, err := json.Marshal(map[string]string{"cwd": cwd})
		if err != nil {
			return
		}
		// 连接已关时 SendJSON 直接失败（它只入队），读循环那边会随之退出，这里不用管。
		_ = c.SendJSON(WireEvent{Kind: "git.changed", Data: data})
	})
}
