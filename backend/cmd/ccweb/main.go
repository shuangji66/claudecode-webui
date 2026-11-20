// Command ccweb 是 Claude Code 的可视化 Web 控制台服务端。
//
// 形态：单二进制（内嵌前端）。两条入口并存：unix socket 由前置网关按 baseurl
// 反代（本机可信入口，免密），直连 TCP 端口默认 3141、挂在根路径，可在设置页
// 改端口并开启访问密码。它自身不实现 agent 逻辑，而是常驻 claude 子进程并通过
// stream-json 协议转发。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"ccweb/backend/internal/agent/manager"
	"ccweb/backend/internal/agent/session"
	"ccweb/backend/internal/authz"
	"ccweb/backend/internal/claudebin"
	"ccweb/backend/internal/config"
	"ccweb/backend/internal/conversation"
	"ccweb/backend/internal/envpath"
	"ccweb/backend/internal/gateway"
	"ccweb/backend/internal/gitctl"
	"ccweb/backend/internal/history"
	"ccweb/backend/internal/hub"
	"ccweb/backend/internal/mcp"
	"ccweb/backend/internal/plugin"
	"ccweb/backend/internal/schedule"
	"ccweb/backend/internal/search"
	"ccweb/backend/internal/settings"
	"ccweb/backend/internal/skills"
	"ccweb/backend/internal/trimapi"
	"ccweb/backend/internal/workspace"
)

// version 由 -ldflags "-X main.version=..." 注入。
var version = "dev"

func main() {
	// 子命令：`ccweb mcp-web` 是内置 MCP 搜索服务（stdio JSON-RPC）。
	// 必须在装配 HTTP 服务之前拦下——它只读 stdin/stdout，不需要 socket、配置或日志。
	// 注意 stdout 是协议通道，这个分支里任何输出都必须走 stderr。
	if len(os.Args) > 1 && os.Args[1] == "mcp-web" {
		os.Exit(runMCPWeb())
	}
	// `ccweb mcp-schedule` 是自动化任务的模型入口（schema 与建/改逻辑都在子命令里）。
	if len(os.Args) > 1 && os.Args[1] == "mcp-schedule" {
		os.Exit(runMCPSchedule())
	}

	logger := log.New(os.Stdout, "[ccweb] ", log.LstdFlags)

	cfg := config.Load(version)

	// 启动器可能用空环境 exec（fnOS 的 fpk 脚本漏写 export PATH 时就是这样）：
	// 进程里没有 PATH，exec.LookPath 会直接失败，git 面板与内置终端全废。
	// 先补一个默认 PATH，再往下装配。
	if envpath.Apply() {
		logger.Printf("环境里没有 PATH，已回落到 %s", envpath.Default)
	}

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

	// 自动化任务：任务存在数据目录下的 schedules.json，调度循环随进程常驻。
	scheduleStore, err := schedule.Open(cfg.SchedulesFile)
	if err != nil {
		logger.Printf("启动失败: %v", err)
		os.Exit(1)
	}

	// claude 二进制只来自按版本下载到数据目录的托管版本，由设置页选择生效版本。
	claudeMgr, err := claudebin.Open(cfg.ClaudeVersions)
	if err != nil {
		logger.Printf("启动失败: %v", err)
		os.Exit(1)
	}
	resolveClaude := claudeMgr.BinPath

	// 代理设置要能覆盖三类出站：claude 子进程（manager 注入环境变量）、
	// 面板自己的 HTTP（拉模型/探测/下载 claude）、以及 spawn 出来的 git。
	// 后两者不会自动读设置，必须在装配层把取值函数接进去。
	proxyNow := func() string { return store.Get().ProxyURL }
	settings.SetProxySource(proxyNow)
	claudebin.SetProxySource(proxyNow)
	gitctl.SetProxySource(proxyNow)
	// MCP 探测与内置搜索都是面板自己发的出站请求，不会自动继承设置里的代理。
	mcp.SetProxySource(proxyNow)
	search.SetProxySource(proxyNow)
	// 插件的下载走 CLI 内部的 git：不接代理会直接克隆失败（实测 GnuTLS 报错）。
	plugin.SetProxySource(proxyNow)

	// MCP 配置：用户级是 claude 子进程 HOME 下的 .claude.json（不是宿主机的
	// ~/.claude.json），项目级按工作区现算；停用暂存放本应用自己的数据目录。
	// 先建出来再交给网关：上面的工具规则也要查同一份配置（「注册了没有」）。
	mcpMgr := mcp.New(
		filepath.Join(cfg.ClaudeHome, ".claude.json"),
		filepath.Join(cfg.DataDir, "mcp-disabled.json"),
	)

	// 插件与 marketplace：真源是 CLI 自己维护的状态文件，只能 spawn 它来读写。
	pluginMgr := plugin.New(resolveClaude, cfg.ClaudeHome)

	// 会话事件的唯一出口：先广播给这个会话的观察者，再把「回合结束 / 进程结束」
	// 转给网关——自动化任务投递的会话没人打开，只有网关知道那一条要刷新面板。
	// 网关在 manager 之后才建出来（它自己依赖 manager），所以用原子指针接一下。
	//
	// manager 同理用指针间接引用：它的构造要传这个闭包，而闭包里又要调它的 Rename。
	var mgrRef atomic.Pointer[manager.Manager]
	var srvRef atomic.Pointer[gateway.Server]
	mgr := manager.New(cfg, resolveClaude, store, func(sid string, ev session.Event) {
		h.Broadcast(sid, gateway.WireEvent{Kind: ev.Kind, SID: sid, Data: ev.Data, Seq: ev.Seq})
		srv := srvRef.Load()
		if srv == nil {
			return
		}
		switch ev.Kind {
		case session.KindSessionState:
			srv.NoteSessionState(sid, ev.Data)
		case session.KindClosed:
			srv.NoteSessionClosed(sid)
		case session.KindSessionReplaced:
			// CLI 换了会话 id（`/clear`）：把对话元数据迁到它实际在用的那个 id 上。
			// 不迁的话，重开这条对话会按旧 id `--resume`，把用户刚刚清掉的上下文
			// 又读回来。这里只动 conversations.json —— 转录本来就已经写在新 id 下了。
			//
			// manager 的键也要跟着换（只换键、不动进程）：不然列表里那条会显示
			// `live:false`，后续 prompt 还会打到旧 id 上。
			if from, to := sessionReplacedIDs(ev.Data); from != "" {
				if m := mgrRef.Load(); m != nil {
					m.Rename(from, to)
				}
				// 已经连着的页面订阅的是旧 topic，不搬就再也收不到事件。
				h.Rekey(from, to)
			}
			var notify func()
			if srv != nil {
				notify = srv.BroadcastConversationsChanged
			}
			migrateConversationID(convStore, notify, ev.Data, logger)
		}
	})
	mgrRef.Store(mgr)
	defer mgr.CloseAll()

	// 内置搜索的会话规则：只有「用户启用了搜索」且「这条 MCP 服务真的注册了」才生效。
	// 否则会把内置 WebSearch/WebFetch 挡掉却换不上任何搜索工具——比原来更糟。
	mgr.SetToolRules(func() (allow, deny []string) {
		payload, err := mcpMgr.List("")
		if err != nil {
			return nil, nil
		}
		for _, srv := range payload.User {
			switch srv.Name {
			case gateway.SearchMCPServer:
				// 只有用户真的启用了搜索才放行、才禁内置的两个：否则会把
				// WebSearch/WebFetch 挡掉却换不上任何东西。
				if store.Get().SearchEnabled {
					a, d := gateway.SearchToolRules()
					allow = append(allow, a...)
					deny = append(deny, d...)
				}
			case gateway.ScheduleMCPServer:
				// 自动化任务的三个工具：注册了才放行（同样是为了不每建一条弹一次审批）。
				allow = append(allow, gateway.ScheduleToolRules()...)
			}
		}
		return allow, deny
	})

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
		Schedules:     scheduleStore,
		// 个人技能挂在 claude 子进程的 HOME 下：process.CleanEnv 会把 HOME 改成
		// CCWEB_CLAUDE_HOME，所以这里不能用自己的 ~/.claude/skills。
		Skills:  skills.New(filepath.Join(cfg.ClaudeHome, ".claude", "skills")),
		Mcp:     mcpMgr,
		Plugins: pluginMgr,
		// 飞牛「已授权目录」只能由服务端经 apiscope socket 查/删；
		// token 由飞牛在启动 cmd/main 时注入，这里传函数每次现读。
		Dirs: trimapi.New(cfg.TrimSocket, cfg.TrimAppName, cfg.TrimToken),
		// 应用自己的安装目录 / 数据目录不许撤销授权：授权一撤，运行中的进程连
		// 自己的二进制都读不到（安装包固有目录，界面里也不给撤销按钮）。
		DirsProtected: gateway.ProtectedDirs(cfg.DataDir, cfg.ClaudeHome),
		Claude:        claudeMgr,
		ProjectsRoot:  cfg.ProjectsRoot,
		ClaudeVersion: probeClaudeVersion(mgr.Binary()),
		TerminalShell: cfg.TerminalShell,
		StartedAt:     time.Now(),
	}, logger)
	srvRef.Store(srv)

	// 自动化任务的模型入口：注册成用户级 MCP 服务（幂等，配置没变就不动 .claude.json）。
	// 失败只记日志：注册不上不影响面板自己用，最多是模型看不到那几个工具。
	if err := srv.EnsureScheduleMCP(); err != nil {
		logger.Printf("注册自动化任务 MCP 失败: %v", err)
	}

	// 自动化任务的调度循环：到期投递由 gateway 实现（它才有 manager / 对话元数据 /
	// 工作区围栏）。启动时先跑一次，补投停机期间到期的一次性任务。
	scheduleRunner := schedule.NewRunner(scheduleStore, srv.DeliverScheduledTask, logger)
	srv.SetScheduleRunner(scheduleRunner)

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
			// 只预热真的有转录的对话：元数据可能留着一份没有 jsonl 的条目
			// （历史上 resume 时会 touch，见「空对话不要落元数据」），拿它去
			// --resume 只会让 CLI 退出，还白起一个进程。
			if rec, ok := convStore.LastFor(cwd); ok && history.TranscriptExists(historyDir, rec.ID) {
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

	// 后台定时检查 claude 新版本：启动即查一次，之后每小时一次；有新版时
	// 通过系统通道推给打开的面板（侧栏点亮更新提示）。
	watchCtx, stopWatch := context.WithCancel(context.Background())
	defer stopWatch()
	startClaudeUpdateWatch(watchCtx, claudeMgr, srv, claudeUpdateInterval, logger)

	go scheduleRunner.Start(watchCtx)

	// 收到 TERM/INT 时优雅退出：关掉全部子进程，避免 claude 变孤儿。
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-stop
		stopWatch()
		mgr.CloseAll()
		os.Exit(0)
	}()

	if err := srv.ListenAndServe(); err != nil {
		logger.Printf("服务退出: %v", err)
		os.Exit(1)
	}
}

// sessionReplacedIDs 解析 `session.replaced` 的 `{from, to}`。
func sessionReplacedIDs(data json.RawMessage) (string, string) {
	var ev struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := json.Unmarshal(data, &ev); err != nil {
		return "", ""
	}
	if ev.From == "" || ev.To == "" || ev.From == ev.To {
		return "", ""
	}
	return ev.From, ev.To
}

// migrateConversationID 把对话元数据从 CLI 的旧会话 id 迁到新 id（`/clear` 之后）。
//
// **为什么必须迁**：`/clear` 让 claude 新开一份转录，后续轮次全写在新 id 下，旧转录
// 停在 clear 之前。我们若继续按旧 id 记录对话，进程被回收后重新 `--resume 旧 id`
// 会把用户**自己刚刚清掉**的上下文读回来——「清空」这个动作在重开之后失效了。
//
// **只迁应用自己的元数据，不动转录**：转录本来就已经在新 id 下，复制或改名都会造出
// 两份历史。这也让「id 必须稳定」那条约定在实现上仍然成立——变的不是我们造的 id，
// 而是跟着 claude 实际在用的那个走（见 conversation.Rekey 的注释）。
//
// 失败只记日志：迁移不上最多是重开对话时回到清空前的内容，不值得打断正在跑的会话。
func migrateConversationID(conv *conversation.Store, notify func(), data json.RawMessage, logger *log.Logger) {
	if conv == nil {
		return
	}
	var ev struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := json.Unmarshal(data, &ev); err != nil || ev.From == "" || ev.To == "" || ev.From == ev.To {
		return
	}
	if err := conv.Rekey(ev.From, ev.To); err != nil {
		// ErrNotFound 是常态：这条对话可能压根没登记过元数据（还没发过消息）。
		// 其余情况（目标 id 已被占用）说明新 id 上已经有一条独立对话，也不该覆盖。
		if !errors.Is(err, conversation.ErrNotFound) {
			logger.Printf("迁移对话 id 失败（%s → %s）: %v", ev.From, ev.To, err)
		}
		return
	}
	// 列表里那条对话的 id 变了：推一条让各端重拉，否则侧栏还挂着旧 id，
	// 点进去会去 resume 一份用户已经清空的转录。
	if notify != nil {
		notify()
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
	if bin == "" {
		return ""
	}
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
