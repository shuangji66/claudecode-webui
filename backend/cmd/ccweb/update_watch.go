package main

import (
	"context"
	"log"
	"time"

	"ccweb/backend/internal/claudebin"
)

// claudeUpdateInterval 是后台检查新版本的间隔。
const claudeUpdateInterval = time.Hour

// claudeUpdateCheckTimeout 限制一次 registry 查询：国内镜像通常几秒，
// 但拉的是 600KB packument，卡住的连接不能把 tick 占死。
const claudeUpdateCheckTimeout = 30 * time.Second

// updateChecker 只暴露「查一次 registry」；网关不参与定时策略，测试也不碰网络。
type updateChecker interface {
	Check(ctx context.Context) (claudebin.CheckResult, error)
}

// updateNotifier 是推送出口（网关的系统通道广播）。
type updateNotifier interface {
	BroadcastClaudeUpdate()
}

// startClaudeUpdateWatch 启动后台检查：启动即查一次，之后每 interval 一次。
//
// 检查走面板里选中的下载源（claudebin.Check 内部按 source 取 registry），
// 与「设置 → 部署 → 检查更新」完全等价，只是不需要人工触发。有新版时由
// notify 推给系统通道，前端据此刷新状态并点亮侧栏的更新提示。
//
// 失败只记日志、不推送：内网/离线是常态，一次探测失败不该变成界面上的红条。
func startClaudeUpdateWatch(ctx context.Context, check updateChecker, notify updateNotifier, interval time.Duration, logger *log.Logger) {
	run := func() {
		cctx, cancel := context.WithTimeout(ctx, claudeUpdateCheckTimeout)
		defer cancel()
		if _, err := check.Check(cctx); err != nil {
			// 退出时 ctx 被取消会让在途请求报 context canceled，那不是故障。
			if ctx.Err() == nil {
				logger.Printf("检查 claude 更新失败: %v", err)
			}
			return
		}
		notify.BroadcastClaudeUpdate()
	}
	go func() {
		// 启动即查：面板首屏就该知道有没有新版，不必等第一个 tick。
		run()
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				run()
			}
		}
	}()
}
