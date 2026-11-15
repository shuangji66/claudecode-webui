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
internal/project     工作目录枚举/校验
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
- `CleanEnv()` 剔除 `CLAUDECODE`、`CLAUDE_CODE_ENTRYPOINT`、`HOME`、`PWD`，
  再强制注入 `HOME`/`PWD`；**保留 `ANTHROPIC_*`**。
- `Spawn()` 必须持续排空 stderr（否则管道写满会卡住子进程），只保留尾部用于报错。
- `Close()` 幂等：关 stdin → Kill → Wait。

## 5.1 第三方模型与密钥（`internal/settings`）

数据模型（对齐 DSH 模型页）：

- `Provider`：id / name / 协议 / baseURL / 密钥 / models[]（该提供商下已添加的模型）
- `Selection{Provider, Model}`：全局唯一的「当前选中模型」，就是 CLI 的默认模型
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
- `Env()` 只注入选中提供商的值：`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`（或无 key 时
  `ANTHROPIC_AUTH_TOKEN`）/ `ANTHROPIC_MODEL`，并把三个别名变量也指向同一模型，
  使 CLI「固定使用默认模型」。
- **读响应体上限要按用途区分**：错误体 4KB 够用，模型列表要 4MB（真实中转条目带
  description / modalities，一份列表常超 4KB）。被截断时要明说「被截断」，
  不要伪装成解析失败。
- 旧配置（顶层 base_url/api_key + 四个别名）在 `Open()` 时自动迁移成一个 provider，
  迁移后清空旧字段。

## 6. 网关规则（`internal/gateway`）

- 只监听 unix socket；启动时清理残留 socket 文件并 `chmod 0660`。
- `withBaseURL` 剥离前缀，**前缀外的请求 404**（不要放行裸路径）。
- 新路由必须 `s.authed(...)`；WS 在 handler 内自行校验 token。
  `/api/settings` 三个端点（GET/PUT/POST test）都属于敏感路由，务必保持鉴权。
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
- **网关用 fake manager**：`gateway_test.go` 里的 `fakeMgr` 实现 `SessionManager`，
  这样不依赖 claude 二进制。
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
