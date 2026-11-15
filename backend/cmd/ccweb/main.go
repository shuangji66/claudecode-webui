// Command ccweb 是 Claude Code 的可视化 Web 控制台服务端。
//
// 形态：单二进制（内嵌前端），只监听 unix socket，由前置网关按 baseurl 反代。
// 它自身不实现 agent 逻辑，而是常驻 claude 子进程并通过 stream-json 协议转发。
package main

import (
	"context"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"ccweb/backend/internal/agent/manager"
	"ccweb/backend/internal/agent/session"
	"ccweb/backend/internal/authz"
	"ccweb/backend/internal/config"
	"ccweb/backend/internal/gateway"
	"ccweb/backend/internal/hub"
	"ccweb/backend/internal/settings"
	"ccweb/backend/internal/workspace"
)

// version 由 -ldflags "-X main.version=..." 注入。
var version = "dev"

func main() {
	logger := log.New(os.Stdout, "[ccweb] ", log.LstdFlags)

	cfg := config.Load(version)
	exePath, _ := os.Executable()

	h := hub.New()

	// 持久化配置：第三方端点 / 密钥 / 默认模型。文件落在 CCWEB_DATA_DIR 下。
	store, err := settings.Open(cfg.SettingsFile)
	if err != nil {
		logger.Printf("启动失败: %v", err)
		os.Exit(1)
	}

	// 授权目录 + 当前工作区：首次启动把 CCWEB_PROJECTS_ROOT 作为默认工作区。
	wsStore, err := workspace.Open(cfg.WorkspacesFile, cfg.ProjectsRoot)
	if err != nil {
		logger.Printf("启动失败: %v", err)
		os.Exit(1)
	}

	mgr, err := manager.New(cfg, exePath, store, func(sid string, ev session.Event) {
		h.Broadcast(sid, gateway.WireEvent{Kind: ev.Kind, SID: sid, Data: ev.Data})
	})
	if err != nil {
		logger.Printf("启动失败: %v", err)
		os.Exit(1)
	}
	defer mgr.CloseAll()

	srv := gateway.New(gateway.Deps{
		Cfg:           cfg,
		Guard:         authz.New(cfg.AuthToken),
		Hub:           h,
		Manager:       mgr,
		HistoryDir:    filepath.Join(cfg.ClaudeHome, ".claude", "projects"),
		Settings:      store,
		Workspaces:    wsStore,
		ProjectsRoot:  cfg.ProjectsRoot,
		ClaudeVersion: probeClaudeVersion(mgr.Binary()),
		StartedAt:     time.Now(),
	}, logger)

	// APP 启动即拉起 claude：异步执行，握手慢不能拖住 socket 监听。
	// 前端如果先连上，会再调一次 /api/session/ensure，manager 内部串行化去重。
	if cfg.AutoStart {
		go func() {
			cwd := wsStore.AutoStartPath()
			if cwd == "" {
				return
			}
			if _, err := mgr.Ensure(cwd, "", ""); err != nil {
				logger.Printf("自动启动会话失败（%s）: %v", cwd, err)
				return
			}
			wsStore.Touch(cwd)
		}()
	}

	// 收到 TERM/INT 时优雅退出：关掉全部子进程，避免 claude 变孤儿。
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-stop
		mgr.CloseAll()
		os.Exit(0)
	}()

	if err := srv.ListenAndServe(); err != nil {
		logger.Printf("服务退出: %v", err)
		os.Exit(1)
	}
}

// probeClaudeVersion 取一次 `claude --version` 用于 /api/info 展示；失败不阻塞启动。
func probeClaudeVersion(bin string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "--version").Output()
	if err != nil {
		return ""
	}
	return trimNewline(string(out))
}

func trimNewline(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}
