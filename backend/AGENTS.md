# backend/AGENTS.md — Go 后端规范

## 1. 分包即子域

每个包是一个**边界明确的子域**，只能向下依赖（见根 `AGENTS.md` 的分层表）：

```
cmd/ccweb            装配层：读配置 → 建 hub → 建 manager → 建 gateway → 等信号
internal/config      环境变量解析（唯一允许读 os.Getenv 的地方，测试除外）
internal/gateway     HTTP/WS 入口、baseurl 剥离、路由、SPA、鉴权中间件
internal/wsframe     WebSocket 帧编解码（零依赖，服务端视角）
internal/hub         topic → 订阅者集合的广播
internal/agent/protocol   stream-json 编解码与消息构造（纯函数）
internal/agent/process    定位 claude、拼参数、净化环境、启动进程
internal/agent/session    单会话状态机（握手/轮次/审批/中断）
internal/agent/manager    会话池、上限、空闲回收
internal/history     转录摘要 + 按 id 回放原始事件行 + 子代理旁路转录
internal/project     工作目录枚举/校验、目录浏览器
internal/workspace   授权目录 + 当前工作区（workspaces.json）
internal/conversation 对话元数据（conversations.json：归档/删除/重命名/最近活跃）
internal/fsapi       工作区内文件树/文本预览/原始字节（路径围栏 + 符号链接校验）
internal/gitctl      Git 面板后端：repos/status/diff/stage/commit/log/branch/pull
internal/terminal    Linux PTY 会话（/dev/ptmx + ioctl，零依赖）
internal/authz       token 鉴权
internal/settings    持久化配置（第三方端点/密钥/模型）+ 端点探测
internal/claudebin   claude 版本管理：npm 平台包下载、sha512 校验、按版本目录隔离与切换
internal/skills      技能管理：SKILL.md 的列出/读写/删除（个人 + 项目，synced 只读）
internal/mcp         MCP 配置：用户级 .claude.json / 项目级 .mcp.json 的读写、停用暂存、连通性探测
internal/plugin      插件与 marketplace：驱动 `claude plugin --json`（真源是 CLI，不碰状态文件）
internal/search      DeepSeek Search / Fetch API 客户端（内置搜索用；一次 HTTP，不花模型回合）
internal/webui       go:embed 前端产物
```

**新增能力先问：它属于哪个子域？** 想不清楚就不要往 `gateway` 里塞。

## 2. 编码规范

- **注释用中文**，解释「为什么」而不是「做了什么」。踩过的坑必须写进注释，否则会被下一个人改回去。
- 错误一律 `fmt.Errorf("包名: 做什么: %w", err)`，便于 grep 与 `errors.Is`。
- **不要引入第三方依赖**。当前 `go.mod` 零依赖是刻意的：wsframe 手写、SPA 手写、
  鉴权手写。需要新依赖先讨论。
- 导出的类型/函数必须有文档注释，首行以名字开头。
- 并发：共享状态用 `sync.Mutex` + 明确的字段注释；**不要在持锁时做 I/O**
  （`manager.reapIdle` 就是先在锁内收集受害者再在锁外关闭）。
- 超时：所有网络/进程写操作都要有上限（`writeTimeout`、`InitTimeout`、`WriteDeadline`）。
- 日志：只记失败/降级，`log.Printf` 不要出现在正常路径。

## 3. 协议层规则（`agent/protocol`）

这个包是**纯函数**，不碰 I/O、不持有状态。改动时注意：

1. `Decode` 必须同时填 `RequestID`（顶层）和 `RespRequestID`（`response.request_id`）。
   两者不对称是协议本身的坑，不是笔误。
2. `control_request` 的 `subtype` 在 `request.subtype`；`result` 的 `subtype` 在顶层。
   `Decode` 已按类型分支处理。
3. 新加的控制请求构造器请沿用 `mustMarshal(map[string]any{...})` 风格，
   保持字段名与 CLI 一致（`request_id` 等 snake_case）。
4. `PermissionRequest` 的 `permission_suggestions` 必须原样保留（前端按钮的数据源）。
5. `PermissionRequest` 的 `agent_id` 同样要保留：子代理里的工具审批只有它（没有
   `parent_tool_use_id`），丢了前端就无法标出「谁在申请权限」。
6. **未知字段一律不丢**：转发给前端时用 `Envelope.Raw`。
7. `IsTurnInit` 只认 `type=system & subtype=init`：它是「一轮开始」的唯一信号
   （进程启动一次，回合进行中写入的插话没赶上本轮时 CLI 会再发一次）。

## 4. 会话状态机（`agent/session`）

```
starting ──initialize 回包──> ready ──Prompt──> busy ──result──> ready
                                  └────────── Close ──────────> closed
```

- `Start` 内部先 `go readLoop()` 再发 `initialize`，**顺序不能反**。
- `request()` 用 `pending[requestID] + chan` 做请求/响应关联，超时后清理。
- `handleLine` 中遇到 `control_request` 且非 `can_use_tool` → 立刻回 `Unsupported`。
- **读循环结束必须看 `sc.Err()`**：`bufio.Scanner` 返回 false 也可能是单行超过
  `maxLineBytes`（8MB），不检查就会静默 close——前端只看到一条 `closed`，不知道原因。
  现在会先抛一条 `error` 事件再关会话。
- **stdout 上的非 JSON 行转成 `system/stdout` 文本**，不要原样塞进 `cli` 事件：
  `json.RawMessage` 遇到非法 JSON 会让 `json.Marshal` 失败，最后变成一条
  「json: error calling MarshalJSON」的错误提示，原文反而丢了。
- 事件出口只有一个 `emit`，由 `manager` 接到 `hub`。**不要在 session 里直接写 WS**。
- `PermissionReply` 支持 `UpdatedInput`（编辑后运行）与 `UpdatedPermissions`
  （始终允许 / 切模式），两者都要透传到 `control_response`。
- **`result` 之后紧跟的 `system/init` 要把状态标回 busy**：回合进行中写进 stdin 的用户消息
  （插话）如果这轮已收尾，CLI 会先发 `result` 再发一条 init，把它当新的一轮跑。判定是
  `protocol.IsTurnInit` + `state==ready` + `justFinishedTurn()`（`TurnHandoffWindow`，15s）。
  不认这条信号，界面会在整轮里显示空闲（发送按钮而不是中断按钮），前端的待发送队列也会
  被提前放出去。`TurnHandoffWindow` 是变量，测试会调小它。
- **权限模式可以会话内热切换**（`SetPermissionMode` → 控制请求 `set_permission_mode`，
  实测 2.1.325 在接受请求后立刻回 success；进行中的回合不受影响，之后按新模式判定）。
  回包**必须等**：非法取值时 CLI 只在回包里给原因（`must be one of …`），不等就等于
  让界面一直显示「切成功了」。请求 id 走 `nextControlID` 生成，别用固定串——
  连点两下会同时挂在 pending 表上。
- **当前模式以 CLI 上报的为准**：切模式后 CLI 发 `system/status`（带 `permissionMode`），
  每个回合的 `system/init` 也带；`handleLine` 把它转成 `session.state{mode}` 并记进
  `Session.Mode()`，WS 快照 `info.mode` 带上它。界面不要自己记。
  注意字段名两套：initialize 回包是 `current_permission_mode`（snake_case，
  `protocol.InitPermissionMode`），system 消息是 `permissionMode`（camelCase，
  `protocol.PermissionModeOf`）。

## 5. 进程层规则（`agent/process`）

- `Args()` 的第一个不变量：**`--permission-prompt-tool stdio` 永远存在**。
- **能力开关必须探测后再加**：`--forward-subagent-text` 只有较新版本认识，
  `manager.supportsFlag` 跑一次 `claude --help` 并按二进制路径缓存结果。
  无条件加参数会让旧版本（面板可以切版本）起不来，表现成「会话启动失败」。
- `Effort` 非空时追加 `--effort <level>`；CLI 只接受 low/medium/high/xhigh/max，
  设置层已做白名单过滤，不要在 process 层再放行任意字符串。
  「默认」档是空串 → 不传 `--effort`（不向 API 声明推理等级）。
  **不要试图做「关闭思考」档**：`--effort` 没有 off，`MAX_THINKING_TOKENS=0` 在中转下实测无效。
- **「跳过权限」要能切得动，启动时就得带能力开关**：`--allow-dangerously-skip-permissions`
  加到 `process.Args`（按 `supportsFlag` 探测），否则会话里切 bypassPermissions 会被
  CLI 拒掉（"session was not launched with --dangerously-skip-permissions"，实测 2.1.325）。
  它不改变启动模式：实测带它 + `--permission-mode default`，首轮照常 `can_use_tool`，
  切到 bypass 之后同一会话的工具调用直接放行。别用 `--dangerously-skip-permissions` ——
  那是「一上来就跳过所有审批」。
- `CleanEnv()` 剔除 `CLAUDECODE`、`CLAUDE_CODE_ENTRYPOINT`、`HOME`、`PWD`，
  再强制注入 `HOME`/`PWD`；**保留 `ANTHROPIC_*`**。
- `Spawn()` 必须持续排空 stderr（否则管道写满会卡住子进程），只保留尾部用于报错。
- `Close()` 幂等：关 stdin → Kill → Wait。

## 5.1 第三方模型与密钥（`internal/settings`）

数据模型（对齐 DSH 模型页）：

- `Provider`：id / name / 协议 / baseURL / 密钥 / models[]（该提供商下已添加的模型）
- `Selection{Provider, Model, Effort}`：全局唯一的「当前选中模型 + 推理强度」，模型就是 CLI 的默认模型
- **没有别名槽位**：`default/opus/sonnet/haiku` 那套映射已废弃，不要再加回来

不变量：

- **所有持久化文件落在 `CCWEB_DATA_DIR` 下**，路径由 `config.SettingsFile` 决定。
- 写盘必须 `tmp + rename` 原子替换，权限 **0600**（文件里有密钥）。
- `Public()` 是唯一对外视图：密钥只给 `*_set` 与脱敏串，**任何响应都不得回传明文**。
- **对外 JSON 里的切片字段永远不能是 nil**：`append([]string(nil), 空...)` 返回 nil，
  会序列化成 `null`，前端 `p.models.map` 直接抛 TypeError、整页白屏。
  一律用 `make([]T, 0, n)` 再 append。前端也做了兜底（`normalizeSettings`），
  两侧都要防。
- 提供商数组是**整体替换**语义；单个提供商的密钥空串 = 不改（前端密码框回填的是占位），
  清除必须 `clear_key`。ID 为空或重复要报错。
- 删除提供商后若 `Selection` 悬空，必须清空 Selection。
- `Provider.Models` 仍是模型 ID 列表；能力元数据放在 `Provider.ModelMeta`（按 ID 索引）：
  `name` / `reasoning_efforts` / `supports_image` /
  `context_window` / `max_output_tokens`。`Env()` 把前者注入
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS`、后者注入 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`；
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 是独立的全局设置，两者可同时存在。
  新增字段时保持老配置（只有 `models: ["id"]`）可读。
- 推理强度没有控制请求，只在 `process.Args` 里用 `--effort` 固定；已有会话改强度
  只能提示「新会话生效」，不要假装热切换。
- **档位只有两种来源**：模型声明的 `reasoning_efforts` 与界面自带的「默认」（`Selection.Effort`
  为空，不向 API 声明）。**没有每模型「默认强度」配置**，未选择就是「默认」——
  `DefaultEffort()` 不再回落到 `reasoning_efforts[0]`，旧配置里的
  `default_reasoning_effort` 读时忽略、下次写盘即消失。
- **改档位靠重开会话**：控制协议里没有 `set_effort`，`--effort` 只在启动时固定。
  前端 `applyEffortChange` 判断：空闲就 `DELETE /api/session?id=` + `POST /api/session
  {cwd, resume:id}`（同一 id，`--resume` 保住上下文），进行中则等 `result` 到达再重开；
  还没发过消息的对话没有转录，`--resume` 会失败，那种情况直接新建。
- 界面偏好 `locale`（zh/en）、`font_size`（12–20）、
  `proxy_url`（http/https/socks5/socks5h，空=直连）落在 `settings.json`；
  **主题不在这里**：`theme` 只缓存在浏览器 localStorage（每台设备各看各的），
  `Settings`/`Public`/`Patch` 都没有这个字段，旧配置里的 `theme` 读时忽略、下次写盘即消失。
  `Open` 时补默认值，`Apply` 时校验，非法值直接报错。
- **代理变量必须大小写都写**（实测 2.1.325）：这个 CLI 只认小写 `https_proxy`/`http_proxy`，
  只给大写 `HTTPS_PROXY` 时它一个字节都不走代理（连 `NODE_USE_ENV_PROXY=1` 也救不回来）。
  `Settings.Env()` 因此两套都注入，`process.CleanEnv` 两套都先剔除继承值。
  `socks5://` 的 URL 它也不做 SOCKS 握手，而是当成 HTTP 代理发 `CONNECT`——配 socks 时
  代理端看到的是普通 CONNECT，不是 SOCKS5 greeting。
- **代理要覆盖三类出站**：① claude 子进程（`Settings.Env()` → `process.CleanEnv` 后追加）；
  ② 面板自己的 HTTP（拉模型列表 / 探测端点 / 验证模型 / 下载 claude）；③ 右侧栏的 git 子进程。
  后两者**不会**自动读设置：Go 的 `http.ProxyFromEnvironment` 只读进程启动时的环境变量，
  git 只看自己的环境。所以 `internal/netproxy` 把「当前代理」翻译成 `Transport.Proxy`
  与子进程环境两套形式，装配层（`cmd/ccweb`）用 `SetProxySource` 把
  `settings` / `claudebin` / `gitctl` 的取值函数接上。**新增任何出站请求都要接这一层**，
  否则用户会看到「配了代理但没流量」。
- 代理只在进程启动时生效：`POST /api/settings/proxy` 保存后关闭全部会话，再按原 id
  `Resume`（空对话没有转录时才退回 `Ensure`）；`Settings.Env()` 注入大小写两套 proxy 变量和 localhost `NO_PROXY`，
  `process.CleanEnv` 必须剔除继承的代理变量，保证空值=直连。
- 模型列表解析的显示名只取 `display_name` / `displayName` / `title` / `label` / `name`，
  绝不能把 `description` 当显示名；`name` 等于 ID 时按空处理，前端回落 ID。
- **对话地址与列表地址不是同一个**：CLI 自己拼 `/v1/messages`，而 OpenAI/Gemini 协议的
  base 习惯带 `/v1`。`Provider.ChatBaseURL()` 对非 Anthropic 协议剥掉尾部 `/v1`，
  `Env()` 必须用它，否则会拼成 `/v1/v1/messages`（404）。
- **交互式会话要快速失败**：`Env()` 固定注入 `CLAUDE_CODE_MAX_RETRIES=2`、
  `CLAUDE_CODE_OVERLOADED_RETRY_MAX_WAIT_MS=5000`、
  `CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES=0`。CLI 默认对 429/529 重试 10 次，
  额度/频率限制会让用户等约 2.5 分钟才看到错误；这几个值把等待压到几秒。
- `Env()` 只注入选中提供商的值：`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`（或无 key 时
  `ANTHROPIC_AUTH_TOKEN`）/ `ANTHROPIC_MODEL`，并把三个别名变量也指向同一模型，
  使 CLI「固定使用默认模型」。
- **读响应体上限要按用途区分**：错误体 4KB 够用，模型列表要 4MB（真实中转条目带
  description / modalities，一份列表常超 4KB）。被截断时要明说「被截断」，
  不要伪装成解析失败。
- 旧配置（顶层 base_url/api_key + 四个别名）在 `Open()` 时自动迁移成一个 provider，
  迁移后清空旧字段。

## 5.2 对话持久化（`conversation` / `history` / `manager`）

- 新建会话生成 UUID，同时作为 manager id 与 claude `--session-id`；恢复用同一个 UUID
  `--resume`。`Manager.Resume` 对已在运行的 id 直接返回现有 info，并在 createMu 内串行化。
- `conversation.Store` 只存应用增量（标题/归档/删除/last_active/模型/用量快照），转录仍由 claude 写。
  用量快照（`usage`）是前端从 CLI 的 `usage` 算好的几个数字，后端不解释内容，只校验
  是合法 JSON 且 ≤ 2KB（`SetUsage`），随对话一起读写。
  删除写墓碑，不删 jsonl；`LastFor`/列表/自动预热都必须跳过 deleted/archived。
- 新会话在首条 prompt 成功后才 `Touch` 元数据；否则后端重启后会出现没有转录、无法 resume 的条目。
- `--resume` 不会回放 transcript；`GET /api/history/transcript` 返回原始事件行，
  前端用 `applyCLI` 回放并保留 `timestamp`。`history.LoadTranscript` 过滤
  `isSidechain`/`isMeta` 与 queue-operation 等非消息类型，最多保留最近 20k 行/16MB。
- `CCWEB_AUTO_START` 预热只做 Resume，不新建；没有对话时留给前端创建。

## 5.3 右侧栏后端（`fsapi` / `gitctl` / `terminal`）

- `fsapi.Root` 同时保存传入路径与 `EvalSymlinks` 后的真实路径；每次解析都要求真实路径
  仍在根内。不要为了「方便」改成纯词法判断——符号链接可以从工作区跳到 `/etc`。
- 文本预览只读前 `MaxPreviewBytes`（1 MiB），截断时回退完整 rune；含 NUL 或非 UTF-8
  标记 `binary`，不把内容塞进 JSON。
- `gitctl` 每次 spawn 系统 `git`，固定 `-C <root> --no-pager -c color.ui=false
  -c core.quotePath=false`，环境加 `LC_ALL=C`、`GIT_OPTIONAL_LOCKS=0`、
  `GIT_TERMINAL_PROMPT=0`。输出上限 8 MiB，超限报错而不是截断解析。
- 路径前加 `--literal-pathspecs`，rev/hash/分支前加 `--end-of-options`；提交只传
  `commit -m`，不碰用户身份。
- **PATH 不能假设存在**：`internal/envpath` 是唯一的兜底入口（`Apply` 补进程、
  `Ensure` 补子进程）。`gitctl` 与 `terminal` 都依赖 `exec.LookPath`，空 PATH 会让
  两者直接不可用；新增 spawn 系统命令的代码同样要先 `Ensure`。
- `terminal` 在 Linux 上用 `/dev/ptmx` 自建 PTY；非 Linux 返回 `ErrUnsupported`。
  终端进程与 WS 连接同生命周期，`Close` 先 SIGHUP 整个会话，2 秒后 SIGKILL。
  PTY 输出必须走 WS 二进制帧，上行命令才用 JSON 文本。
- 单进程最多 `maxTerminals`（8）个终端，槽位在升级 WS 前占用；超限直接 429。

## 6. 网关规则（`internal/gateway`）

- 只监听 unix socket；启动时清理残留 socket 文件并 `chmod 0660`。
- `withBaseURL` 剥离前缀，**前缀外的请求 404**（不要放行裸路径）。
- **裸前缀（`/app/<Name>`，无尾斜杠）直接当 `/` 处理，不要 301 到 `base+"/"`**。
  飞牛网关（`trim_http_cgi`）把会话凭据放在 query 上（`?token=` / ticket），301 会丢掉它，
  下一次请求就没有凭据，网关直接回 13 字节 `invalid token`（HTTP 200、text/plain，
  应用完全收不到请求）；301 还会被 webview 长期缓存，之后连新凭据都带不上。
  相对资源靠 index.html 注入的 `<base href>` 解析，不需要尾斜杠。
- 设置路由：`GET/PUT /api/settings`、`POST /api/settings/test|models|verify|proxy`——
  全部敏感（有密钥），务必保持鉴权。`GET /api/health` 不带鉴权（只报存活，不回信息）。
- 技能路由：`GET /api/skills`、`GET/PUT/DELETE /api/skills/doc`（写入见根 AGENTS.md 4.10）。
- MCP 路由：`GET /api/mcp`、`POST /api/mcp`、`DELETE /api/mcp`、`POST /api/mcp/enabled`、
  `POST /api/mcp/probe`。项目级操作先过 `authorizedCwd`；探测只接受已保存的服务名
  （不许把命令塞进请求体，否则等于免审批执行任意命令）。细节见根 AGENTS.md 4.11。
- 插件路由：`GET /api/plugins`、`GET /api/plugins/available`（目录分页/搜索，服务端过滤）、
  `POST /api/plugins/refresh|install|enabled|update|uninstall|marketplace`、
  `GET /api/plugins/details`。变更动作是**单槽后台任务**（并发回 409），project 作用域先过
  `authorizedCwd`；`plugin details` 只认已安装插件，未安装时回 `inspect`（清单文件）。细节见根 AGENTS.md 4.13。
- 内置搜索路由：`GET /api/search`、`POST /api/search/config|test|attach|detach`。配置走
  `settings.Patch`（校验与密钥语义不重复实现）；`attach` 只写用户级 MCP 配置，命令用
  `os.Executable()` 的绝对路径。细节见根 AGENTS.md 4.12。
- 工作区路由：`GET/POST/DELETE /api/workspaces`、`POST /api/workspaces/current`、
  `POST /api/workspaces/rename`（只改显示名）、`GET /api/fs/list`、`POST /api/fs/mkdir`
  （只接受单层目录名）、`POST /api/fs/access`（写探测）、`POST /api/fs/host-file`（宿主文件
  读取，唯一不受工作区围栏约束的接口）。目录浏览是只读但能枚举宿主目录，必须保持鉴权。
  右侧栏文件树的浏览走 `/api/fs/tree|file|raw`（见下方「右侧栏路由」）。
- 新路由必须 `s.authed(...)`；WS 在 handler 内自行校验 token。
- `GET /ws` 有两条语义：带 `?id=<session>` 是会话通道；**不带 id 是系统通道**
  （只订阅 `systemTopic`，只收应用级事件，目前是 `claude.update`）。系统通道没有会话，
  `dispatch` 里只放行 ping，其余命令回 `error`——不能让它落到 nil 会话上（那是 panic）。
  定时策略不在 gateway：`cmd/ccweb` 的 `startClaudeUpdateWatch` 负责查，gateway 的
  `BroadcastClaudeUpdate()` 只负责推。
- **读循环里不能有「等 CLI 回包」的命令**。每条连接只有一个读循环线程，阻塞它等于让这条
  连接上的后续帧全部读不到——最要命的是审批回包：`set_permission_mode` 要等 CLI 应答
  （最长 `ModeTimeout`），而 CLI 很可能正挂在 `can_use_tool` 上等审批，于是「切模式等审批、
  审批等切模式」白等一个超时，用户点「允许」看起来毫无反应。所以 `permission_mode` 在
  独立 goroutine 里跑，失败用 `error` 事件回（`writeFrame` 只入队，跨 goroutine 安全）。
  新增命令前先问：它会不会等对端？会就挪出去。
- 对话路由：`GET /api/conversations`、`PATCH /api/conversations`（重命名/归档/touch/usage）、
  `DELETE /api/conversations?id=`（软删除）、`GET /api/history/transcript?id=`（回放）。
- 预览路由：`GET /api/history/preview?id=` 返回会话最近一问一答（侧栏悬浮预览用）。
  `history.LoadPreview` 只读转录尾部 64KB、跳过 sidechain/meta 与本地命令回显，
  不进列表接口——列表要快，预览是按需的。
- 导出路由：`GET /api/history/export?id=` 把会话原始日志打成 zip（主转录 + 会话目录下的
  子代理转录 / meta），`archive/zip` 标准库实现。先判存在再写响应头，否则 404 会变成
  「下载到一个坏 zip」；符号链接与超大文件不进包。
- 子代理路由：`GET /api/history/subagent?id=&agent=`（读旁路转录）、
  `POST /api/session/task`（`stop_task` / `background_tasks`）。两者都要挂 `s.authed`；
  agent id 走 `[A-Za-z0-9_-]` 白名单，会话 id 走 `validSessionID`，不能拼路径。
  `POST /api/session` 带 `resume` 时走 `manager.Resume`，不带才新建。
- 右侧栏路由：`GET /api/fs/tree|file|raw`、`GET /api/git/repos|status|diff|show|log|branches`、
  `POST /api/git/stage|unstage|discard|commit|checkout|pull`、`GET /ws/terminal`。
  全部先过 `authorizedCwd`（`project.Validate` + `workspace.Allows`），再做路径围栏；
  原始字节只放行图片/PDF 并带 `CSP: sandbox`，HTML/SVG 不得同源 inline。
- `POST /api/settings/proxy` 是敏感路由；先 Apply 设置，再重启全部会话，并返回
  `{settings, sessions, warning}` 供前端直接切换。
- 部署路由：`GET /api/claude/status`、`POST /api/claude/check|install|cancel|active|source`、
  `DELETE /api/claude/version`。安装是后台任务，接口立即返回，进度靠轮询 status，
  `cancel` 幂等取消进行中的安装并清理临时目录；全部挂 `s.authed`。
  `Deps.Claude` 为 nil 时返回 503，且 `/api/info` 不带 `claude_installed`。
- `POST /api/session` 与 `/api/session/ensure` 必须先 `project.Validate`，再
  `s.ensureCwdAuthorized`；移除工作区时若仍有会话在用要返回 409。
- SPA：`index.html` 注入 `<base href>`，缓存头用 **`no-store`**；`assets/**` 用 `immutable` 强缓存。
- **带扩展名的请求找不到时必须 404，不能回退到 index.html**：否则浏览器会拿到
  200 + `text/html` 的"JS"，拒绝按模块执行，整页**白屏**，而且原因极难看出
  （通常是浏览器/网关缓存了旧 index，它引用的哈希资源已不存在）。
  只有无扩展名的前端路由才回退 index.html。
- WS 写帧必须设 `WriteDeadline`；hub 广播失败会自动退订。

## 7. 测试要求

- **纯函数优先单测**：`protocol`、`process.Args/CleanEnv`、`history.extractText`、
  `gateway.rewriteBase/cacheControlFor`、`wsframe` 编解码。
- **状态机用假对端**：`session` 的测试用 `os.Pipe` 对（**不要用 `net.Pipe`**，无缓冲会自锁），
  假 CLI 按真实协议回包。
- **网关用 fake manager**：`gateway_test.go` 里的 `fakeMgr` 实现 `SessionManager`
  （含 `Resume`/`Ensure`），这样不依赖 claude 二进制。
- 附件：`protocol.UserMessage` 负责 image/document/text content block；`gateway/ws.go`
  的 `decodeAttachments` 负责类型/大小/UTF-8 校验。WS 单帧上限 16MB，前端总附件 10MB。
- `workspace` 的种子、增删、嵌套最长匹配、`Allows/ AutoStartPath` 必须有表驱动测试。
- 对话：`conversation` 覆盖 Touch/重命名/归档/删除/嵌套 cwd/持久化；`history` 覆盖 transcript
  过滤与尾部截断；网关覆盖列表合并、删除隐藏、resume 鉴权/目录校验。
- 右侧栏：`fsapi` 覆盖路径穿越、符号链接逃逸、隐藏文件、截断与二进制；`gitctl` 覆盖
  porcelain v2 / numstat / log 解析与真实临时仓库；网关覆盖未授权 cwd、raw 类型白名单、
  WS 升级前鉴权。
- `terminal` 的 PTY 测试在 agent 沙箱里会因 `/dev/ptmx` 被拦而 skip；完整权限下必须通过。
- 表驱动 + `t.Helper()`；断言失败信息要带实际值。
- 新增导出的行为必须带测试；修 bug 先写复现测试。

```bash
cd backend && GOCACHE=$PWD/../.gocache GOMODCACHE=$PWD/../.gomodcache go test ./...
```

## 8. 常见错误对照

| 现象 | 原因 |
|---|---|
| 前端收不到审批 | 漏了 `--permission-prompt-tool stdio` |
| CLI 一个字节不输出 | 没先发 `initialize` |
| 握手超时 | `initialize` 的 response 被当成不需要的响应丢弃，或 `request_id` 取错位置 |
| 会话结束时进程残留 | 只关了管道没 Kill；检查 `Proc.Close` |
| 环境变量不生效 | 继承环境里有同名项，按「后者生效」被覆盖 |
| `go build` 报 embed 找不到 | `internal/webui/embed/` 被删空；`git checkout -- backend/internal/webui/embed` |
