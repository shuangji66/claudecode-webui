# AGENTS.md — 项目总览

本文件面向参与开发的 agent / 人类协作者：项目结构、不可破坏的约定、以及踩过的坑。
子目录各有一份更细的规范：`backend/AGENTS.md`、`frontend/AGENTS.md`。

---

## 1. 这是什么

把本地 `claude` CLI 包装成可视化 Web 控制台：

- **单 Go 二进制**，前端产物用 `go:embed` 打进去；
- **只监听 unix socket**，由前置网关注入 baseurl 前缀反代（不监听 TCP）；
- 后端**常驻 claude 子进程**，通过 `--input-format stream-json --output-format stream-json`
  双向 NDJSON 通信；
- 主对话区**不做终端模拟**，全部结构化渲染：消息流、thinking、工具卡片、diff、审批面板；
- 右侧栏（桌面停靠 / 移动端全屏）有工作区文件树与只读预览、Git 变更面板、以及真正跑在
  Linux PTY 上的 bash 终端（`xterm.js` 只做渲染）；
- **授权目录 = 工作区**，持久化在 `workspaces.json`；APP 启动自动在当前工作区拉起 claude；
- 设置页分「通用 / 模型 / 代理」：主题、语言、字号、默认权限、代理，以及每个模型的推理强度/图片能力；
- 输入框 `+` 支持文件/图片附件（图片/PDF/文本），随 prompt 发送；
- 左侧栏品牌图标使用 `frontend/src/assets/claude-code.svg`；前端不允许呼吸灯/无限 pulse 动画。

部署约定：`ccweb` 与 `claude` 放同一目录，`claude` 在 PATH 中，后端直接 exec `claude`。

## 2. 架构

```
浏览器 (React)
   │  WebSocket /ws?id=<session>
   ▼
gateway（unix socket）
   │  订阅/广播
   ▼
hub ── manager ── session ── process ── claude (NDJSON)
                                         │
                     history ← ~/.claude/projects/**/*.jsonl

右侧栏：gateway ── fsapi（文件树/预览）
                 ── gitctl（系统 git CLI）
                 ── terminal（PTY + /ws/terminal）
```

分层职责（**不要跨层调用**）：

| 层 | 可以依赖 | 禁止 |
|---|---|---|
| `gateway` | manager 接口、history、project、workspace、authz、hub、fsapi、gitctl、terminal | 直接操作 `exec.Cmd`、直接读 claude 输出 |
| `fsapi` | 标准库 | HTTP / 鉴权（由 gateway 负责） |
| `gitctl` | 标准库、系统 `git` | shell 拼接、HTTP |
| `terminal` | 标准库、Linux PTY ioctl | HTTP / WS 帧（由 gateway 负责） |
| `agent/manager` | `agent/session`、`agent/process`、config、settings | 处理 HTTP / WS |
| `agent/session` | `agent/protocol` | 知道文件系统布局、知道前端协议 |
| `agent/process` | 标准库 | 启动会话、解析 NDJSON |
| `agent/protocol` | 标准库 | I/O、状态机 |

`gateway` 对 manager 只依赖 `SessionManager` 接口（见 `gateway.go`），
这样网关可以在没有 claude 二进制的机器上跑单测。

## 3. 不可破坏的约定

1. **只监听 unix socket**。不要为了"方便"加 TCP 监听；需要远程访问就加网关。
2. **路径全部来自环境变量**（`CCWEB_*`）。禁止硬编码 `/tmp`、`/var/apps` 之类。
3. **baseurl 在运行期决定**。前端资源用相对路径，`index.html` 由后端注入 `<base href>`；
   前端任何请求必须走 `runtimeBase()` / `apiUrl()` / `wsUrl()`。
4. **`--permission-prompt-tool stdio` 不能删**（`process.Args`）。删了之后需要审批的工具
   会被 fail-closed 静默拒绝，前端永远收不到 `can_use_tool`。
5. **`initialize` 必须由客户端先发**，且要在进程启动后立刻发。顺序错了会死锁。
6. **控制响应不得阻塞读循环**。`session.handleLine` 里的写操作走 `writeLine`（带锁）。
7. **未实现的控制请求子类型必须回 `unsupported_request`**，不能让 CLI 干等。
8. **鉴权默认关闭但必须可用**。新增 HTTP 路由要挂 `s.authed`；WS 必须校验 token。
9. **日志只在异常/失败时输出**。不要加启动横幅、例行生命周期日志。
10. **不提交构建产物**：`bin/`、`frontend/dist/`、`embed/assets/`、`.gocache/` 等见 `.gitignore`。
11. **会话 cwd 必须在授权目录内**。`POST /api/session` / `/api/session/ensure` 都要过
    `workspace.Allows`；`CCWEB_PROJECTS_ROOT` 是默认授权目录，不是任意路径的通行证。
12. **自动拉起用 `manager.Ensure`**，不要直接 `Create`：后端启动与前端同时触发时必须去重。
13. **右侧栏的所有路径都必须过授权**。`/api/fs/*`、`/api/git/*`、`/ws/terminal` 都先校验
    `cwd` 在授权目录内；相对路径解析符号链接后仍要留在工作区内。原始字节预览只放行
    图片/PDF 白名单，并带 `CSP: sandbox`——不要让工作区的 HTML/SVG 以同源页面执行脚本。
14. **Git 只调 CLI、不经 shell**。路径参数前加 `--literal-pathspecs`，rev/hash/分支前加
    `--end-of-options`；提交沿用用户全局身份，禁止设置 `user.name/email`。

## 4. 踩过的坑（都已在代码里修好，别改回去）

### 4.1 协议时序

- **先发 `initialize` 才有输出。** 反过来等输出再发 initialize 会死锁到超时。
- **`request_id` 的位置不对称**：`control_request` 在顶层，`control_response` 在
  `response.request_id`。`protocol.Decode` 已处理，改解析逻辑时注意保持。
- **`stdin` 不能关。** 关闭等于结束会话；常驻会话必须用管道逐行写。

### 4.2 审批链路

- 不带 `--permission-prompt-tool stdio` → 无 `can_use_tool` 事件；
- 工作目录内的安全命令（如 `echo`）会被**自动放行**，拿它测审批会误判。用
  `rm -rf <工作目录外的路径>` 之类才会触发。
- 审批挂起期间进程和内存（约 176 MB）一直占着。长时间等人工的场景应改用
  PreToolUse hook 的 `defer`（会以 `tool_deferred` 退出，决策状态落库），
  当前版本尚未实现。

### 4.3 Go 侧

- `os.Pipe` 有内核缓冲，`net.Pipe` 没有 —— 测试里用 `net.Pipe` 很容易自锁。
- 环境变量重复时**后者生效**：`process.CleanEnv` 先剔除 `HOME`/`PWD` 再追加。
- **不能剔除 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`**：自定义中继是本项目的基础能力。
- `GOCACHE`/`GOMODCACHE` 用项目内目录（宿主缓存常不可写），Makefile 已设置。
- `go:embed all:embed` 要求目录存在；`embed/index.html` 是占位文件，构建会覆盖它，
  `make clean` 用 `git checkout` 还原。

### 4.4 右侧栏 / 终端

- **PTY 没有第三方依赖**：Linux 上直接开 `/dev/ptmx` + `TIOCSPTLCK/TIOCGPTN/TIOCSWINSZ`。
  在 agent 沙箱里跑测试会 `permission denied`（设备访问被拦），这是环境限制，不是代码错；
  完整权限下 `TestSessionEcho` 会真正跑通。
- **终端 WS 输出必须走二进制帧**：PTY 的 ANSI 序列与半截 UTF-8 不能塞进 JSON 字符串，
  否则会被替换字符破坏；上行命令才是 JSON 文本。
- **服务端先发 `error`/`exit` 再关连接时，前端不能把状态覆盖成 `closed`**：`TerminalConnection`
  记住最后一次状态，保留真正的失败原因。
- **切页签不能卸载终端**：`RightSidebar` 三个面板常驻、只切 `hidden`；终端首次激活才创建 PTY。
  关侧栏才 SIGHUP。改布局时不要把终端放回 `activeTab === "terminal" && ...` 条件里。
- **Git 状态用 `--porcelain=v2 -z`**，并用 `--untracked-files=all` 列出未跟踪文件
  （`normal` 只给目录，点开无法 diff）。解析按 NUL 字段走，不能按空格 split，
  否则带空格的路径会被截断。

### 4.5 前端侧

- `--include-partial-messages` 会**先给逐字增量、再给完整消息**。两套都追加会导致
  每句话显示两遍；`lib/normalize.ts` 的做法是「替换流式气泡」。
- 工具集会随 CLI 版本漂移（实测 2.1.325 的 API 请求只带 12 个工具，且有
  `ToolSearch` / `DeferredToolPlaceholder`）。**必须保留 `GenericCard` 兜底**，
  禁止硬编码工具清单。
- `Edit` 的 diff 优先取 `tool_use_result.structuredPatch`，没有才退回 `old_string/new_string`。
- 浏览器无法给 WebSocket 设自定义头，鉴权只能走 `?token=`。
- 主题用 `<html data-theme>` 切换，Tailwind 的 `dark:` 已绑定到该属性；不要再写
  `@media (prefers-color-scheme: dark)` 覆盖令牌。
- 强调色固定为陶土色 `#D97757`，用 `bg-brand/text-brand` 等语义类，不要写死 slate/blue。
- 移动端输入框下方必须保留 `env(safe-area-inset-bottom)`，否则 iPhone Home Indicator 会盖住输入区。
- 界面文案走 `useT()`（中文 / English 两参数），默认中文；新增文案不要再硬编码单语。

## 5. 命令速查

```bash
make dev                 # 开发构建 → bin/ccweb
make release V=1.0.0     # 发布构建（-s -w）
make test                # 后端 + 前端全部测试
make vet && make fmt
make clean

# 单独跑
cd backend && go test ./...        # 需要 GOCACHE 可写，Makefile 已处理
cd frontend && npx vitest run
cd frontend && npx tsc --noEmit
```

## 6. 修改前自查

- [ ] 是否新增了硬编码路径 / 端口 / 前缀？
- [ ] 新 HTTP 路由是否挂了鉴权？WS 是否校验 token？
- [ ] 改动 `protocol` 后是否同步了 `session` 与前端 `transport/types.ts`？
- [ ] 新增工具卡片是否注册进 `ToolCardHost`，且未删除兜底？
- [ ] 流式路径是否仍满足「替换而非追加」？
- [ ] 新增右侧栏路由是否过了 `authorizedCwd` / 路径围栏？raw 预览是否仍在白名单？
- [ ] 终端是否仍然常驻、PTY 输出走二进制帧、关侧栏才结束进程？
- [ ] 是否补了测试（纯函数优先，组件用 Testing Library）？
- [ ] `make test` 与 `npx tsc --noEmit` 是否都通过？

## 7. 与社区项目的关系

参考过 `sugyan/claude-code-webui`（MIT）与 `wbopan/cui`（Apache-2.0）的**设计意图**
（消息分类、工具卡片分级展示、审批面板层级）。两者都是 React 且已归档，
协议版本也停留在旧格式（`patterns: ["Bash(ls:*)"]`），因此**没有复用其代码**；
本项目的前端是 React 19 + TS + Tailwind v4 重新实现。

右侧栏的 Git 面板参考了 `omdsh-dev/DSH-better-sidebar`（**MIT**）的交互与命令安全规则，
`backend/internal/gitctl` 与 `frontend/src/lib/workspace.ts` 是基于其思路的 Go/TS 重写；
MIT 许可与版权声明见 `THIRD_PARTY_NOTICES.md`。内置终端使用 `@xterm/xterm`（MIT）做渲染，
PTY 由本项目用 Linux ioctl 自行实现。

`siteboon/claudecodeui` 是 **AGPL-3.0**，只可观察交互，**不得复制其代码或结构**。
