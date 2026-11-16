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
- 右侧栏（桌面停靠 / 移动端全屏）是标签页：文件、Git、以及每个终端各占一个标签，
  `+` 打开新标签（Git 面板支持工作区内多仓库切换；终端是真正跑在 Linux PTY 上的 bash，
  `xterm.js` 只做渲染）；
- **授权目录 = 工作区**，持久化在 `workspaces.json`；对话列表来自 claude 转录 +
  `conversations.json` 元数据，启动时恢复上次对话（`--resume`）而不是新建；
- 设置页分「通用 / 模型 / 技能 / 代理 / 部署」：默认权限（置顶）、主题、语言、字号、技能、代理、
  每个模型的推理强度/图片能力/上下文窗口/最大输出，以及 claude 版本的下载源/安装/切换；
- 输入框 `+` 是添加菜单（对齐 DSH）：本地文件/图片、从飞牛选择、以及 claude 的 `/` 指令；
  附件随 prompt 发送。模型与推理等级是 DSH 风格的两级菜单（按提供商分组，不显示图片标记）；
- 左侧栏品牌图标使用 `frontend/src/assets/claude-code.svg`；前端不允许呼吸灯/无限 pulse 动画。

部署约定：**只部署 `ccweb` 本身**。`claude` 不随包分发、也不回退 PATH、也不接受环境变量覆盖：
只能由「设置 → 部署」从 npm 平台包按版本下载到
`CCWEB_DATA_DIR/claude/versions/<版本>/claude`，面板里切换生效版本。

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

对话：gateway ── conversation（conversations.json）
              ── history（claude jsonl 摘要 + transcript 回放）
              ── manager.Resume（--resume <uuid>）
```

分层职责（**不要跨层调用**）：

| 层 | 可以依赖 | 禁止 |
|---|---|---|
| `gateway` | manager 接口、history、project、workspace、authz、hub、fsapi、gitctl、terminal | 直接操作 `exec.Cmd`、直接读 claude 输出 |
| `fsapi` | 标准库 | HTTP / 鉴权（由 gateway 负责） |
| `gitctl` | 标准库、系统 `git` | shell 拼接、HTTP |
| `terminal` | 标准库、Linux PTY ioctl | HTTP / WS 帧（由 gateway 负责） |
| `conversation` | 标准库 | claude 转录解析（由 history 负责） |
| `agent/manager` | `agent/session`、`agent/process`、config、settings | 处理 HTTP / WS |
| `agent/session` | `agent/protocol` | 知道文件系统布局、知道前端协议 |
| `agent/process` | 标准库 | 启动会话、解析 NDJSON |
| `claudebin` | 标准库 | 启动 claude、决定会话参数 |
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
12. **恢复对话用 `manager.Resume`**（同一 id 去重），不要用 `Ensure`/`Create` 造新会话；
    `Ensure` 只保留给旧客户端按目录兜底。后端预热与前端同时恢复时必须靠 createMu 去重。
13. **右侧栏的所有路径都必须过授权**。`/api/fs/*`、`/api/git/*`、`/ws/terminal` 都先校验
    `cwd` 在授权目录内；相对路径解析符号链接后仍要留在工作区内。原始字节预览只放行
    图片/PDF 白名单，并带 `CSP: sandbox`——不要让工作区的 HTML/SVG 以同源页面执行脚本。
14. **Git 只调 CLI、不经 shell**。路径参数前加 `--literal-pathspecs`，rev/hash/分支前加
    `--end-of-options`；提交沿用用户全局身份，禁止设置 `user.name/email`。
15. **claude 二进制只能来自托管版本**。不要加 PATH / 程序同目录 / 环境变量回退：
    NAS 上经常同时存在几份 claude，"跑的是哪个版本"必须能在界面上看到、且只能由面板切换。
16. **对话 id 必须稳定**。新建会话用 UUID 作为 `--session-id`，恢复用同一个 UUID `--resume`；
    `Info.ID`、转录文件名、`conversations.json`、前端 active id 必须是同一个值。
    不要用「按 cwd ensure 一个新的」来恢复旧对话——那会造出新对话、丢掉上下文。

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
- `go:embed all:embed` 要求目录存在；`embed/.gitkeep` 负责保留目录，
  `embed/index.html` 是构建产物、已在 `.gitignore` 里，`make clean` 直接删除。

### 4.4 对话持久化

- **`--resume` 不会回放历史**：claude 只把新回合写 stdout；界面历史必须靠
  `/api/history/transcript` 读 jsonl，再用前端 `applyCLI` 回放。别指望连上 WS 就有旧消息。
- **转录回放必须保留时间戳**：`applyCLI(items, msg, at)` 的第三参数用于历史行；
  不传则用 `Date.now()`，会让所有旧消息显示成“刚刚”。
- **空对话不要落元数据**：新建后还没首条消息时，后端只在 manager 列表里展示；
  首条 prompt 成功才 `conversation.Touch`。否则后端重启后会出现无法 `--resume` 的幽灵条目。
- **删除是软删除**：`conversation.Delete` 写 `deleted` 墓碑并保留 jsonl；列表/自动恢复都要
  跳过 deleted/archived。不要把「删除」实现成直接 `os.Remove` 转录。
- **自动预热不是新建**：`CCWEB_AUTO_START` 只恢复 `LastFor` 或最近转录；没有对话就什么都不做，
  由前端创建第一条。改回 `mgr.Ensure` 会让每次重启多一条空对话。
- **claude 转录会包含 sidechain / meta / queue-operation 行**：回放只取
  user/assistant/system/result 且跳过 `isSidechain`/`isMeta`，否则子代理和系统提醒会混进主消息流。

### 4.5 右侧栏 / 终端

- **PTY 没有第三方依赖**：Linux 上直接开 `/dev/ptmx` + `TIOCSPTLCK/TIOCGPTN/TIOCSWINSZ`。
  在 agent 沙箱里跑测试会 `permission denied`（设备访问被拦），这是环境限制，不是代码错；
  完整权限下 `TestSessionEcho` 会真正跑通。
- **终端 WS 输出必须走二进制帧**：PTY 的 ANSI 序列与半截 UTF-8 不能塞进 JSON 字符串，
  否则会被替换字符破坏；上行命令才是 JSON 文本。
- **服务端先发 `error`/`exit` 再关连接时，前端不能把状态覆盖成 `closed`**：`TerminalConnection`
  记住最后一次状态，保留真正的失败原因。
- **右侧栏是「开始页 + 标签页」**（对齐 DSH）：没开标签时是开始页（工作区文件 / Git /
  新建终端三张卡片，两列网格），**不要自动开「文件」标签**；点卡片或 `+` 才开标签。
  顶部一排标签，文件 / Git 各是单例（已开就切过去），
  终端**每个会话各占一个标签**（`bash`、`bash 2`…），`+` 菜单开新标签，标签自带 × 关闭。
  **标签切走只隐藏、不卸载**——终端里挂着 PTY，卸载等于杀 shell；关掉标签或关掉整个
  右侧栏才 SIGHUP。不要改回「启动页 + 返回按钮」那种切换。
- **终端可多开**：每个终端一条 WS、一个 PTY；后端上限 8（`maxTerminals`），
  换工作区时全部结束（旧 shell 的 cwd 已经不成立）。
- **Git 支持工作区内的多个仓库**：`GET /api/git/repos` 扫描（深度 3、跳过隐藏目录与
  `node_modules`、命中仓库不再下钻），前端把选中的仓库绝对路径直接当 `/api/git/*` 的
  `cwd`（子目录本来就能过 `authorizedCwd`，不必为它加新参数）。
- **Git 只拉不推**：`POST /api/git/pull` 只做 `pull --ff-only`（`gitctl.Push` 已删除）。
  推送是对外动作，不该由侧栏一个图标顺手完成；需要时用户自己开终端 `git push`。
- **Git 状态用 `--porcelain=v2 -z`**，并用 `--untracked-files=all` 列出未跟踪文件
  （`normal` 只给目录，点开无法 diff）。解析按 NUL 字段走，不能按空格 split，
  否则带空格的路径会被截断。

### 4.6 工作区目录的 ACL（飞牛）

- **能浏览 ≠ 能读写**。应用以独立应用用户（如 `ClaudeCode`）运行，`/vol1/@appshare` 这类
  祖先目录是 mode 000，只靠 `trim_acl` 授予穿越。用户在目录选择器里看到的目录，是应用
  用户已经有权列出的；但把**新目录**加为工作区后，claude 子进程仍然会被拒。
- **授权只能在前端做**。飞牛后端 API（`trim.file.getUserAccessibleFolders` /
  `delUserAccessibleFolder`，见 `POST /api/v1/trimapp`，unix socket
  `/var/run/trim_open_gateway_apiscope.socket`）只能查/删，不能授予；授予必须走
  需要用户确认的 `authorizeUserFile(path)`（`@trimjs/web-app` 宿主桥接）。
- **能写就不申请**：`WorkspaceDialog` 提交前先 `POST /api/fs/access`（`project.CheckWritable`，
  真落一个临时文件再删掉，才认得出 `trim_acl`、只读挂载、不可变标志）。writable=true
  直接 `POST /api/workspaces`——应用自己的数据目录、已授权过的共享、刚建的空文件夹都属于
  这种，再弹一次飞牛确认页是纯噪音。只有写不进去才 `authorizeFnosDir(path)`：用户取消或
  宿主报错就不登记目录。拿不到宿主（直连端口 / `make dev`）才降级放行。
- **握手要趁早**：宿主只在 iframe 挂载后 60 秒内应答 postMessage 握手，`main.tsx` 里
  `primeFnosSdk()` 必须在入口发起；超时后 SDK 会退化成永不 settle 的连接（按钮点了没反应）。
- 不做版本分流：dsh 那边按飞牛 App 版本切网页授权页，本应用只跑微应用 iframe，不适用。
- 「选择飞牛目录」（`pickUserFile`）本身就是授权入口：挑完只在弹窗里**进入该目录**，
  不自动登记、不关弹窗、不进新对话；用户点「添加」时探测已通过，不会再弹一次确认框。
- 「新建文件夹」走 `POST /api/fs/mkdir`：只接受**单层目录名**，带分隔符/`.`/`..` 一律 400；
  它是宿主写操作，和浏览接口一样必须挂 `s.authed`。
- 「重命名工作区」走 `POST /api/workspaces/rename`，**只改显示名**，绝不 `os.Rename` 真目录
  （路径是授权键：会话 cwd、workspaces.json、前端当前工作区都按它匹配）。

### 4.6.1 「从飞牛选择」的文件

- 宿主桥接只给**路径**（`pickUserFile` 返回 `string[]`），没有读文件 API。所以图片/PDF
  由后端 `POST /api/fs/host-file` 读成附件，其余类型只把路径写进消息，由 claude 用 Read
  工具自己读。
- **`/api/fs/host-file` 是唯一不受工作区围栏约束的读文件接口**（选择器挑的文件本来就在
  工作区外）。边界：只放行图片/PDF（扩展名初筛 + `http.DetectContentType` 复核，改名的
  HTML/SVG 会被拒）、必须是普通文件、≤ 8MB、必须挂 `s.authed`。不要在这条路上加
  「顺手读个文本文件」——那等于给前端开了任意宿主文件读取。

### 4.7 前端侧

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
- **唯一允许的循环动画**是侧栏对话「进行中」的进度环（`common/StateDot` 的 `ongoing`，
  1.5s 匀速旋转，对齐 DSH），且 `prefers-reduced-motion` 下必须静止；呼吸灯/pulse 仍然禁止。
- **输入框下方的用量行**（轮数 / 工具数 / tok/s / 上下文%）全部来自 claude CLI 的
  `usage` 与 `modelUsage.contextWindow`（见 `lib/usage.ts`）；CLI 没有「步骤数」与
  「实时 tok/s」，对应显示的是换算值，不要把它说成官方指标，也不要为此去猜。
- 移动端输入框下方必须保留 `env(safe-area-inset-bottom)`，否则 iPhone Home Indicator 会盖住输入区。
- 界面文案走 `useT()`（中文 / English 两参数），默认中文；新增文案不要再硬编码单语。
- **UI 原语入库，不要重复造**：模态 `common/Dialog`、确认/输入 `common/SystemDialogs`
  （`askConfirm`/`askPrompt`）、下拉 `common/Select`、菜单 `common/Menu`、按钮 `common/Button`。
  原生 `window.confirm/prompt/alert` 与 `<select>` 一律不用：它们的配色/圆角/字号由系统决定，
  在飞牛桌面 iframe 里和主题对不上。

### 4.8 claude 版本管理（`internal/claudebin`）

- **数据源是 npm 平台包**，不是 `downloads.claude.ai/claude.zst`：平台包
  `@anthropic-ai/claude-code-<platform>` 与官方二进制逐字节相同，且国内镜像实测
  ~11 MB/s（官方 CDN 只有 IPv6 通）。可选 npmmirror / 腾讯云 / 华为云 / 官方；
  x64 与 arm64（含 musl）都按 `platformFor` 映射到对应包。Go 标准库能解 gzip+tar，不用引 zstd。
- **镜像可能返回相对 tarball 地址**（华为云是 `/@scope/pkg/-/pkg.tgz`）：按当前源的
  路径前缀补成绝对 URL，否则请求会报 unsupported protocol scheme 或丢掉 `/repository/npm`。
- **必须按 `dist.integrity` 校验 sha512 再落盘**：镜像被换包时要直接失败，不能装上来路不明的二进制。
- **装完先跑一次 `--version`**：musl/glibc 选错包、文件被截断都在这里暴露，而不是等到会话起不来。
- **解包与下载同一遍流式完成**：先存 tgz 再解开会在 NAS 上多占 170 MB。
- **已生效版本不被静默顶掉**：装旧版本用于回滚对比是常见操作，只有原本没有生效版本时才自动启用。
- **删除版本**：只能删已安装且未生效的版本；网关还会用 `Manager.InUse` 拦住仍被
  运行中会话使用的版本（切换版本只影响新会话，旧进程可能还在用旧二进制）。
- **切换只影响之后新建的会话**：`manager.resolve` 每次建会话重新解析路径，已在跑的进程不重启。
- **未安装时服务必须能起来**：否则用户没有入口去装。`manager.New` 不再因找不到 claude 失败，
  建会话时才返回「请去设置 → 部署安装」。
- **`/api/info` 只在装配了部署管理时才带 `claude_installed`**：前端据此区分"确实没装"与
  "这套部署不走托管安装"，否则会弹一个装不了东西的提示。

### 4.9 技能管理（`internal/skills`）

- **个人技能目录必须跟着 claude 的 HOME 走**：`process.CleanEnv` 把子进程 HOME 改成
  `CCWEB_CLAUDE_HOME`，所以个人技能是 `$CCWEB_CLAUDE_HOME/.claude/skills`，不是应用自己的
  `~/.claude/skills`。写错位置会「保存成功但 claude 永远看不到」。
- **只写 personal / project 两类**：它们就是文件，改完 claude 会热加载，不用重启会话。
  `synced/`（claude.ai 同步）只读——下次同步会覆盖；插件技能归 `claude plugin`；
  bundled 技能只能靠 settings 的 `disableBundledSkills` / `skillOverrides`。
- **写入必须拒绝符号链接目录**：项目技能在工作区里，软链可以把写操作带到工作区外。
  先 `Lstat` 判软链，再 `MkdirAll`；落盘用同目录临时文件 + rename，避免半截 SKILL.md
  被 claude 当成正文读进去。
- **删除只删 skills 根目录的直接子目录且必须含 SKILL.md**：名字来自用户输入，
  直接 `RemoveAll(root/name)` 等于把路径穿越变成删库。
- 技能名同时是 `/命令名`：不允许分隔符、点开头、`<`/`>`、控制字符与零宽字符，
  `synced` 是保留名（与 claude 的加载规则一致）。
- 新建一个此前不存在的顶级 `.claude/skills` 目录时，claude 没在监听它，
  需要 `/reload-skills` 才生效（已有目录内的增删改是热加载的）。

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
- [ ] 对话恢复是否用稳定 UUID `--resume`？空对话/归档/删除是否会被误恢复？
- [ ] 转录回放是否过滤 sidechain/meta，并保留原始时间戳？
- [ ] 新增右侧栏路由是否过了 `authorizedCwd` / 路径围栏？raw 预览是否仍在白名单？
- [ ] 右侧栏标签切走是否只隐藏不卸载（终端 PTY 不能被切标签杀掉）？Git 是否仍只 pull？
- [ ] 终端是否仍走二进制帧、多开时每个标签各自一条 WS？
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
