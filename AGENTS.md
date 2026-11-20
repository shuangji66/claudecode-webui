# AGENTS.md — 项目总览

本文件面向参与开发的 agent / 人类协作者：项目结构、不可破坏的约定、以及踩过的坑。
子目录各有一份更细的规范：`backend/AGENTS.md`、`frontend/AGENTS.md`。

---

## 1. 这是什么

把本地 `claude` CLI 包装成可视化 Web 控制台：

- **单 Go 二进制**，前端产物用 `go:embed` 打进去；
- **两条入口**：unix socket（前置网关注入 baseurl 前缀反代，本机可信）与直连 TCP 端口
  （默认**关闭**，开启后端口 3141、挂在根路径、不需要 baseurl，必须用访问密码登录）。
  开关/端口/密码在「设置 → 访问」里配，密码只存 PBKDF2 摘要；unix socket 入口不校验该密码；
- 后端**常驻 claude 子进程**，通过 `--input-format stream-json --output-format stream-json`
  双向 NDJSON 通信；
- 主对话区**不做终端模拟**，全部结构化渲染：消息流、thinking、工具卡片、diff、审批面板；
- 右侧栏（桌面停靠 / 移动端全屏）是标签页：文件、Git、以及每个终端各占一个标签，
  `+` 打开新标签（Git 面板支持工作区内多仓库切换；终端是真正跑在 Linux PTY 上的 bash，
  `xterm.js` 只做渲染）；
- **授权目录 = 工作区**，持久化在 `workspaces.json`；对话列表来自 claude 转录 +
  `conversations.json` 元数据，启动时恢复上次对话（`--resume`）而不是新建；
- 左侧栏的工作区行（对齐 DSH）**只有图标 + 名字**，不显示对话计数：平时是文件夹，
  收起与展开用**两张不同的文件夹图**（`IconFolder` / `IconFolderOpen`），悬停/聚焦时
  同一图标位换成展开方向箭头（触屏没有 hover，开没开着只能靠那两张图）；
  组里有当前对话时图标带主题色。一个工作区的会话超过 5 条只露最近更新的那 5 条，
  其余折成一行「展开其余 N 个会话」（`sidebarView.SESSION_GROUP_LIMIT`，收起工作区时
  复位；搜索时全露）。折叠的是**排好序之后的尾部**，所以「最近更新」在收起状态下也成立；
- 设置页分「通用 / 模型 / 目录 / 代理 / 部署 / 访问 / 关于」：默认权限（置顶）、主题、语言、字号、
  代理、每个模型的推理强度/图片能力/上下文窗口/最大输出、claude 版本的下载源/安装/切换，
  以及飞牛已授权目录的查看/添加/撤销、端口访问开关、TCP 端口与访问密码（单密码，无用户名）；
- 左侧栏功能区（对齐 DSH）是**整页视图**，不是弹窗：插件 / MCP / 技能中心 / 自动化任务 /
  历史记录打开后接管「左侧栏以外的剩余区域」（移动端铺满视口），入口在原地高亮，再点一次
  回到对话；每一行右侧的图钉可取消固定，被取消的入口移入「更多」（点条目照样进入，
  行尾图钉可固定回来），固定状态只缓存浏览器（`ccweb-sidebar-feature-hidden`），
  不进 `settings.json`；
- 输入框 `+` 是添加菜单（对齐 DSH）：本地文件/图片、从飞牛选择、以及 claude 的 `/` 指令；
  输入 `@` 打开工作区文件引用（Tab 进目录、Enter 引用，菜单里也能调起飞牛选择器，见 4.16）；
  附件随 prompt 发送，其中图片在用户气泡里直接显示并可点开大图（粘贴截图也走这条路）。模型与推理等级是 DSH 风格的两级菜单（按提供商分组，不显示图片标记；
  档位是「默认（不向 API 声明）+ 模型声明的档位」，默认选中「默认」；切换档位会按同一 id
  重开会话让它生效，进行中等这一轮结束）；
- 左侧栏品牌图标使用 `frontend/src/assets/claude-code.svg`；鉴权页（TokenGate）复用同一个
  `BrandMark`（不套色块：logo 本身就是陶土色）；浏览器标签页图标（`index.html` 的
  `<link rel="icon">`）也指向这一份 SVG，不要另放一份 favicon 让两处图标各自漂移；
  前端不允许呼吸灯/无限 pulse 动画。

部署约定：**只部署 `ccweb` 本身**。`claude` 不随包分发、也不回退 PATH、也不接受环境变量覆盖：
只能由「设置 → 部署」从 npm 平台包按版本下载到
`CCWEB_DATA_DIR/claude/versions/<版本>/claude`，面板里切换生效版本。

## 2. 架构

```
浏览器 (React)
   │  WebSocket /ws?id=<session>
   ▼
gateway（unix socket，网关前缀 baseurl；TCP 端口 3141，根路径）
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
| `gitctl` | 标准库、系统 `git`、`netproxy`（只拿代理环境变量） | shell 拼接、HTTP |
| `terminal` | 标准库、Linux PTY ioctl | HTTP / WS 帧（由 gateway 负责） |
| `conversation` | 标准库 | claude 转录解析（由 history 负责） |
| `agent/manager` | `agent/session`、`agent/process`、config、settings | 处理 HTTP / WS |
| `agent/session` | `agent/protocol` | 知道文件系统布局、知道前端协议 |
| `agent/process` | 标准库 | 启动会话、解析 NDJSON |
| `claudebin` | 标准库 | 启动 claude、决定会话参数 |
| `trimapi` | 标准库 | 知道 HTTP 路由 / 前端协议（只经飞牛 apiscope socket 出站） |
| `schedule` | 标准库 | 起会话 / 发消息 / 建对话（只算时间、存任务、调 deliver 回调） |
| `agent/protocol` | 标准库 | I/O、状态机 |

`gateway` 对 manager 只依赖 `SessionManager` 接口（见 `gateway.go`），
这样网关可以在没有 claude 二进制的机器上跑单测。

## 3. 不可破坏的约定

1. **入口只有两条：unix socket 与一个 TCP 端口**。不要再加第三个监听端口或让 TCP 也挂 baseurl：
   TCP 通道固定根路径、无前缀；unix 通道固定 `CCWEB_BASEURL`。两条通道的凭据规则见
   `internal/authz`（TCP 必须用访问密码登录换会话令牌，unix 免密）。
2. **路径全部来自环境变量**（`CCWEB_*`）。禁止硬编码 `/tmp`、`/var/apps` 之类。
3. **baseurl 在运行期决定**。前端资源用相对路径，`index.html` 由后端注入 `<base href>`；
   前端任何请求必须走 `runtimeBase()` / `apiUrl()` / `wsUrl()`。
4. **`--permission-prompt-tool stdio` 不能删**（`process.Args`）。删了之后需要审批的工具
   会被 fail-closed 静默拒绝，前端永远收不到 `can_use_tool`。
5. **`initialize` 必须由客户端先发**，且要在进程启动后立刻发。顺序错了会死锁。
6. **控制响应不得阻塞读循环**。`session.handleLine` 里的写操作走 `writeLine`（带锁）。
7. **未实现的控制请求子类型必须回 `unsupported_request`**，不能让 CLI 干等。
8. **鉴权按通道区分，且端口访问默认关闭**。新增 HTTP 路由要挂 `s.authed`；WS 必须校验 token。
   环境变量 `CCWEB_AUTH_TOKEN` 两条通道都校验；端口访问开启后，TCP 通道必须登录
   （`POST /api/auth/login` 用访问密码换会话令牌，unix socket 是本机可信入口、免密）。
   密码只存 PBKDF2 摘要，**任何接口都不得回传密码、摘要或把密码当令牌**。
   `/api/info` 的 `auth_required`/`auth_mode`/`channel` 必须按本次请求的通道回答，不能给全局答案。
9. **日志只在异常/失败时输出**。不要加启动横幅、例行生命周期日志。
10. **不提交构建产物**：`bin/`、`frontend/dist/`、`embed/assets/`、`.gocache/` 等见 `.gitignore`。
11. **会话 cwd 必须在授权目录内**。`POST /api/session` / `/api/session/ensure` 都要过
    `workspace.Allows`；`CCWEB_PROJECTS_ROOT` 是默认授权目录，不是任意路径的通行证。
12. **恢复对话用 `manager.Resume`**（同一 id 去重），不要用 `Ensure`/`Create` 造新会话；
    `Ensure` 只保留给旧客户端按目录兜底。后端预热与前端同时恢复时必须靠 createMu 去重。
    唯一的例外是**新建后还没发过消息、claude 那边没有转录**的对话：它走
    `manager.StartFresh`（同一个 UUID 作 `--session-id`），id 不变、`--resume` 不参与。
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
- **「跳过权限」不是普通模式**：`set_permission_mode bypassPermissions` 只在「启动时带了
  `--allow-dangerously-skip-permissions`」的会话里被接受，否则 CLI 回
  `Cannot set permission mode to bypassPermissions because the session was not launched
  with --dangerously-skip-permissions`（实测 2.1.325）。所以 `process.Args` 一直带这个
  **能力开关**（按 `supportsFlag` 探测）：它不会让会话以 bypass 启动——带上它 +
  `--permission-mode default` 时第一轮照常弹审批，切过去之后才自动放行。
- 审批挂起期间进程和内存（约 176 MB）一直占着。长时间等人工的场景应改用
  PreToolUse hook 的 `defer`（会以 `tool_deferred` 退出，决策状态落库），
  当前版本尚未实现。
- **审批是会话级状态，不是浏览器本地状态**：`can_use_tool` 会群发给该会话的所有
  连接（多台设备 / 多个标签拿到同一个 `request_id`），而 CLI 只认第一份回包，之后
  不会再发任何东西暗示「这条已经处理完」。所以 `session.forgetPermission` 必须广播
  `permission.resolved{request_id}`，前端据此撤卡片；中断（`Interrupt`）同理，整轮
  审批作废时后端 `clearPermissions` 逐条广播。少了这条事件，别的设备上的卡片会
  永远挂着、一轮里越攒越多（曾经的 bug）。回包之后前端**仍然**本地乐观删除一次，
  事件是给其他连接的。

### 4.2.1 模型提问（`AskUserQuestion`）

- **它走 `can_use_tool`，但不是审批**：官方工具表里 `AskUserQuestion` 的 Permission required 是 **No**。
  前端按 `tool_name` 分流到 `AskUserQuestionPanel`，标题写「模型提问」，不给「始终允许 /
  切到某模式」——那两颗按钮对提问没有语义（`permission_suggestions` 一般是空的）。
- **答案必须放在 `updatedInput` 里**：`{questions: <原样回传>, answers: { [问题原文]: label | label[] }}`。
  只回 `{behavior:"allow"}` 不带 `updatedInput`，模型拿不到任何选择（等于没答）。`response`
  是整卡级的自由回复，带上它 CLI 会用「The user responded: …」替换整份答案——逐题作答时别用。
- **逐题拒绝，不整批作废**：claude 的 answers 是 `{问题原文: label|label[]}`，没有 DSH 那种
  空 `selected: []` 的合法值，所以「这题不答」以**一句占位文本**回给模型
  （`（用户跳过此题，按你的最佳判断继续）`，`lib/askQuestion.ASK_SKIP_*`，按界面语言给），
  模型读得懂、也不用改系统提示词解释「空值是什么意思」。**每题独立**：跳过某一题不影响
  其他题，全跳过也能提交；别把「不回答」做成 `allow:false` 的整批拒绝——那会让人以为只跳过了
  当前这题（踩过）。整批放弃走输入框的「停止」（中断整轮）。
- **提交前自检**：每题必须选一项、写一段非空文本、或明确跳过，否则
  `firstUnanswered` 跳回第一道未处理的题并内联提示，不发回包。
- **推荐项只加徽章、不预选**：`(Recommended)` / `（推荐）` 只是标签，CLI 的 idle 超时只会提交
  「对话框里已选中的」，我们本地的预选它根本拿不到；预选只会让人以为「已经答了」。
- **`askUserQuestionTimeout` 只提示、不改**：默认 `never`（v2.1.200 起，2.1.198/199 曾短暂默认 60s），
  取值 `60s` / `5m` / `10m`，**只在用户级 settings 生效**。后端读
  `$CCWEB_CLAUDE_HOME/.claude/settings.json` 的同名顶层键，经 `/api/info` 的
  `ask_question_timeout` 给前端，卡片上提示「不回答的话 CLI 到点会自己收尾」；ccweb 不替用户改设置。
  它在 stream-json 路径上到底会不会触发、超时用什么答案结算**都未实测**，别当已知行为用。
- **子代理不能提问**（官方限制），卡片因此不处理 agent 归属；`dontAsk`（不询问）模式下
  `canUseTool` 不被调用，提问到不了前端，模型会自己往下走。
- 作答草稿按 `request_id` 存浏览器本地（`lib/askDrafts.ts`）：切对话 / 重载回来还在；
  提交成功、`permission.resolved`、进程结束、中断时清掉，避免下次同 id 的卡片带着过期答案回填。

### 4.3 Go 侧

- `os.Pipe` 有内核缓冲，`net.Pipe` 没有 —— 测试里用 `net.Pipe` 很容易自锁。
- 环境变量重复时**后者生效**：`process.CleanEnv` 先剔除 `HOME`/`PWD` 再追加。
- **不能剔除 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`**：自定义中继是本项目的基础能力。
- **启动器可能不给 PATH**：飞牛（fnOS）的 fpk 启动脚本漏写 `export PATH="$PATH"` 时，
  应用是被空环境 exec 起来的——进程里**没有 PATH 变量**，而 Go 的 `exec.LookPath`
  对空 PATH 直接失败（不会回落到 `/bin:/usr/bin`），于是 git 面板（spawn `git`）与
  内置终端（找 `bash`/`sh`）双双不可用，claude 会话却正常（它用托管版本的绝对路径）。
  `internal/envpath` 负责兜底：启动时 `Apply()` 补进程 PATH，`process.CleanEnv` /
  `gitctl.gitEnv` 给子进程补，`terminal.FindShell` 还有 `/bin/sh` 绝对路径兜底。
  **新增任何 spawn 系统命令的代码都要意识到 PATH 可能为空。**
- `go:embed all:embed` 要求目录存在；`embed/.gitkeep` 负责保留目录，
  `embed/index.html` 是构建产物、已在 `.gitignore` 里，`make clean` 直接删除。

### 4.4 对话持久化

- **`--resume` 不会回放历史**：claude 只把新回合写 stdout；界面历史必须靠
  `/api/history/transcript` 读 jsonl，再用前端 `applyCLI` 回放。别指望连上 WS 就有旧消息。
- **转录回放必须保留时间戳**：`applyCLI(items, msg, at)` 的第三参数用于历史行；
  不传则用 `Date.now()`，会让所有旧消息显示成“刚刚”。
- **空对话不要落元数据**：新建后还没首条消息时，后端只在 manager 列表里展示；
  首条 prompt 成功才 `conversation.Touch`。否则后端重启后会出现无法 `--resume` 的幽灵条目。
  **恢复（`POST /api/session {resume}`）也不例外**：以前只要带 `resume` 就 touch，于是
  「重进一次空对话」（页面刷新后 bootstrap 会恢复 active id）就把幽灵条目写进了
  `conversations.json`——APP 重启后前端按它 resume，CLI 回
  `No conversation found with session ID: …`，界面上只有一个永远起不来的对话。
  现在的三段防线：① **没有转录的 id 不走 `--resume`**，改用 `manager.StartFresh`
  （同一个 UUID 作 `--session-id` 新建：id 不变、转录照旧按这个 id 落盘）；
  ② 只有「有转录，或已经有元数据」才 `touchConversation`——**新建的空对话不能落记录**，
  但已经存在的记录（例如用户重命名过的空对话）打开时照常刷新最近活跃；
  ③ `GET /api/conversations` 不展示「没有转录 + 没有标题 + 没在跑」的条目
  （记录保留，转录真出现时会自己回来），
  启动预热也先 `history.TranscriptExists` 再 Resume。
- **删除是软删除**：`conversation.Delete` 写 `deleted` 墓碑并保留 jsonl；列表/自动恢复都要
  跳过 deleted/archived。不要把「删除」实现成直接 `os.Remove` 转录。
- **自动预热不是新建**：`CCWEB_AUTO_START` 只恢复 `LastFor` 或最近转录；没有对话就什么都不做，
  由前端创建第一条。改回 `mgr.Ensure` 会让每次重启多一条空对话。
- **分叉（`POST /api/conversations/fork`）不改写原转录**：CLI 的
  `--resume 旧 --fork-session --session-id 新` 把历史复制到新 id 下（2.1.326 实测），
  新转录文件名就是我们生成的 UUID，与列表 / `activeId` 同源。不要自己去复制 jsonl。
  没有转录的空对话（400）与已删除的对话（409）必须在**起进程之前**挡掉：CLI 的
  `--resume` 找不到会话会直接退出，那时我们只会留下一条永远 resume 不了的元数据。
- **「最近更新」排序必须按真实时刻比，不能比字符串**：`last_active` 后端给的是 Go 的
  RFC3339（偏移跟着时间值走，转录解析出来常带 `+08:00`），前端乐观更新写的是
  `new Date().toISOString()`（永远 `Z`）。`localeCompare` 比的是字面量，
  `2026-01-05T10:00:00+08:00` 会排在 `2026-01-05T02:00:00Z` **之后**——同一时刻的两条
  就此定死了一个错误顺序，这就是「排序偶尔不生效」的来源。统一走
  `lib/conversations.timeValue`（`Date.parse`）+ `sortByRecent`，别再手写 `.sort(localeCompare)`；
  侧栏、历史记录页、`store` 里两处「同工作区下一条」都用它。
- **claude 转录会包含 sidechain / meta / queue-operation 行**：回放只取
  user/assistant/system/result 且跳过 `isSidechain`/`isMeta`，否则子代理和系统提醒会混进主消息流。

### 4.4.1 WS 重连要补齐断线期间的事件（`sync` / `session.replay`）

- **断开期间 CLI 不会停**：正文、工具结果、回合结束的 `result`（本轮用量、耗时、tok/s
  全在它上面）照常产生，而 hub 只发给**当时**的订阅者。重连后只发一份 `session.snapshot`
  （状态/审批/后台任务）是不够的——消息流是空的，于是「断网时跑完的那一轮」永久缺一段，
  只有整页刷新（重建 store → 整份转录回放）才恢复。曾经就是这个症状。
- **`session.Session` 记一份有界事件缓冲**（`replayMaxEvents` / `replayMaxBytes`，
  变量便于测试调小），每条事件带 `Seq`；`emitData` **在没有订阅者时也要 record**
  （测试、网关未接上都算），否则缓冲里是空的。
- **前端记 `eventSeq[sid]` 水位**，收到 `session.snapshot` 的 `seq`/`epoch` 后决定：
  ① 本地没记过 → 只对齐，不补（消息流刚由转录铺好，补一遍会叠成两份）；
  ② `epoch` 变了（进程被回收/重启后用同一 UUID 又起来，seq 从头开始）→ 整份重放转录；
  ③ 有缺口 → 发 `sync {since, epoch}`。
- **`epoch` 一变，去重集合必须跟着清**（`resetSyncWatermark`）：`appliedSeq` 里装的是
  上一个进程的 1..N，而新进程的序号从 1 重新开始——不清的话新进程的前 N 条事件全部
  命中「已处理」被丢掉，界面上就是「重启之后那一轮只剩后半截」。`syncMissedEvents`
  与 `session.resync` 两条路都要走它（水位、去重集合、对齐窗口、压着的实时事件一起重置）。
- **`session.snapshot` 与 `sync` 都不能省 `epoch`**：只比 seq 会把新进程的前几条当成
  老进程的续集拼上去。`session.resync` 必须回当前 `seq`/`epoch`，否则前端下次重连
  拿同一个过时的 since 来问，来回 resync。
- **补发是一整帧 `session.replay`，不是逐条 SendJSON**：逐条会把补发历史与此刻的
  实时广播交错（两者都只是入队），前端收到的事件顺序就不是产生顺序。
- **前端有「对齐窗口」**（`awaitingReplay`）：sync 已发、replay 未到时到达的实时事件
  先压着，等补发帧到了按 seq 合并应用——否则 result 可能抢在它对应的正文前面。
  1 秒兜底计时器防止没回补发帧时消息一直不动。去重靠 `appliedSeq`（逐条的 seq 集合），
  **不能只按水位跳过**：水位会被抢先到达的实时事件推高，而缺口恰恰在那之前。
- **`session.resync` 之后不能再冲一次对齐窗口**：窗口里压着的那些实时事件，内容已经在
  刚重放的转录里（转录是磁盘上的权威版本，断线期间产生的都写了进去），再应用一遍就是
  同一段正文出现两三遍。resync 只做「整份重放 + 对齐水位」，`pendingLive` 一并丢掉。
- **`session.resync` 的重建是「合并」不是「覆盖」**（`lib/normalize.mergeReplayed`）：
  以转录为主，只接本地 `ts` 晚于转录最后一条的条目（断线时本地插的错误提示等），
  并重排 seq。`settle=true` 顺手收掉本地残留的流式光标——那一轮早就结束了。
- **转录回放不能走「CLI 回显去重」**（`applyCLI(..., { replay: true })`）：那套去重
  （`echoAlreadyShown`）的前提是「本地已经乐观插过一条气泡」，只有实时路径成立；而且
  它的轮边界是「上一条 `result`」，**转录里没有 result 行**，边界永远触发不到——整段
  历史都参与比对，用户重复发送的同一句话会被吞（实测一份真实转录里发过 4 次的
  「提交修改」回放后只剩 1 条）。主转录与子代理转录两条回放路径都传这个标记。
- 只有 `/ws?id=` 会话通道有这套东西；系统通道没有会话，`sync` 走不到。


### 4.5 右侧栏 / 终端

- **PTY 没有第三方依赖**：Linux 上直接开 `/dev/ptmx` + `TIOCSPTLCK/TIOCGPTN/TIOCSWINSZ`。
  在 agent 沙箱里跑测试会 `permission denied`（设备访问被拦），这是环境限制，不是代码错；
  完整权限下 `TestSessionEcho` 会真正跑通。
- **终端 WS 输出必须走二进制帧**：PTY 的 ANSI 序列与半截 UTF-8 不能塞进 JSON 字符串，
  否则会被替换字符破坏；上行命令才是 JSON 文本。
- **服务端先发 `error`/`exit` 再关连接时，前端不能把状态覆盖成 `closed`**：`TerminalConnection`
  记住最后一次状态，保留真正的失败原因。
- **右侧栏是「开始页 + 标签页」**（对齐 DSH）：没开标签时是开始页（工作区文件 / Git /
  新建终端三张卡片，两列网格），**不要自动开「文件」标签**；点卡片才开标签。
  顶部一排标签，文件 / Git 各是单例（已开就切过去），
  终端**每个会话各占一个标签**（`bash`、`bash 2`…），标签自带 × 关闭。
  顶部 `+` **不是菜单，是回到开始页**（`active === ""` 即开始页）：三个入口已经在那三张
  卡片上，再摆一份下拉菜单等于同一件事两个入口。开始页自己不显示 `+`（点了不会有变化）。
  **开始页只是盖在标签面板上面一层**，标签面板照旧只隐藏不卸载（理由同上一条：
  终端里挂着 PTY）；「关掉所有标签回开始页」与「点 `+` 回开始页」是两种状态。
  **标签切走只隐藏、不卸载**——终端里挂着 PTY，卸载等于杀 shell；只有关掉标签才 SIGHUP。
  不要改回「启动页 + 返回按钮」那种切换。
- **收起整条右侧栏也只隐藏**（`RightSidebarDock`）：`App` 里 `rightOpen` 为 false 时渲染的是
  `<div class="hidden">`，不是不挂载。移动端关抽屉是高频动作，卸载会把顶部标签、当前选中的
  那个、文件预览与终端 PTY 一起丢掉——用户看到的就是「关一下侧栏，标签全没了」；
  PTY 被 `TerminalView` 的清理 `close()` 掉，重开也只能得到新 shell、scrollback 全丢。
  看不见时把 `visible=false` 传下去，让 Git 面板退订（`git.unwatch`），别在没人看的屏幕上
  每 3 秒跑一次 git。首次打开前仍然不挂载（懒加载 chunk 不该为没开过的侧栏下载）。
  想彻底结束终端，关那个标签就行。
- **终端可多开**：每个终端一条 WS、一个 PTY；后端上限 8（`maxTerminals`），
  换工作区时全部结束（旧 shell 的 cwd 已经不成立）。
- **Git 支持工作区内的多个仓库**：`GET /api/git/repos` 扫描（深度 3、跳过隐藏目录与
  `node_modules`、命中仓库不再下钻），前端把选中的仓库绝对路径直接当 `/api/git/*` 的
  `cwd`（子目录本来就能过 `authorizedCwd`，不必为它加新参数）。
- **文件面板的「显示隐藏文件」是全部隐藏项、不排除 `.git`**：那个开关的字面意思就是
  「把点开头的都露出来」，仓库在自己工作区里却看不见只会让人以为面板读错了目录。
  浏览本身是惰性的（每层只列直接子项 + 单层 2000 条上限），不会一次翻出整个对象库；
  `/api/fs/tree` 的 `hidden=false` 仍然一条都不给。`@` 补全（`fsapi.Complete`）与
  目录下载的 `.git` 跳过是两条**独立**的规则，不随这个开关变：补全要按相关性排序、
  zip 打包对象库纯属浪费。
- **文件面板行菜单有「引用到对话」和「下载」**：引用只把**绝对路径**交给
  `useAppStore.requestMention`（带单调递增 `seq`，Composer 消费一次后清空），由 Composer 用
  `lib/mention.mentionPath` 折算成 `@相对路径` 插进光标处（cwd 之外保留绝对写法）——格式化
  逻辑不要放到侧栏里。下载走 `GET /api/fs/download`：**必须 `Content-Disposition: attachment`**，
  与 `/api/fs/raw` 的 inline 白名单是两条路（下载不设类型白名单、不整份读进内存；目录用
  `fsapi.Zip` 打包，不跟随软链、跳过 `.git`、20000 条目 / 2GiB 预算）。
- **下载不能做顶层导航**（踩过）：直接点一个指向下载地址的 `<a>`，在飞牛 App 的 WebView /
  宿主 iframe 里会被当成一次页面跳转——应用页面被换掉，**WS 随之断开再重连**（表现是
  「下载时闪一下断线」）。现在文件走 `fetch → blob → <a download>`（不导航，DSH 在同一个
  宿主里也是这个做法），超过 256MB 的文件与目录的 zip 走**隐藏 iframe**（导航只发生在
  子框架里，同样不碰应用页面）；文件名由后端的 `Content-Disposition` 给（blob 路径用
  侧栏传的名字）。不要改回「顶层锚点直链下载」。
- **Office 文档能就地预览，但走的是另一条字节通道**：`previewKind` 把
  docx/docm/xlsx/xlsm/pptx/pptm 分成三类，`FilePreview` 交给
  `components/right/preview/OfficePane`，它用 `GET /api/fs/blob` 取原始字节再渲染。
  **不要让这条接口变成通用读文件口**：后端白名单只认这六个扩展名、上限 32MB
  （字节会整份进浏览器内存），响应固定 `application/octet-stream` + nosniff（浏览器
  永远不会把它当页面执行）；也不用 `/api/fs/raw` 那条 inline 通道——它的 CSP/白名单
  是给图片与 PDF 的。老格式（.doc/.xls/.ppt）是 OLE 复合文档，没有可信的前端解析器，
  继续走「二进制占位 + 下载」，**不要拿 .docx 的解析器去硬解**。
  `FilesPanel` **先判类型再判 `file.binary`**：Office 文件的 binary 一定是 true，
  顺序反了会渲染成「不支持文本预览」。
  **解压要另算预算**：32MB 的请求上限管不到解压后的体积（zip 能到 1000:1，一个
  32MB 的 xlsx 可以解出几十 GB XML）。`lib/ooxml.unzipParts` 在解压前按条目的
  `originalSize` 计价，单条 >48MB 或总量 >128MB 抛 `OoxmlTooLargeError`，界面给
  「解压后体积过大，请下载」而不是白屏/OOM；pptx 的 `ppt/media/*` 只解压位图
  （`isPptxPreviewPart`），视频/音频/EMF 在解压前就挡掉。
  `OfficePane` 用**面板传下来的 `cwd`**（不是 store 的全局当前工作区）取字节：
  切工作区的一瞬间两者可能不一致，预览会去读另一个目录里的同名相对路径。
- **三个解析器各自是一个懒加载 chunk**（`components/right/preview/` 的
  `DocxPreview` / `XlsxPreview` / `PptxPreview`）：docx-preview（含 jszip）约 50KB gz，
  首屏不该为多数会话根本不会打开的文档买单。`OfficePane` 自身很轻，静态 import 没问题。
  - **docx 用 docx-preview**：排版还原值得这份体积，它只解析 + 建 DOM，不执行宏、
    不取外部关系。注入的 wrapper 灰底与页边距在 `styles.css` 的 `.docx-preview-host`
    规则里抹平（`section.docx` 要吃满容器宽度，否则 flex 子项按 max-content 撑开、
    右侧正文被裁）。
  - **xlsx / pptx 自己解**（`lib/xlsx.ts`、`lib/pptx.ts` + `lib/ooxml.ts` 的 zip/XML
    公共件，zip 用 fflate）。不引 SheetJS：npm 上停在 0.18.5（0.19.3 才修的原型污染
    漏洞）、7.5MB，而我们要的只是「把值读出来」；不引 pptx-preview：它是闭源混淆包。
    保真度明确不高（列宽/合并单元格/母版/主题/动画都不还原），边界写死：xlsx 200 行 ×
    50 列、pptx 100 页、单元格 300 字符，超了显示提示让用户下载。
  - **公式没有缓存值就显示公式本身**（`=B2-C2`）：openpyxl 与未重算的文件只有 `<f>`
    没有 `<v>`，显示空格子会让人以为原来就没内容。
  - 解析失败一律显示原因（不吞成空白），用户还能用行菜单下载。
- **Git 只拉不推**：`POST /api/git/pull` 只做 `pull --ff-only`（`gitctl.Push` 已删除）。
  推送是对外动作，不该由侧栏一个图标顺手完成；需要时用户自己开终端 `git push`。
  拉取**没有二次确认**：它就是那颗同步图标的本意，成功安静刷新（状态 / 分支 / 历史
  一起刷），失败由面板顶部的错误条给原因。别把确认框加回来。
- **Git 状态靠推送，不靠前端轮询**：面板可见时前端在系统通道（`/ws`，不带 id）上发
  `git.watch {cwd}`，后端用 `gitctl.Watch` 每 3 秒读一次完整快照（`ReadStatus` 的输出，
  含两侧 numstat——只看 porcelain 的话「已标 M 的文件再改一次」不会变），变了就推
  `git.changed {cwd}`；面板切走 / 连接断开即取消订阅（`git.unwatch` 或 defer 里的
  `setWatch(nil)`，不取消的话 NAS 上会一直空跑 git）。**不要退回前端 setInterval 轮询**：
  那是「拉取成功后历史不刷新、源码变了面板半天不动」的来源。
  `cwd` 与 `/api/git/*` 走同一条 `authorizedCwd` 围栏；订阅是**按连接**的（多标签页各自
  订阅各自路径），不做全局引用计数。
  **看得见才订阅**：页面在后台（`document.hidden`，手机锁屏 / 切走 App）不订阅，切回前台
  补订阅并补刷一次；功能区整页视图盖住右侧栏时（`App` 的 `view`，侧栏只是 `display:none`）
  也按不可见处理（`RightSidebar` 的 `visible` → `GitPanel.active`）。否则没人看的屏幕上
  NAS 会一直每 3 秒跑一次 git。
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
- **飞牛 App 里也是宿主**：桌面微应用是 iframe（postMessage 桥接），App 里是**顶层 WebView**
  （没有 parent，SDK 走 `flutter_inappwebview.callHandler`）。宿主判定必须三条都认：
  `window.parent !== window`、`window.flutter_inappwebview` 已注入、UA 带
  `FNOS/` / `FNAppType/` / `FNAppVer/`。只看 iframe 会把 App 判成「不在宿主」，
  文件管理器、目录/文件选择器全部失效（报「当前不在飞牛宿主中」）。
- **「不在宿主」和「宿主连不上」要分开说**：`standalone` 才提示不在宿主，
  `bridge`（握手超时/加载失败）要说连接不可用，否则 App 里会得到一个完全误导的报错。
- 不做版本分流：dsh 那边按飞牛 App 版本切网页授权页，本应用只跑微应用 iframe，不适用。
- 「选择飞牛目录」（`pickUserFile`）本身就是授权入口：挑完只在弹窗里**进入该目录**，
  不自动登记、不关弹窗、不进新对话；用户点「添加」时探测已通过，不会再弹一次确认框。
- 「添加授权目录」弹窗里的**「已授权目录」是唯一的目录入口**：打开时现查飞牛授权列表
  （`GET /api/dirs`），芯片 = 授权目录 ∪ 已登记工作区（按路径去重）。
  **这一栏只做跳转，没有任何删除入口**：撤销授权是「设置 → 目录」的事，而应用自己的安装目录
  （ClaudeCode）就在列表里，在这里顺手删掉等于自断手脚；移除工作区仍走侧栏工作区行的菜单。
  旧的「快捷入口」已并入这里，不要再单独摆一行；当前路径只认顶部输入框，
  底部那行只读路径与「上一级」右侧的父路径都已删除（重复信息）。
- 「新建文件夹」走 `POST /api/fs/mkdir`：只接受**单层目录名**，带分隔符/`.`/`..` 一律 400；
  它是宿主写操作，和浏览接口一样必须挂 `s.authed`。
- 「重命名工作区」走 `POST /api/workspaces/rename`，**只改显示名**，绝不 `os.Rename` 真目录
  （路径是授权键：会话 cwd、workspaces.json、前端当前工作区都按它匹配）。

### 4.6.1 「从飞牛选择」的文件

- 宿主桥接只给**路径**（`pickUserFile` 返回 `string[]`），没有读文件 API。所以图片/PDF
  由后端 `POST /api/fs/host-file` 读成附件，其余类型只把路径写进消息，由 claude 用 Read
  工具自己读。
- **右侧栏文件面板的行菜单按宿主能力给项**：宿主里（桌面 iframe / App WebView）的文件行是
  「用默认应用打开 / 引用到对话 / 下载 / 在文件夹显示 / 复制路径 / 文件详情」，目录行没有
  「用默认应用打开」（打开目录就是「在文件夹显示」，两条入口只会让人不知道点哪条）；
  不在宿主只留「引用到对话 / 下载 / 复制路径」——不要摆一堆点了就报错的项。
  路径一律先拼成 NAS 绝对路径（宿主 API 只认绝对路径），文件的「在文件夹显示」打开它所在的目录。
- **「用默认应用打开」走 `sdk.openFile`**（`lib/fnos.openFnosFile`，与 dsh 插件
  `dsh-fnos-advanced` 的 `openFile` 是同一条宿主能力，等价文件管理器里的「打开方式」）。
  容器里没有桌面环境，D-Bus/`xdg-open` 那套在 NAS 上不成立；这里只把路径交给飞牛，
  由它按扩展名挑应用。宿主回 `false`、老宿主没有该方法时**静默退回文件管理器**（只能定位
  所在目录），不要报错——用户至少落在文件夹里，报错却什么都得不到；调用方不要为
  `fallback` 再弹一次提示。
- **`/api/fs/host-file` 是唯一不受工作区围栏约束的读文件接口**（选择器挑的文件本来就在
  工作区外）。边界：只放行图片/PDF（扩展名初筛 + `http.DetectContentType` 复核，改名的
  HTML/SVG 会被拒）、必须是普通文件、≤ 8MB、必须挂 `s.authed`。不要在这条路上加
  「顺手读个文本文件」——那等于给前端开了任意宿主文件读取。

### 4.6.2 飞牛「已授权目录」（设置 → 目录）

- **真源在飞牛**：scope `trim.file.userAccess` 管的是「当前飞牛用户授权给本应用的目录」，
  只能由**服务端**经 unix socket `/var/run/trim_open_gateway_apiscope.socket` 调
  `POST /api/v1/trimapp`：`{reqId, req, appName, data}` + `Authorization: Bearer $TRIM_API_TOKEN`。
  连**浏览器**都不要直接调（token 不能下发给前端）。
- **token 每次现读**（`config.TrimToken` 是个函数）：飞牛在启动 `cmd/main` 时注入
  `TRIM_API_TOKEN`，应用重新注册/重装后会换；缓存一份就是 401。官方同样要求不落盘。
- **scope 要声明在包的 `config/resource`**：`{"api-scope": ["trim.file.userAccess"]}`。
  没声明时网关回 `200004`/`1000002`（`internal/trimapi` 把 code/msg 原样带出来，界面直接显示原因）。
- **uid 只认网关注入的 `X-Trim-Userid`，而且只认 unix socket 通道上的那一份**：授权按飞牛
  用户记账，应用自己不信客户端传的 uid。**TCP 通道必须直接拒收这个头**——那条路上没有网关，
  头是浏览器随手写的，认它等于让任何拿到访问密码的人带上 `X-Trim-Userid: 1000` 去查、
  甚至撤销别人的目录授权。拿不到可信 uid（TCP 直连 / `make dev`）就回空列表 + 原因——
  那是「无从查起」，不是「还没授权」。
- **添加只能由用户确认**：宿主内 `pickUserFile({directory:true})`（选完即授权）；
  宿主外（独立浏览器）`openAppAuth("pickUserFile", {appName, redirectUri, state})` 打开飞牛
  授权页。**不做 App 版本分流**（那是 dsh 的事）。
- **宿主外必须有回调页**：`redirectUri` = `<baseurl>/callback`。它走 SPA 回退但**不挂应用壳层**
  （`main.tsx` 用 `isAuthCallbackPath` 分流，见 `AuthCallbackPage`）：不经过令牌门、不建 WS，
  只把结果 postMessage 给原页面并关闭自己。
- **state 的比对在发起方**：回调页拿不到发起时生成的随机串，它只转交；原页面用
  `authSucceeded(result, expectedState)` 判定。少了这一步，任意页面编一条 `?status=success`
  就能冒充一次授权。
- **直连端口访问打不开 `/app-auth`**（不在飞牛网关前缀下）：这种情况下按钮只给一句人话，
  不要跳到一个 404 页面。
- 这一页**只有列表 / 添加 / 撤销**：不打开目录、不标目录徽章、不写说明——它只回答
  「claude 现在能碰哪些目录」。撤销是破坏性动作，先 `askConfirm` 再调接口。
- **应用自己的目录不许撤销**（安装包固有目录，撤了连自己的二进制都读不到）：
  `gateway.ProtectedDirs(cfg.DataDir, cfg.ClaudeHome)` 取二进制所在目录、安装根、数据目录、
  claude HOME 的 realpath，`/api/dirs` 的原样回给前端（`protected`，界面据此不给撤销按钮；
  前端 `lib/dirs.isProtectedDir` 与后端同一套「等于 / 祖先 / 子路径」规则——只比相等的话，
  授权列表里出现安装目录的父目录时会摆一颗点了就报错的按钮），
  `POST /api/dirs/remove` 再挡一次——**命中「等于 / 在其上 / 在其内」都拒绝**（撤销父目录同样
  会让应用的目录失效）。只靠前端隐藏按钮不算数。

### 4.7 前端侧

- `--include-partial-messages` 会**先给逐字增量、再给完整消息**。两套都追加会导致
  每句话显示两遍；`lib/normalize.ts` 的做法是「摘掉流式气泡后按内容块顺序重建」——
  一条消息里的多个 text 块各自成段，thinking 排在正文之前（曾经只取第一个 text 块，
  还把 thinking 挤到答案下面）。
- 工具集会随 CLI 版本漂移（实测 2.1.325 的 API 请求只带 12 个工具，且有
  `ToolSearch` / `DeferredToolPlaceholder`）。**必须保留 `GenericCard` 兜底**，
  禁止硬编码工具清单。
- **`result` 的失败原因必须显示**：CLI 把「API Error: 400 …」「达到最大轮数」放在
  `result.result` / `result.errors` 里。成功回合的 `result` 与最后一条 assistant 正文重复，
  只在 `is_error` 时渲染，别整段照抄。
- **中断不是失败，中断标记也不是用户消息**：用户按停止时 CLI 会往流里写一条合成的 user 消息
  `[Request interrupted by user]`（工具执行中是 `… for tool use`；进程/会话被结束时是
  `[Request interrupted: …]` / `[Agent call interrupted: …]`），随后把这一轮判成
  `error_during_execution`，**而且不写 `result.result`**——内部诊断只在 `errors` 数组里：
  `[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null`（中断
  工具调用时 `stop_reason=tool_use`）。**只查 `result.result` 会漏掉一整类**：界面上
  照旧弹「本轮出错 + 诊断」（第一版就踩了，截图复现）。判定看「界面上会显示的文本」
  （`result` 或 `errors.join`）：
  ① 文本全是这段诊断且 `result_type=user`，或 ② 本回合有中断标记且原因就是标记本身。
  真正的 API 报错还会带自己的原因（`API Error: …`），不会被吞。
  以前这两条被原样渲染：气泡里多出一条「用户发的话」，下面再挂「本轮出错 + 诊断」。
  现在 `lib/normalize.ts` 把标记认成 `interrupt` item（一句「已中断」），
  把**紧跟其后的那段诊断 result 还原成正常结束**（`subtype: "interrupt"`、`is_error` 置 false、
  丢掉诊断文本）。真正的 API 报错照旧显示。后端 `history`（列表标题、消息数、preview）
  也跳过这条合成行。
  标记按来源分三类（`InterruptItem.reason`）：`user` =「已中断」、`session` =
  「会话已结束，本轮未完成」（重启/回收/删版本时恢复对话，CLI 补写
  `[Request interrupted: …]`，**没人要求停**，不能说成用户中断）、`agent` =「子代理被中断」。
- **其他终止方式同样要收尾**：① 任何 `result`（成功/失败/中断）到达时都要
  `settleStreaming`，否则没有完整 assistant 消息的回合会留下永远闪的流式光标；
  WS `closed`（进程没了）时 store 也要收尾。② 上游报错时 CLI 先用一条
  `isApiErrorMessage`（camelCase，snake 也认）的 assistant 消息包装「API Error: …」，
  `result` 里再给同一段原因——`applyResult` 若发现最后一条回答带 `apiError` 且已包含
  该原因，就不再重复。③ 模型拒答（refusal）的 result 是 `subtype:"success" + is_error:true`，
  `ResultBar` **不能把 "success" 当失败子类型展示**；`error_max_structured_output_retries`
  已补中文。④ 进程异常退出目前只有「连接已关闭」横幅 + 重连按钮，没有退出原因
  （`Session` 拿不到退出码，要说得更细得先让 Transport 暴露进程状态）。
- **tool_result 里的图片不能当文本渲染**：base64 塞进 `<pre>` 会糊满整屏。
  `textOfContent` 只给 `[图片 image/png，约 12 KB]` 占位，图片本体进 `ToolItem.images`
  由卡片画缩略图（只放行 png/jpeg/gif/webp，单张 ≤ 4MB）。
- `Edit` 的 diff 优先取 `tool_use_result.structuredPatch`，没有才退回 `old_string/new_string`。
- 浏览器无法给 WebSocket 设自定义头，鉴权只能走 `?token=`。
- 主题用 `<html data-theme>` 切换，Tailwind 的 `dark:` 已绑定到该属性；不要再写
  `@media (prefers-color-scheme: dark)` 覆盖令牌。**主题偏好只缓存在浏览器**
  （localStorage `ccweb-theme-pref`），不进 `settings.json`——换设备各自决定。
- 强调色固定为陶土色 `#D97757`，用 `bg-brand/text-brand` 等语义类，不要写死 slate/blue。
- **唯一允许的循环动画**是侧栏对话「进行中」的进度环（`common/StateDot` 的 `ongoing`，
  1.5s 匀速旋转，对齐 DSH），且 `prefers-reduced-motion` 下必须静止；呼吸灯/pulse 仍然禁止。
- **输入框下方的用量行**（轮数 / tok/s / 上下文%）全部来自 claude CLI 的
  `usage` 与 `modelUsage.contextWindow`（见 `lib/usage.ts`）；CLI 没有「步骤数」与
  「实时 tok/s」，对应显示的是换算值，不要把它说成官方指标，也不要为此去猜。
  快照随对话存进 `conversations.json`（`PATCH /api/conversations {usage}`），重开对话时
  用转录的 `assistant.message.usage` + 存下的 `apiMs` 还原，别在浏览器里另存一份。
  **上下文占用只认单次请求**：`stream_event` 的 `message_start/message_delta`（以及转录里的
  `assistant.message.usage`）才是「这次请求送出去的输入侧 token」。`result.usage` /
  `result.modelUsage` 是**整轮累计**（SDK 类型写明 usage 是主循环的 per-turn 汇总、modelUsage
  跨轮累计，与 `duration_api_ms` 同一口径）：长任务一轮几十上百次请求，cache_read 会累加到
  几百万，拿去当上下文就会得到「已用 9.1M / 窗口 976.6K、进度环顶满 100%」这种数
  （踩过一次）。`result` 只用来补窗口、整轮输出、**整轮输入（`turnInputTokens`，即「本轮
  消耗」）** 与 API 耗时；`plausibleContext` 再把「超过窗口」的存量值判为无效（旧版本写进
  `conversations.json` 的坏快照也靠它清掉）。
  **占用与消耗是两个数，但在界面上共用一个弹层**：入口只有底栏右侧的圆环 + 百分比
  （最近一次请求的输入侧 = 窗口还剩多少），点开依次是已用 / 窗口，一块合并的整体（会话累计的
  合计 / 输入 / 输出 + 最近一次请求的未命中缓存 / 读取 / 写入 / 命中）、生成速度与
  「累计 = 轮 · 工具 · 事件」。**弹层不报本轮消耗**（在回答下面那行小字里），也不写解释性
  小字。曾把 token 详情拆成输入框下方一颗居中胶囊，之后又并回来了：两个入口内容互相重复，
  别再加第二颗按钮。
  答里那行小字报的是**本轮消耗**（输入含缓存 + 输出），不是「输出 tok」：一轮几十次工具调用
  里输入侧占绝大多数，只报输出会让人以为没花钱。会话累计（`sessionInputTokens` /
  `sessionOutputTokens`）实时按回合滚、重开对话时用整份转录重算。
  **首轮还没跑完时弹层也要有那三行**：会话累计只在 `result` 到达时才有权威值，之前
  「合计 / 输入 / 输出」整块都是空的（手机上整轮只能看到一根占用条）。所以流式阶段按请求
  把输入侧与输出记进 `turnCounted*Tokens`（同一次请求的 start/delta 只算一遍，`result` 一到
  清空、数并进会话累计，不能相加否则算两遍），界面统一经 `usage.sessionTotals` 取数。
  **`turnCounted*` 的生命周期就是「一个回合」，任何 `result` 都要清**：中断 / 进程收尾时
  CLI 有时只给 `modelUsage`、不给 `usage`，那时即时累计是那一轮唯一的数——并进会话累计
  再清掉（不能留着，否则下一轮的即时累计接着往上加，弹层里整轮虚高上一轮那一截）。
  **底栏那行不写「Claude 正在工作」**：在不在跑由计时行（少女祈祷中）与发送键形态说清楚，
  这一行左边只留操作提示（Enter 排队 / Ctrl+Enter 插话），右边是用量；**窄屏不再折叠成只剩
  「N 轮」**——手机上底部是唯一能看到会话总量与速度的地方，折叠掉就等于移动端永远看不到。
  左半边要给 `min-w-0 flex-1`：不写的话 flex 子项按内容撑开，右侧用量会被挤出屏幕。
  **缓存命中率 ≥99% 保留一位小数、其余取整**（`lib/usage.formatCacheHit`）：高命中区间
  取整没有分辨力，99%、100% 两档看不出缓存有没有吃满；四舍五入到 100.0 的仍写 100%。
  **tok/s 用「最近一次请求」的口径**：`genMs/genTokens` = `message_start` → `message_delta`
  的到达间隔与那一次的输出（不含首字延迟）。整轮输出 ÷ 整轮 `duration_api_ms` 会把每次请求的
  首字延迟都摊进分母（实测 200 tok/s 被读成 70，误判成「模型很慢」）。上游把整段回复合并后
  才下发时（算出来超过 `MAX_GENERATION_TPS`）宁可不显示，别编速度；转录回放只能拿
  `api-request` → `assistant` 的时间差当这一请求的耗时（含首字延迟，略偏低）。
- 移动端输入框下方必须保留 `env(safe-area-inset-bottom)`，否则 iPhone Home Indicator 会盖住输入区。
- 界面文案走 `useT()`（中文 / English 两参数），默认中文；新增文案不要再硬编码单语。
- **UI 原语入库，不要重复造**：模态 `common/Dialog`、确认/输入 `common/SystemDialogs`
  （`askConfirm`/`askPrompt`）、下拉 `common/Select`、菜单 `common/Menu`、按钮 `common/Button`、
  折叠块 `common/Collapsible`、文件图标 `common/FileIcon`。
  原生 `window.confirm/prompt/alert` 与 `<select>` 一律不用：它们的配色/圆角/字号由系统决定，
  在飞牛桌面 iframe 里和主题对不上。
- **模态必须 `createPortal` 到 body**（`Dialog` 已这么做，改回去就会复现老 bug）：
  `position: fixed` 相对最近一个「建立了包含块」的祖先定位，而 `contain: paint`
  （`content-visibility: auto` 隐含它）、`transform`、`filter`、`will-change` 都算。
  消息行为离屏跳过绘制带着 `content-visibility: auto`，就地渲染的浮层会被关进**那一条消息**：
  遮罩缩成一个小方块、面板与关闭按钮一起被 `contain: paint` 裁掉，桌面上也关不掉
  （用户气泡里点开图片就是这个症状，截图复现过）。`Menu` / `Select` / `HoverPreview`
  本来就挂在 body 上，浮层一律走这条路。
- **「点外部关闭」必须听 `pointerdown`，不能只听 `mousedown`**（`Menu.useDismiss` 两个都注册，
  但**同一次按下只处理第一条**）：拖拽手柄（右侧栏分隔线）在 `pointerdown` 里 `preventDefault`
  挡住文字选中，浏览器随即不再合成兼容的 `mousedown`——只听 `mousedown` 时点/拖分隔线浮层
  既不关、也不重新定位，输入卡被拖宽了添加菜单还停在旧坐标（踩过）。两条都注册是因为老 WebKit
  只有 `mousedown`；不能不去重——一次点击会先 `pointerdown` 再补 `mousedown`，`onClose`
  会跑两次（`ModelMenu` 的关闭还带着父级状态同步）。新增浮层一律复用 `useDismiss`。

### 4.8 子代理（Agent / Task 工具）

- **子代理的对话不在主转录里**：主 jsonl 没有 sidechain 行，claude 单独写
  `<project>/<session>/subagents/agent-<agentId>.jsonl`（嵌套子代理再深一层，
  目前只读直接子级）。「查看子代理对话」只能走这条旁路（`history.LoadSubagentTranscript`）。
- **实时状态来自 `system/task_*`**（2.1.325 实测）：`task_started` 带 task_id /
  tool_use_id / description / subagent_type / spawn_depth / is_backgrounded；
  `task_updated` 只有 task_id + patch（如 `patch.status`）；`task_notification` 带
  status / summary / usage / output_file。**task_id 就是 agentId**。
- **回放只能靠 tool_result**：主转录里没有 task_* 行，Agent 的 tool_result 文本带着
  `agentId: …` 与 `<usage>subagent_tokens / tool_uses / duration_ms</usage>`，
  `subagentFromResult` 从这里补状态、用量与「查看对话」的入口。
- **子代理的正文要靠 `--forward-subagent-text` 才有**（不带时只有任务事件与最终报告）。
  这个参数只有较新版本才有，`manager.supportsFlag` 用 `claude --help` 探测一次并按二进制
  路径缓存——**不要无条件加到 `process.Args`**，旧版本会因为未知参数直接起不来。
- 打开后子代理帧带 `parent_tool_use_id` + `agent_id`，store 用 `subagentFrame` 把它们分流到
  `subagentItems[sid][agentId]`：既不能进主消息流（和过滤 sidechain 是同一类问题），
  也不能污染主会话的用量统计。子代理面板优先显示这份实时数据，没有才回落到旁路转录。
- **`tool_progress` 只更新卡片的已跑秒数**（`ToolItem.progress`），不产生新消息；
  `task_progress` 更新运行中的用量与一行摘要，状态保持 running。
- **子代理里的审批带 `agent_id`**（实测 2.1.325 的 `can_use_tool` 不带
  `parent_tool_use_id`）：`protocol.PermissionRequest.AgentID` 必须保留，
  审批面板据此标「来自子代理 X」并能跳过去。丢掉它，用户就分不清是谁在申请权限。
- **页头的「子智能体 N」从消息流现算**（`lib/subagents.ts` 的 `subagentEntries`），
  不额外存一份状态；点开列表用 `showSubagent` 打开右侧栏标签。
- **「子代理」与「后台操作」是两套东西，不能混在一个列表里**（`lib/backgroundTasks.ts`）：
  两者都发 `task_*`、都带 task_id 与 description，但子代理有转录可查看，后台命令
  （`Bash` + `run_in_background`）与 MCP 调用没有——混在一起会让页头列出几十条
  「Run full frontend tests」，把真正的子代理淹掉。
  判定只看 `subagent.taskType`：`local_agent` 是子代理，其余（`local_bash` /
  `mcp_task` …）归后台操作；**缺 taskType 时按子代理处理**（老 CLI 与转录回放给不出
  它，宁可多列也不要把子代理错当成命令）。页头因此有两个独立入口：子智能体（数量徽章，
  点开选对话）与后台操作（终端图标 + 数量，点开可中止）。
  **后台操作只列还在跑的**：它是控制面板不是历史记录，跑完即从列表消失、全跑完后
  入口图标自动隐藏；结束的后台命令仍在正文那张卡片上。
- **`task_id` 只出现在实时的 `task_started` 里，必须由后端补**：中途连上来的设备只有
  转录回放，拿不到它，界面上「进行中」的条目就发不出 `stop_task`（也是"两台设备数量
  不一致"的来源之一）。`session.Session` 用 `noteTaskEvent` 维护
  `task_id ↔ tool_use_id`（结束的摘掉），`LiveTasks()` 随 `session.snapshot` 的
  `tasks` 下发；前端存在 `useAppStore.liveTasks[sid]`，`backgroundTasks` 按 `tool_use_id`
  回填 task_id 与 description、并用它的 `task_type` 兜底分类（转录回放里没有 taskType）。
  **列表本身仍从消息流现算**，后端只补这张表——不要在 gateway 里再存一份列表。
- **重启后标题会「变成一串 agent id」是踩过的坑**：主转录里没有 `task_started`，
  `subagent.description` 拿不到；但 Agent 的 `tool_use` 入参一直带着 `description` /
  `subagent_type`，`subagentEntries` 必须回落到入参。状态/用量/agentId 则靠 tool_result
  里的 `<usage>` 与 `agentId:` 复原。
- **停止/转后台走控制请求**：`stop_task{task_id}`、`background_tasks{tool_use_id?}`；
  会话进程已被回收时网关返回 409，让前端提示重连，而不是假装停成功。

### 4.9 claude 版本管理（`internal/claudebin`）

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
- **删除版本：先结束进程，再删二进制**。生效版本仍然直接 409（它可能是下一次新建会话要用的
  二进制，这一步挡在结束会话之前——注定失败的删除不该打断对话）；非生效版本即使还有会话在跑
  也允许删，由 `Manager.CloseSessionsUsing` 把这些会话结束掉（`Close` 会等进程真正退出），
  之后才 `os.RemoveAll` 版本目录。**不要改回「有会话在用就 409」**：那等于让用户先去别处找
  那几个对话一个一个关掉；也不要只删目录不结束进程——进程会把一份已删掉的二进制继续跑在内存里，
  事后说不清它在跑哪个版本。`claudebin.Version.InUse`（`in_use`）由网关装配（`gateway.claudeStatus`
  现问 manager），claudebin 本身不认识会话；前端据此在删除确认框里说清会打断几个对话。
- **切换只影响之后新建的会话**：`manager.resolve` 每次建会话重新解析路径，已在跑的进程不重启。
- **未安装时服务必须能起来**：否则用户没有入口去装。`manager.New` 不再因找不到 claude 失败，
  建会话时才返回「请去设置 → 部署安装」。
- **`/api/info` 只在装配了部署管理时才带 `claude_installed`**：前端据此区分"确实没装"与
  "这套部署不走托管安装"，否则会弹一个装不了东西的提示。
- **后台每小时查一次新版本**：`cmd/ccweb` 的 `startClaudeUpdateWatch` 在启动时查一次、
  之后每小时一次，走的是面板里选中的下载源（`claudebin.Check` 内部按 source 取 registry），
  与手动点「检查更新」等价。失败只记日志、不推送——NAS 上内网/离线是常态。
  **定时策略在装配层，不要在 gateway 里再塞一个 ticker**：gateway 只提供
  `BroadcastClaudeUpdate()` 这个 WS 推送出口。
- **更新提示走 `/ws` 的「系统通道」**（不带 `?id`）：与会话连接分开，因为会话连接随对话开关
  （关对话、换工作区、删对话都会断），而「有新版本」跟对话无关，没有打开任何对话时也要收到。
  共用 `/ws` 而不是加一条 SSE：鉴权（`?token=`）、心跳、指数重连都已实现，且经过前置网关注入
  的验证。推送只带 `{active, latest}`（`claude.update`），前端收到后照旧拉
  `/api/claude/status`——状态里还有已安装列表与安装进度，别在前端再解析一份。
  同一个最新版本只推一次；装上或切到该版本后清掉去重标记（回滚时同版本号仍要能推）。

### 4.10 技能管理（`internal/skills`）

- **个人技能目录必须跟着 claude 的 HOME 走**：`process.CleanEnv` 把子进程 HOME 改成
  `CCWEB_CLAUDE_HOME`，所以个人技能是 `$CCWEB_CLAUDE_HOME/.claude/skills`，不是应用自己的
  `~/.claude/skills`。写错位置会「保存成功但 claude 永远看不到」。
- **只写 personal / project 两类**：它们就是文件，改完 claude 会热加载，不用重启会话。
  `synced/`（claude.ai 同步）只读——下次同步会覆盖；插件技能归 `claude plugin`；
  bundled 技能只能靠 settings 的 `disableBundledSkills` / `skillOverrides`。
- **写入必须逐层拒绝符号链接**：项目技能在工作区里，软链可以把写操作带到工作区外。
  只 `Lstat` 叶子目录不够——`MkdirAll`/`CreateTemp`/`RemoveAll` 会跟随中间层，工作区里
  一个 `.claude -> /某处` 就能让「保存技能」写到工作区外、「删除技能」删到工作区外。
  必须从工作区（个人技能则是技能根）一路 `Lstat` 到目标目录；落盘用同目录临时文件 +
  rename，避免半截 SKILL.md 被 claude 当成正文读进去。
- **删除只删 skills 根目录的直接子目录且必须含 SKILL.md**：名字来自用户输入，
  直接 `RemoveAll(root/name)` 等于把路径穿越变成删库。
- **导入是一次多条的受控读取**：`POST /api/skills/import` 的来源是飞牛选择器挑的宿主
  路径（通常在工作区之外），所以边界不在 `authorizedCwd`，而在 `skills.readSkillSource`：
  只认名为 `SKILL.md` 的普通文件（传目录则读 `<目录>/SKILL.md`），不跟软链、≤1 MiB、
  一次 ≤ `skills.MaxImport`（50）。**不要放宽成「读任意 .md / 读目录里所有文件」**——
  内容会写进技能、再经 `/api/skills/doc` 显示到界面上，那等于开一个不在授权体系里的
  宿主文件读取口。逐条返回结果（单条失败不影响别的），技能名取自目录名（传文件时取父目录名）。
  **大小上限在读取时也成立**：`os.Lstat` 与 `os.ReadFile` 之间文件还可能变大，
  读取走 `io.LimitReader(maxContent+1)`，多一个字节就判 `ErrTooLarge`，别把几十 MB 读进内存。
  浏览器里挑的文件不走这条接口：内容已经在手里，前端逐条 `PUT /api/skills/doc`
  （顺序执行，正是为了让同名覆盖的顺序可预期、单条失败不中断）；两条来源都支持多选，
  目标可以是个人技能根或已授权的工作区。
- **飞牛选择器要带 `accept`，但它只是门帘**：`pickUserFile({directory:false,
  multiple:true, accept:[".md",".markdown"]})`（`pickFnosFiles` 的 `accept` 参数，
  文档见飞牛「用户个人授权路径」）。宿主版本旧或用户绕过筛选时仍可能拿到别的扩展名，
  所以前端还会按 `isSkillFile` 再筛一次、后端 `readSkillSource` 再挡一次
  ——三层都保留，不要因为加了 accept 就删掉后两层。
- **项目技能按所选工作区读写**：设置页「项目」分组与新建表单里都有工作区下拉
  （与 MCP 共用 `frontend/src/lib/workspaceTarget.ts`），不跟「当前对话在哪」；
  用户选过就不再被上层 cwd 覆盖，目标工作区被移除时回落默认值。后端不变，
  `/api/skills*` 仍按传入 `cwd` 工作并过 `authorizedCwd`。
- 技能名同时是 `/命令名`：不允许分隔符、点开头、`<`/`>`、控制字符与零宽字符，
  `synced` 是保留名（与 claude 的加载规则一致）。
- 新建一个此前不存在的顶级 `.claude/skills` 目录时，claude 没在监听它，
  需要 `/reload-skills` 才生效（已有目录内的增删改是热加载的）。

### 4.11 MCP 管理（`internal/mcp`）

- **真源是两份文件**：用户级 `$CCWEB_CLAUDE_HOME/.claude.json` 的 `mcpServers`
  （注意是 claude 子进程的 HOME，不是宿主机 `~/.claude.json`），项目级
  `<工作区>/.mcp.json` 的同名字段。`claude mcp add` 是交互式命令，本项目没有终端给它。
- **`.claude.json` 只碰 `mcpServers`**：它是 claude 自己的状态文件（projects / 计数器 /
  迁移标记），用 `map[string]json.RawMessage` 读写，其他键保留原始字节；换成
  `map[string]any` 会把数字改成浮点、把未知结构重排。
- **写入要逐层拒绝符号链接**（从 claude HOME 或工作区起算），并原子替换（同目录临时
  文件 + rename）：工作区里一个 `.mcp.json -> /某处` 就能把写操作带到工作区外；写到一半
  被 claude 读到就是「配置损坏」。
- **项目级作用域按工作区选，不跟「当前对话在哪」**：设置页「项目级」旁边有一个工作区
  下拉（`McpSettings` 的 `target`），「添加/编辑」弹窗里也有一个（同一个状态），
  默认取活动对话所属的工作区，用户改过就不再被上层 `cwd` 覆盖；那个工作区被移除时回落
  默认值。多工作区下「把这条服务加到另一个目录的 `.mcp.json`」是常态，靠活动对话隐式
  决定目标只会让人反复切对话。**编辑已有条目时工作区下拉锁定**（换目录等于搬走一条现成
  配置，界面没有这个语义，要换就删了重加）。后端没变：`GET/POST/DELETE /api/mcp`
  仍然按传入的 `cwd` 工作，网关照旧过 `authorizedCwd`。
- **停用 = 把整条配置摘到本应用自己的暂存文件**（`CCWEB_DATA_DIR/mcp-disabled.json`），
  启用再原样写回。不用 claude 的 `disabledMcpjsonServers`：那个只对项目级生效，用户级
  没有官方开关，两种作用域要同一套语义。代价是停用期间外部工具看不到这条配置。
- **暂存条目必须记归属工作区**（`stashEntry.Cwd`，用户级为空；匹配按 `scope+cwd+name`）：
  只记 `scope+name` 时，A 里停用的服务会出现在 B 的列表里，在 B 点「启用」就把 A 的命令
  写进了 `B/.mcp.json`，A 那条再也回不来；两个工作区各停用一份同名服务时还会互相覆盖。
  旧版本写的条目没有 `cwd`，读的时候按「处处匹配」处理（否则升级后凭空消失），
  下一次编辑/启用把它绑到一个具体工作区。
- **探测只认已保存的服务名**（scope+name），绝不接受请求里带命令进来——那等于给接口
  开了「免审批执行任意命令」。stdio 走一次 `initialize` JSON-RPC；http POST 一帧
  initialize；sse 只看握手。探测是面板自己的出站请求，必须接 `netproxy`（`SetProxySource`）。
- **探测失败要说真原因**：stdio 服务在 `initialize` 之前就退出时（命令不存在、缺依赖），
  原因只在 stderr 里——不要把它糊成「JSON 解析失败」；http 回 200 但不是 JSON-RPC
  （地址填成了普通网页）也必须算失败，否则用户以为配好了，直到会话里工具全不可用。
- **「读整份配置 → 改 → 写回」必须串行**（`Manager.mu`）：两个标签页同时增删会互相覆盖，
  表现为「删了一条，另一条还在」。
- **改完不会热加载**：MCP server 在会话启动时连接，界面与文档都要说「重开会话才生效」。
- **内置服务只留探测与启停**（自动化任务的 `ccweb-schedule`）：`EnsureScheduleMCP` 每次启动
  都会把它写回 `.claude.json`，所以「编辑 / 删除」必然是假的——改完下次启动被覆盖、删掉下次
  启动又原样长回来，中间那段时间只是让模型白丢那三个工具。`GET /api/mcp` 给它打 `builtin`
  标记（网关算，`internal/mcp` 不认识「哪些名字是内置的」），前端据此不给编辑/删除按钮，
  `POST /api/mcp` 与 `DELETE /api/mcp` 也都回 409。想临时关掉用「停用」（写进暂存文件，
  重启后保持）。内置搜索那条**不能**这么处理：它的「解除」本来就是删配置
  （`search_api.go` 的 Detach）。
- 服务名会成为工具前缀 `mcp__<名字>__<工具>`，所以名字只允许 `[A-Za-z0-9._-]`；工具卡片
  仍然靠 `GenericCard` 兜底渲染，不要为某个 server 写专用卡片。

### 4.12 内置搜索（`internal/search` + `ccweb mcp-web`）

- **走 DeepSeek 的 Search / Fetch API，一次 HTTP，不花模型回合**：`POST {base}/search`
  `{query,count,need_content:false}` → `results[]`（title/url/snippet/summary/date）；
  `POST {base}/fetch {url}` → 页面 Markdown。base 默认 `https://api.deepseek.com/v1/tools`，
  可填自建网关的完整前缀（含 `/v1/tools`，不含 `/search`）。
- **密钥与对话密钥分开**（`search_api_key`）：搜索按次计费，不能默认复用对话密钥。
  与提供商密钥同样的语义：空串=沿用旧值，清空要 `clear_search_key`。
- **注册形态是用户级 MCP 服务**：`mcpServers["ccweb-web"] = {command: <本二进制绝对路径>,
  args: ["mcp-web"], env: {CCWEB_DATA_DIR, CCWEB_SETTINGS_FILE}}`。不要换成
  Claude Code plugin：那要走 marketplace 与 `claude plugin`，本项目没有这条链。
- **`ccweb mcp-web` 的 stdout 是协议通道**（换行分隔的 JSON-RPC 2.0）：任何日志只能写
  stderr，往 stdout 打一行字就会让 claude 侧解析失败。
- **工具错误作为工具结果返回**（`isError: true` + 可读原因），不要发 JSON-RPC error：
  模型看不见 JSON-RPC 错误，只能干等；而 401 / 「未启用」这类信息它自己就能改。
- **每次工具调用现读 settings.json**：界面上改基地址/密钥不用重开会话（子命令进程还在）。
  但**注册与移除要重开会话**——MCP server 是会话启动时连接的。
- 搜索输出必须限长（结果 6k 字符 / 抓取 40k 字符，按 rune 截断）：这是直接进主对话
  上下文的内容，塞满就毁了会话。
- 内置搜索的 HTTP 请求同样要接 `netproxy`（`search.SetProxySource`），否则「配了代理但
  搜索不通」。**`ccweb mcp-web` 这个子命令要自己接**：它是独立进程，主进程里那套
  `SetProxySource` 不会继承过来（`http.ProxyFromEnvironment` 只读启动时的环境变量）。
- **定位 `settings.json` 复用 `config.Load`**，不要手拼路径、更不要用相对路径兜底：
  子进程的 cwd 是用户的工作区，`data/settings.json` 会去读工作区里那份文件。
- **MCP 工具默认是"延迟加载"的（2.1.325 起）**：默认开着 tool search，MCP 工具**不进**
  请求的 `tools` 数组，只在一条 system-reminder 里**一行一个裸名字**列出来（内置
  `WebSearch`/`WebFetch` 也在同一份名单里，实测 12 个工具 + `ToolSearch` +
  `DeferredToolPlaceholder`）。模型看到的不是「这是个搜索工具」，而是字符串
  `mcp__ccweb-web__web_search`——所以「让模型知道能用搜索」过去只能靠用户 CLAUDE.md 硬写。
  修法：注册时写 **`alwaysLoad: true`**（claude 配置字段，等价 API 的 `defer_loading:false`，
  实测工具带上描述直接进 `tools`，其余内置照旧延迟）。工具**描述**因此要写触发条件，
  不能只写「这是什么」；这是模型唯一的判断依据。
- **会话层的两条工具规则由装配层注入，不改用户的 settings.json**：`--disallowedTools
  WebSearch,WebFetch`（内置那两个在自建中转下走服务端工具通常调不通，却会和 MCP 那条抢
  选择；实测连延迟名单里都会一并消失）+ `--allowedTools mcp__ccweb-web__web_search,…`
  （MCP 工具默认要过 `can_use_tool`，每搜一次弹一次审批之后模型就学会不用它了；代价是
  它会自己花搜索费）。注入口是 `manager.SetToolRules`，**条件必须是「搜索已启用」且
  「这条 MCP 真的注册了」**——否则等于把内置搜索挡掉却换不上任何东西，比原来更糟。
- **`always_load` 只写 true、不写 false**（false 是默认语义），但**老版本注册的条目没有
  这个键**：`GET /api/search` 的 `always_load` 就是给前端提示「补上常驻」用的，
  别把它当成 `attached` 的重复字段。

### 4.13 插件管理（`internal/plugin`）

- **claude 是唯一真源**：插件状态分散在 `$CCWEB_CLAUDE_HOME/.claude/settings.json`
  （`enabledPlugins` / `extraKnownMarketplaces`）、`.claude/plugins/installed_plugins.json`
  （现在 `version: 2`）、`known_marketplaces.json` 与 `plugins/cache/<市场>/<插件>/<版本>`，
  格式随 claude 版本漂移。**不要像 MCP 那样手写这些文件**——`claude plugin` 自带非交互接口
  （`--json` 输出结构化结果、`-y` 跳过确认），无 TTY 可用，实测全部动作都能拿到结论。
- **每个变更动作都会读改写同一批配置**：网关用**单槽任务**（`pluginJob`）串行化，并发请求回 409。
  克隆/刷新在 CLI 内部有 120s 上限，同步接口会被浏览器与前置网关掐断，所以接口立即返回
  「已接受」，前端轮询 `GET /api/plugins` 的 `job.phase`。
- **`plugin list --available` 不挂在「打开设置页」的同步路径上**：首次可能联网抓目录（十几秒）。
- **代理要显式注入**：`plugin.SetProxySource` 接设置里的代理。实测无代理时
  `marketplace add https://github.com/…` 报 `GnuTLS recv error (-110)` 并白等 90 秒；
  接上后同一仓库 6.7 秒完成 sparse clone。子进程是独立进程，不继承主进程那套设置。
- **裸 `owner/repo` 会被 CLI 当 SSH**（`git@github.com:…`），而 claude 的 HOME 里通常没有
  `known_hosts`，必然 `Host key verification failed`。`NormalizeSource` 统一补成 https，
  并拒收 `git@` / `ssh://` 形式。
- **市场名 ≠ marketplace 来源**：CLI 的 `--marketplace` 只接受 owner/repo|URL|路径。界面点
  「安装」拿到的是 `名字@市场`，后端必须还原成完整 id 且不传 `--marketplace`（照抄会 400）。
- **插件就是可执行代码**：`plugin.json` 里能声明 `hooks`（会话事件里跑命令）与 `mcpServers`
  （起进程），而 `install -y` **不会**为这类插件弹确认（只有 command-source 才有
  `shownCommand` + `--accept-command`）。所以界面必须展示组件清单：`plugin details` 给
  已安装插件的清单与 token 成本，未安装的只能读清单文件（`Manager.Inspect`，并拒绝
  `source` 把路径带出 marketplace 目录）。不要把 `-y` 包装成「永不再问」。
- **project 作用域靠 cwd**：写在 `<工作区>/.claude/settings.json`，所以必须先过
  `authorizedCwd`，并用 `Manager.WithDir(cwd)` 在那一层跑命令；user/local 不需要工作区。
- **生效时机与会话一致**：插件在会话启动时加载，「装/停用/更新之后要重开会话」，与 MCP 同一条规矩。
- **可安装目录必须"缓存优先 + 服务端分页"**：官方市场实测 **3743 条 / 全量 JSON 1.27 MB**，
  每次打开设置页都拉一遍既慢又白占内存。现在的分层是：
  ① CLI 自己会把目录缓存到 `$HOME/.claude/plugins/plugin-catalog-cache.json`，之后
  `plugin list --available` **离线 1.2s** 就能出结果（只有首次抓目录要联网、约 13s）；
  ② 面板把读到的目录落盘到 `CCWEB_DATA_DIR/plugins-available.json`（带 claude HOME，原子写），
  进程启动/重进设置页先读它；没有缓存时 `GET /api/plugins` **只自动补一次**（每进程一次，
  失败留给用户点「刷新」）。**刷新失败只更新 `note`、必须保留上一次的目录**：离线是常态，
  清空的话界面上 3743 条会凭空变成 0，而 `pluginAvailLoaded` 已是 true、不会再读回落盘缓存，
  只能重启进程恢复。前端靠 `available_note` 说清「为什么这里是空的」；
  ③ HTTP 只回一页：`GET /api/plugins` 给 `available_total`，明细走
  `GET /api/plugins/available?q=&market=&hide_installed=&offset=&limit=`（默认 20、上限 100），
  过滤与翻页都在服务端内存里做。实测：主接口 284 字节 / 一页 6.4 KB。
- **版本耦合**：`plugin` 子命令与状态文件版本都跟 claude 版本走。`Support()` 跑一次
  `plugin list --json` 并按二进制路径缓存：**CLI 给得出 JSON 就算支持**（报错也属支持，
  把原因显示出来），连 JSON 都给不出（unknown command）才整页置灰——否则用户永远看不到真实错误。

### 4.14 插话 / 待发送队列（`lib/queue.ts` + `store.queued`）

- **协议事实**：回合进行中往 stdin 再写一条 user 帧是被接受的，不会报错、不会丢，pipe 也不关。
  落点由帧上的两个字段决定（Agent SDK 的 `SDKUserMessage`）：
  `priority` = 缺省/`next`（本轮工具调用结束后就读）、`later`（等本轮结束当新的一轮）、
  `now`（立刻）；`origin: {kind:"human"}` 声明「这条是用户亲手打的」。
  **`priority=now` + `origin=human`（CLI ≥ 2.1.286）才是真正的插话**：能后台化的工具
  （shell 命令、子代理、MCP 调用，2.1.287 起还有 WebFetch/WebSearch）被挪到后台，消息
  **并入当前回合**；挪不动或模型正在写正文时，CLI 改为中断本轮。本轮已收尾时 CLI 先发
  `result`、再发 `system/init`，把消息当新的一轮跑。
- **只写裸 user 帧而不带 `priority`/`origin`，表现就等同于排队**：CLI 按默认的 next 处理，
  要等本轮工具收尾才轮得到。曾经被报「工具操作中插话没生效」就是这个原因——
  `PromptInterject` 现在固定写 `priority=now` + `origin=human`，普通 prompt（含排队投递）
  只带 `origin=human`。改这条链路时先看 `protocol.PromptOptions` 的注释。
- **CLI 不回显被并入的消息**（没开 `--replay-user-messages`）：所以用户气泡只能本地乐观插入，
  转录里的位置可能和界面上略有出入——别为了「对得上」去开 replay，那会让同一条消息显示两遍。
- **交互**：回合进行中按 Enter = 入队（草稿清空，消息进输入框上方的「待发送」面板）；点正文
  **就地展开编辑框**（Enter 保存、Shift+Enter 换行、Esc 取消，位置不变；正文与附件都清空等于删掉
  这条，附件在编辑态里可逐个移除）；右侧垃圾桶一键删（编辑态里也有「删除」，不必先保存空文本）；
  右侧箭头立即发。Ctrl/⌘+Enter = 立刻插话（直接写 stdin）；空闲时 Enter 仍然是直接发送。队列里还
  压着消息时，新消息一律排队尾：否则会插到先提交的那条之前。
- **进行中且有草稿时，右下角主按钮从「中断」换成「发送（排队）」**（`hasDraft`）：手机键盘的回车
  是换行，没有这个按钮就等于没法插话；中断退成旁边的 28px 深色小圆钮（`.send-button.is-compact`），
  打着字也照样能停。草稿清空后按钮自动换回单一的中断。
- **正在编辑的那条要按住自动发送**（`store.setEditingQueued` + `editingQueuedId`）：这一轮结束时
  如果队首正在被编辑，跳过这次自动发送并记进 `flushPending`，编辑结束（保存或取消）再补发。
  少了这一步，用户改到一半就会被发出去——发的是**旧文本**，改动一起丢。
- **投递规则**：一次只发队首（并发会打乱上下文顺序）。**只有「本轮正常结束的 `result`」触发
  自动发送**（`lib/queue.shouldFlushAfter`：`is_error` 或 subtype 带 interrupt/abort/cancel 时不发）。
  被中断 / 出错时队列留着，面板上的箭头按钮可以手动逐条发。**不要用 `session.state ready` 或
  切对话去触发**：状态事件在 `result` 之前到达，分不清是正常结束还是中断，会把用户按 Esc 时
  暂停的队列偷偷放出去。
- **队列跟着对话走**：`queued[sid]`，`activeId` 不是它时不发（切回来再看）。上限 8 条、只在内存里
  （刷新页面会丢）。删对话时 `purgeSession` 一并清掉。**输入框正文相反**：按对话存 localStorage
  （`lib/drafts.ts`，只存正文；附件与队列不落盘），重进前端还在——会话建好时把「新对话页」
  按工作区存的那份迁到新 id 下，删对话时一并清掉。
- **后端要认「result 之后的 init」**：那条 init 意味着 CLI 自己在跑新一轮，`session` 里
  `protocol.IsTurnInit` + `resultAt`（`TurnHandoffWindow`）把它标回 busy。不认的话界面会在整轮里
  显示空闲（发送按钮而不是中断按钮），待发送队列也会被提前放出去。

### 4.15 端口访问、密码摘要与登录会话

- **同一个 mux、两个根 handler**：`Handler()`（unix，`CCWEB_BASEURL` 前缀）与
  `TCPHandler()`（TCP，根路径）。通道与有效 baseurl 都放进 request context
  （`channelOf(r)` / `s.baseOf(r)`），SPA 注入 `<base>`、`/api/info` 的 `base_url` /
  `auth_required` / `auth_mode` / `channel` 全部按请求回答——**不要**改回读全局 `Cfg.BaseURL`
  或全局 `Guard.Required()`：同一个进程里 TCP 要登录、unix 免密，全局答案必然是错的。
- **端口访问默认关闭**：`settings.tcp_enabled` 默认 false，只有开启后 `ListenAndServe`
  才 bind TCP；开启必须已有密码，否则 `Apply`/`PUT /api/settings` 都直接 400。
- **密码只存摘要**：`authz.HashPassword` 产出
  `pbkdf2-sha256$<iter>$<salt>$<key>`（随机盐）；`settings.json` 只有 `tcp_password_hash`，
  `Public` 只回 `tcp_password_set`。密码不能当 Bearer 用：唯一接受明文的是
  `POST /api/auth/login`，它校验摘要后发随机会话令牌（`Guard.NewSession`，有效期
  `SessionTTL`=7 天，仅进程内存）。浏览器 localStorage 里存的是令牌，不是密码。
  `CCWEB_AUTH_TOKEN` 仍然可以直接当 Bearer；`/api/auth/login` 也会原样接受它并回同一个值，
  否则启用令牌的旧部署会卡在鉴权页（令牌本身只能当 Bearer，没法存成密码）。
- **注销**：`POST /api/auth/logout` 只吊销请求里自带的会话令牌（无令牌/已失效也回 200，
  便于前端在任何情况下清本地凭据）。侧栏底部在 `info.auth_required` 时显示「退出登录」，
  点击后清 localStorage 并整页重载回鉴权页。环境变量令牌不是会话，注销不会让它失效
  （清掉本地值后仍可用同一令牌重新登录）。
- **改密码/关端口必须让旧会话失效**：会话里记录签发时的摘要指纹，摘要一变自动失效；
  关闭端口访问时 `Guard.ClearSessions()` 让令牌立刻失效，并 `StopTCPGracefully`：
  **立刻关闭 listener**（端口可立刻重开），500ms 后再 `http.Server.Close()` 断开已有连接
  （含 WebSocket）——先把本次响应发出去，否则正在用 TCP 的管理员只会看到「请求失败」。
  **不要用「延迟执行一次 `CloseTCP`」**：那会把 500ms 内重新开启的新 listener 一起关掉。
- **`CloseTCP` 要连活动连接一起断**：换端口只关旧 listener（页面不被踢），但关闭端口访问
  是安全动作，必须 `http.Server.Close()` 掉当前与所有 retired server（含 WebSocket）。
  只关 listener 的话，已经打开的页面会继续可用，直到自己断开。
- **密码复杂度在 `authz.ValidatePassword`**：≥8 位、同时含字母与数字、不含控制字符；
  前端 `lib/password.ts` 是同一规则的镜像，只做即时反馈，后端仍然独立校验。
- **端口 = 设置项，不是环境变量**：默认 3141（`settings.DefaultTCPPort`），
  范围 **1025–65535**（`settings.MinTCPPort/MaxTCPPort`；1024 及以下是特权端口）。
  开启/换端口必须**先 bind 成功再落盘**（`PUT /api/settings` 先 `ListenTCP` 再 `Apply`，
  端口冲突/权限不足时回 400，设置不变、旧监听保留），否则配置里躺着一个起不来的端口，
  重启后照样坏。
- **TCP 起不来不能让进程退出**：否则用户进不了设置页改端口。`ListenAndServe` 只记日志，
  真实状态通过 `/api/info` 的 `tcp_listening` / `tcp_error` 给「设置 → 访问」。
  其它设置页的保存不碰监听（只有补丁带 `tcp_enabled`/`tcp_port` 时才动作），
  否则「上次端口没绑上」会把改模型之类的保存也连带报错。
- **前端凭据跟着通道走**：改密码后，若当前是 TCP 通道（`info.channel === "tcp"`），
  AccessSettings 会用新密码重新登录换令牌；unix 通道用的是环境变量令牌，
  绝不能拿访问密码覆盖它（unix 不认它，覆盖等于把自己锁在外面）。服务重启后会话失效，
  鉴权页会重新要求输入密码——这是刻意的（令牌不落盘）。
- **想只绑本机用 `CCWEB_TCP_HOST=127.0.0.1`**（默认所有网卡）；TCP 是明文 HTTP，
  跨不可信网络要加 HTTPS 反代。

### 4.16 输入框 `@` 文件引用（`lib/mention.ts` + `GET /api/fs/complete`）

- **语法与 DSH 的 file-reference grammar 同一套**：`@` 只在行首或空白之后才触发
  （`user@example.com` 不弹菜单）；路径含空格写成 `@"my file.ts"`；目录引用以 `/` 结尾，
  引号**故意保持打开**（`@"my dir/`），这样 Tab 还能继续往下钻。规则全部在
  `frontend/src/lib/mention.ts`（纯函数、有单测），组件里不要再手写一套正则。
- **模式判定在后端**（`fsapi.Root.Complete`）：查询里出现过 `/` 就只列那一层
  （`src/co` → 列 `src/` 并按 `co` 过滤）；否则在工作区内做有界遍历（`completeMaxEntries`
  8000 条预算）按名字/路径模糊打分。两种模式都跳过 `node_modules`/`dist`/`build` 等目录
  （`completeSkipDirs`，与 DSH 同一份名单）和隐藏项（查询本身以 `.` 开头时才显示），
  **不跟随符号链接**、不离开工作区。目录不存在/越界时回空候选而不是错误——用户还在打字。
- **选中的值就是正文里的 `@相对路径`**：补全只索引路径，不读文件内容——内容仍留给模型
  用 Read 工具去读。别为了「省一次工具调用」把正文塞进上下文。
- **键盘必须先被菜单仲裁**（`useMention.handleKey`）：`Tab` = 进入目录（唯一的下钻手势，
  触屏点行尾的 `Tab` 提示），`Enter` = 引用，`↑↓` = 选候选，`Esc` = 关菜单。
  少一步就会变成「Tab 把焦点移走」「Enter 把半截 `@查询` 直接发出去」。候选还在路上
  （loading）时不许插入上一轮的行；`Esc` 关掉的 token 不能因为重渲染又弹回来。
- **「从飞牛选择」只在飞牛宿主里出现**（与 `+` 菜单同一个宿主选择器 `pickUserFile`）：
  判定是 `lib/fnos.canPickFnos`（在宿主内 **且** 不是 TCP 直连端口通道，与页头
  「在飞牛打开工作区」同一条规则）——不在宿主里时这一行不摆，摆了也只会得到
  「当前不在飞牛宿主中」。图片/PDF 仍走 `/api/fs/host-file` 转附件，其余类型写成
  `@绝对路径` 并**顶掉**用户敲下的 `@查询`。这一行与查询无关，候选没回来时也能点。
- 接口 `GET /api/fs/complete?cwd=&q=&limit=` 必须挂 `s.authed` 并过 `authorizedCwd`，
  与 `/api/fs/tree` 同一条围栏；前端请求在 `useAppStore.completePaths`（带 `AbortSignal`，
  下一个按键到来时取消上一次）。

### 4.17 任务清单 / 长期任务（`lib/tasks.ts` + Tasks API）

- **Tasks API 在较新版本上默认是关的**：2.1.233 起，除了老模型（`claude-opus-4-7` 及更早）
  之外，`CLAUDE_CODE_ENABLE_TODO_TOOLS` 不为真时 `TaskCreate`/`TaskUpdate`/`TaskList`/
  `TaskGet` 与 `TodoWrite` **都不出现在 tools 里**（实测 2.1.327：不加变量时模型看到的
  工具名单里一个都没有，加 `=1` 才出现）。`manager.start` 固定注入这个变量——
  少了它面板永远是空的，而且没有任何报错可看。
- **任务落盘在 `$CCWEB_CLAUDE_HOME/.claude/tasks/<listId>/<id>.json`**，`listId` 默认是
  会话 cwd 的净化路径（`[^a-zA-Z0-9_-]` → `-`），所以同一工作区的多条对话共享一份；
  `CLAUDE_CODE_TASK_LIST_ID` 可以钉死它。带 `blocks`/`blockedBy` 依赖。
- **面板从消息流现算，不读那些文件**（`frontend/src/lib/tasks.ts`，纯函数 + 单测）：
  面板要回答的是「这条对话在做什么」，回放转录拿到的也是同一批 tool 消息；
  读磁盘会把别的对话留下的任务一起翻出来。结果文案按 CLI 自己的格式解析
  （`Task #<id> created successfully`、`Updated task #<id> …`、TaskList 的
  `#1 [pending] 标题 [blocked by #1]`），`tool_use_result` 的结构化字段
  （`taskId` / `statusChange.to`）优先。`TodoWrite` 是整份快照，出现就替换列表。
- **面板默认收起**（`components/chat/TaskPanel`，对齐 DSH）：标题只报数量
  「已完成 · 进行中 · 待完成」（那一档为 0 就不出现），展开才是清单。**完成项不划线**——
  灰字 + 对勾已经区分得开，划线会让一屏已完成的任务看着像被作废。
- **任务清单工具固定进 `--allowedTools`**（`manager.sessionToolRules`）：一轮里可能被改写
  十几次，落进审批面板就是十几张卡，用户会先放弃这个能力；它们只写 claude HOME 下的
  `tasks/*.json`，不碰工作区。
- **`/goal` 是另一套东西，界面还没接**：它是 session 级的 prompt Stop hook（每轮结束由一个
  独立的小模型判定条件是否满足），状态只写在转录的 attachment 消息里
  （`{type:"attachment", attachment:{type:"goal_status", met, sentinel, condition}}`），
  达成时的条目另带 `iterations`/`durationMs`/`tokens`。要接得先确认 stream-json 会不会
  把这条 attachment 转发给客户端——没验证过之前不要凭 `/goal` 的用户消息猜状态。

### 4.18 自动化任务（`internal/schedule` + `/api/schedules` + `ccweb mcp-schedule`）

- **宿主级，不是 claude 的 cron**：claude 自己的 `CronCreate` / `ScheduleWakeup` / `/loop`
  是 **session-scoped**（二进制里 SDK 字段的原话：`cron tasks … that will wake this session
  later`），只能在原会话被唤醒，没有跨会话列表、暂停/恢复、运行记录，也不能新建对话。
  所以调度、存储、投递目标都由宿主负责；claude 只负责收到消息后干活。
- **一份文件 `schedules.json`**（`CCWEB_SCHEDULES_FILE`，默认在数据目录）。`Store` 每次操作前
  按 `mtime`/`size` 重新加载——主进程与 `ccweb mcp-schedule` 子命令是两个进程，只读一次
  启动快照会互相覆盖。写盘仍是 tmp + rename；`Update` 在落盘失败时回滚内存。
- **规则 7 种 + cron**：once / minutes / hours / daily / weekdays / weekly / monthly / cron
  （5 字段，支持 `*/n`、区间、列表；日与周同时受限时按标准 cron 取「或」）。**刻意不引
  RRULE 库**：零依赖是本项目的硬约定，引导式 + cron 覆盖实际用法。时区是 IANA 名，
  空表示服务器本地时区；`Next(after)` 是纯函数，永远从「现在」往后算——
  停机错过的时段不逐条补投，一次性任务照投那一次，重复任务只算下一次。
- **投递目标三种**：`conversation`（指定对话）、`new-reuse`（首次新建后一直复用）、
  `new-each`（每次新建，标题 `任务名 · MM-DD HH:MM`，时区取规则的）。归档或删除的对话
  拒绝投递；已在跑的会话直接复用，没有转录的走 `StartFresh`，工作区必须过
  `ensureCwdAuthorizedReal`。新建对话后往系统通道推 `conversations.changed`，
  前端收到就刷新列表（定时任务常常在没有任何面板打开时建对话）。
- **投递的会话没人打开，所以回合结束还要再推一次**：投递那一刻列表里是「刚新建、
  没有转录」（前端显示「新对话」）、state 是 busy（显示转圈）；标题取自转录首条消息、
  live/state 也只有 `GET /api/conversations` 现算，没人再拉就**永远停在转圈上**
  （任务其实早跑完了，点开那条对话或刷新页面才恢复）。现在 `DeliverScheduledTask`
  在 `Prompt` 之后 `watchScheduledTurn`，装配层（`cmd/ccweb` 的事件出口）把
  `session.state=ready` / `closed` 交给 `Server.NoteSessionState/NoteSessionClosed`：
  消耗标记 → 补写标题 → 推 `conversations.changed`。只认记过的会话，普通对话的
  回合结束不会让每个连接去重扫一遍转录。**标题也在这一刻补写**：`StartFresh` 之后
  `hasTranscript` 往往还是 false（CLI 异步落盘），投递时写不进 `conversations.json`，
  不补的话每次新建的对话都叫「新对话」、`任务名 · MM-DD HH:MM` 永远落不下。
  前端系统通道**重连**时也补拉一次列表（断线期间可能正好跑完一条）。
- **同一条任务两次投递至少间隔 1 分钟**（`schedule.MinDeliveryGap`），「立即执行」只是
  额外投一次，**不改计划时间**；投递失败也推进下一次并记原因——否则工作区被删这类
  永久失败会每 30 秒刷一次。每条任务保留最近 `MaxDeliveries`（50）条投递记录，
  它只确认「消息进了对话」，不代表模型做完。
- **路由**：`GET/POST/PATCH/DELETE /api/schedules`、`POST /api/schedules/action`
  （pause / resume / run）、`GET /api/schedules/deliveries`，全部 `s.authed`。
  工作区没授权回 403（与 `/api/session` 一致），修改带 `expected_updated_at` 做乐观并发。
  「立即执行」在 goroutine 里跑并**立即返回**：投递要起会话、写 stdin，不能挂在 HTTP 请求上。
- **模型入口是 MCP**（`ccweb mcp-schedule`，工具 `schedule_create` / `schedule_list` /
  `schedule_edit`），不是 plugin。启动时 `EnsureScheduleMCP` 幂等注册到用户级
  `mcpServers`（配置没变就不写 `.claude.json`），带 `alwaysLoad`（延迟加载只发裸名字，
  模型认不出这是「建提醒」），并在 `SetToolRules` 里放行这三个工具——否则每建一条
  弹一次审批，模型很快就学会不碰它。工作区默认取子进程 cwd（会话就在用户的工作区里）。
- **界面**：侧栏「自动化任务」入口在**「历史记录」之上**（展开态与收起态都有），
  打开后是整页视图（`SchedulePage`，而非弹窗）——列表 + 编辑两态：列表按计划时间排序、带状态与规则摘要；编辑页有名称/内容/
  执行位置/关联工作区/运行时间（引导式控件 + cron 文本框）、保存/暂停恢复/立即执行/删除、
  最近投递记录。时间规则文案与本地时间换算在 `lib/scheduleRule.ts`（纯函数、有单测）。
- **没做的**：一条任务的投递如果正赶上目标会话在跑，就是普通写入 stdin（并入下一轮）；
  没有 DSH 那种「排队中禁用编辑」的会话级锁。运行时长的统计、跨设备通知也都没有。

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
- [ ] 新 HTTP 路由是否挂了鉴权？WS 是否校验 token？鉴权判定是否用了 `channelOf(r)`（而不是写死通道）？
- [ ] 改动 `protocol` 后是否同步了 `session` 与前端 `transport/types.ts`？
- [ ] 新增工具卡片是否注册进 `ToolCardHost`，且未删除兜底？
- [ ] 流式路径是否仍满足「替换而非追加」？
- [ ] 对话恢复是否用稳定 UUID `--resume`？空对话/归档/删除是否会被误恢复？
- [ ] 转录回放是否过滤 sidechain/meta，并保留原始时间戳？被截断（20k 行 / 16MB）时有没有提示？
- [ ] 新增右侧栏路由是否过了 `authorizedCwd` / 路径围栏？raw 预览是否仍在白名单？
- [ ] 右侧栏标签切走、收起整条侧栏时是否都只隐藏不卸载（终端 PTY 不能被杀）？Git 是否仍只 pull？
- [ ] 终端是否仍走二进制帧、多开时每个标签各自一条 WS？
- [ ] 改动了待发送队列的投递时机？确认仍然只有「正常结束的 result」触发自动发送（中断/报错不发）。
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
