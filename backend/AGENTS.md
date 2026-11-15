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
internal/history     转录文件读取
internal/project     工作目录枚举/校验、目录浏览器
internal/workspace   授权目录 + 当前工作区（workspaces.json）
internal/fsapi       工作区内文件树/文本预览/原始字节（路径围栏 + 符号链接校验）
internal/gitctl      Git 面板后端：status/diff/stage/commit/log/branch/sync
internal/terminal    Linux PTY 会话（/dev/ptmx + ioctl，零依赖）
internal/authz       token 鉴权
internal/settings    持久化配置（第三方端点/密钥/模型）+ 端点探测
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
5. **未知字段一律不丢**：转发给前端时用 `Envelope.Raw`。

## 4. 会话状态机（`agent/session`）

```
starting ──initialize 回包──> ready ──Prompt──> busy ──result──> ready
                                  └────────── Close ──────────> closed
```

- `Start` 内部先 `go readLoop()` 再发 `initialize`，**顺序不能反**。
- `request()` 用 `pending[requestID] + chan` 做请求/响应关联，超时后清理。
- `handleLine` 中遇到 `control_request` 且非 `can_use_tool` → 立刻回 `Unsupported`。
- 事件出口只有一个 `emit`，由 `manager` 接到 `hub`。**不要在 session 里直接写 WS**。
- `PermissionReply` 支持 `UpdatedInput`（编辑后运行）与 `UpdatedPermissions`
  （始终允许 / 切模式），两者都要透传到 `control_response`。

## 5. 进程层规则（`agent/process`）

- `Args()` 的第一个不变量：**`--permission-prompt-tool stdio` 永远存在**。
- `Effort` 非空时追加 `--effort <level>`；CLI 只接受 low/medium/high/xhigh/max，
  设置层已做白名单过滤，不要在 process 层再放行任意字符串。
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
  `name` / `reasoning_efforts` / `default_reasoning_effort` / `supports_image`。
  新增字段时保持老配置（只有 `models: ["id"]`）可读。
- 推理强度没有控制请求，只在 `process.Args` 里用 `--effort` 固定；已有会话改强度
  只能提示「新会话生效」，不要假装热切换。
- 界面偏好 `theme`（system/light/dark）、`locale`（zh/en）、`font_size`（12–20）、
  `proxy_url`（http/https/socks5/socks5h，空=直连）也落在 `settings.json`；
  `Open` 时补默认值，`Apply` 时校验，非法值直接报错。
- 代理只在进程启动时生效：`POST /api/settings/proxy` 保存后关闭全部会话并 `Ensure`
  原目录的新会话；`Settings.Env()` 注入大小写两套 proxy 变量和 localhost `NO_PROXY`，
  `process.CleanEnv` 必须剔除继承的代理变量，保证空值=直连。
- 模型列表解析的显示名只取 `display_name` / `displayName` / `title` / `label` / `name`，
  绝不能把 `description` 当显示名；`name` 等于 ID 时按空处理，前端回落 ID。
- **对话地址与列表地址不是同一个**：CLI 自己拼 `/v1/messages`，而 OpenAI/Gemini 协议的
  base 习惯带 `/v1`。`Provider.ChatBaseURL()` 对非 Anthropic 协议剥掉尾部 `/v1`，
  `Env()` 必须用它，否则会拼成 `/v1/v1/messages`（404）。
- `Env()` 只注入选中提供商的值：`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`（或无 key 时
  `ANTHROPIC_AUTH_TOKEN`）/ `ANTHROPIC_MODEL`，并把三个别名变量也指向同一模型，
  使 CLI「固定使用默认模型」。
- **读响应体上限要按用途区分**：错误体 4KB 够用，模型列表要 4MB（真实中转条目带
  description / modalities，一份列表常超 4KB）。被截断时要明说「被截断」，
  不要伪装成解析失败。
- 旧配置（顶层 base_url/api_key + 四个别名）在 `Open()` 时自动迁移成一个 provider，
  迁移后清空旧字段。

## 5.2 右侧栏后端（`fsapi` / `gitctl` / `terminal`）

- `fsapi.Root` 同时保存传入路径与 `EvalSymlinks` 后的真实路径；每次解析都要求真实路径
  仍在根内。不要为了「方便」改成纯词法判断——符号链接可以从工作区跳到 `/etc`。
- 文本预览只读前 `MaxPreviewBytes`（1 MiB），截断时回退完整 rune；含 NUL 或非 UTF-8
  标记 `binary`，不把内容塞进 JSON。
- `gitctl` 每次 spawn 系统 `git`，固定 `-C <root> --no-pager -c color.ui=false
  -c core.quotePath=false`，环境加 `LC_ALL=C`、`GIT_OPTIONAL_LOCKS=0`、
  `GIT_TERMINAL_PROMPT=0`。输出上限 8 MiB，超限报错而不是截断解析。
- 路径前加 `--literal-pathspecs`，rev/hash/分支前加 `--end-of-options`；提交只传
  `commit -m`，不碰用户身份。
- `terminal` 在 Linux 上用 `/dev/ptmx` 自建 PTY；非 Linux 返回 `ErrUnsupported`。
  终端进程与 WS 连接同生命周期，`Close` 先 SIGHUP 整个会话，2 秒后 SIGKILL。
  PTY 输出必须走 WS 二进制帧，上行命令才用 JSON 文本。
- 单进程最多 `maxTerminals`（8）个终端，槽位在升级 WS 前占用；超限直接 429。

## 6. 网关规则（`internal/gateway`）

- 只监听 unix socket；启动时清理残留 socket 文件并 `chmod 0660`。
- `withBaseURL` 剥离前缀，**前缀外的请求 404**（不要放行裸路径）。
- 新路由必须 `s.authed(...)`；WS 在 handler 内自行校验 token。
  `/api/settings` 三个端点（GET/PUT/POST test）都属于敏感路由，务必保持鉴权。
- 工作区路由：`GET/POST/DELETE /api/workspaces`、`POST /api/workspaces/current`、
  `GET /api/fs/list`。目录浏览是只读但能枚举宿主目录，必须保持鉴权。
- 右侧栏路由：`GET /api/fs/tree|file|raw`、`GET /api/git/status|diff|show|log|branches`、
  `POST /api/git/stage|unstage|discard|commit|checkout|sync`、`GET /ws/terminal`。
  全部先过 `authorizedCwd`（`project.Validate` + `workspace.Allows`），再做路径围栏；
  原始字节只放行图片/PDF 并带 `CSP: sandbox`，HTML/SVG 不得同源 inline。
- `POST /api/settings/proxy` 是敏感路由；先 Apply 设置，再重启全部会话，并返回
  `{settings, sessions, warning}` 供前端直接切换。
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
  （含 `Ensure`），这样不依赖 claude 二进制。
- 附件：`protocol.UserMessage` 负责 image/document/text content block；`gateway/ws.go`
  的 `decodeAttachments` 负责类型/大小/UTF-8 校验。WS 单帧上限 16MB，前端总附件 10MB。
- `workspace` 的种子、增删、嵌套最长匹配、`Allows/ AutoStartPath` 必须有表驱动测试。
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
