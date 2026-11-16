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
	"strings"
	"syscall"
	"time"

	"ccweb/backend/internal/agent/manager"
	"ccweb/backend/internal/agent/session"
	"ccweb/backend/internal/authz"
	"ccweb/backend/internal/config"
	"ccweb/backend/internal/conversation"
	"ccweb/backend/internal/gateway"
	"ccweb/backend/internal/history"
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

	// 对话元数据：归档/删除/重命名/最近活跃。转录本身由 claude 写盘。
	convStore, err := conversation.Open(cfg.ConversationsFile)
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

	historyDir := filepath.Join(cfg.ClaudeHome, ".claude", "projects")
	srv := gateway.New(gateway.Deps{
		Cfg:           cfg,
		Guard:         authz.New(cfg.AuthToken),
		Hub:           h,
		Manager:       mgr,
		HistoryDir:    historyDir,
		Settings:      store,
		Workspaces:    wsStore,
		Conversations: convStore,
		ProjectsRoot:  cfg.ProjectsRoot,
		ClaudeVersion: probeClaudeVersion(mgr.Binary()),
		TerminalShell: cfg.TerminalShell,
		StartedAt:     time.Now(),
	}, logger)

	// APP 启动预热：恢复当前工作区最近的一条对话，而不是新建一条空对话。
	// 前端仍会按自己保存的 active id 选择；这里只是让首屏更快，manager.Resume
	// 对同一 id 会直接复用已存在的进程。
	if cfg.AutoStart {
		go func() {
			cwd := wsStore.AutoStartPath()
			if cwd == "" {
				return
			}
			id, resumeCwd := "", ""
			if rec, ok := convStore.LastFor(cwd); ok {
				id = rec.ID
				resumeCwd = rec.Cwd
			} else if latest, ok := latestTranscript(historyDir, cwd, func(id string) bool {
				rec, exists := convStore.Get(id)
				return exists && (rec.Deleted || rec.Archived)
			}); ok {
				// 首次升级：把 claude 已有的转录收养进对话列表。
				if err := convStore.Ensure(conversation.Record{
					ID: latest.ID, Cwd: latest.Cwd, Title: latest.Title,
					CreatedAt: latest.UpdatedAt, LastActive: latest.UpdatedAt,
				}); err != nil {
					logger.Printf("收养历史对话失败（%s）: %v", latest.ID, err)
					return
				}
				id = latest.ID
				resumeCwd = latest.Cwd
			}
			if id == "" || resumeCwd == "" {
				return
			}
			if _, err := mgr.Resume(id, resumeCwd, "", ""); err != nil {
				logger.Printf("恢复对话失败（%s）: %v", id, err)
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

// latestTranscript 返回 cwd 下最近更新的 claude 转录；用于把旧版本留下的
// 历史对话一次性收养进 conversation 元数据。
func latestTranscript(projectsDir, cwd string, skip func(string) bool) (history.Session, bool) {
	list, err := history.List(projectsDir)
	if err != nil {
		return history.Session{}, false
	}
	for _, h := range list {
		if h.Cwd != cwd && !strings.HasPrefix(h.Cwd, strings.TrimRight(cwd, "/")+"/") {
			continue
		}
		if skip != nil && skip(h.ID) {
			continue
		}
		return h, true
	}
	return history.Session{}, false
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
