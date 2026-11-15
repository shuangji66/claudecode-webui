# Claude Code 控制台（ccweb）

把本地 `claude` CLI 包成一个**可视化 Web 界面**：单 Go 二进制、内嵌前端、只监听 unix socket，
由网关注入 baseurl 前缀反代。后端常驻 claude 子进程，通过 `stream-json` 协议双向转发，
前端不做终端模拟，全部是结构化渲染（消息流 / 工具卡片 / diff / 审批面板）。

## 它解决什么问题

官方 `--remote-control` 有三条硬限制：只认 claude.ai 订阅登录（**不支持 API key**）、
`ANTHROPIC_BASE_URL` 必须是 `api.anthropic.com`、UI 托管在 claude.ai。本项目走的是本地
进程管道，与上述限制无关 —— 只要目标端讲 Anthropic Messages 格式，中继 / 私有网关 / 反代
都能用。

## 快速开始

```bash
# 1. 编译（前端 → 内嵌 → 单二进制）
make dev            # 产物：bin/ccweb

# 2. 把 ccweb 和 claude 放到同一目录（claude 需在 PATH 中）
cp bin/ccweb /opt/cc/
# /opt/cc/claude 已存在且在 PATH 中，后端会直接 exec "claude"

# 3. 启动
CCWEB_BASEURL=/app/ccweb \
CCWEB_ADMIN_SOCK=/run/ccweb/ccweb.sock \
/opt/cc/ccweb
```

程序**不监听 TCP**。用 nginx 反代到 socket：

```nginx
location /app/ccweb/ {
    proxy_pass http://unix:/run/ccweb/ccweb.sock:/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # WebSocket 必须
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;                    # 长会话不要被掐断
    proxy_buffering off;                         # 事件流不要缓冲
}
```

> `/` 结尾与 `proxy_pass` 的路径要成对：`location /app/ccweb/` + `proxy_pass .../`
> 才能把前缀剥掉；后端同时也会校验 `CCWEB_BASEURL`，两者必须一致。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CCWEB_ADMIN_SOCK` | `$TMPDIR/ccweb/ccweb.sock` | 唯一监听入口（unix socket） |
| `CCWEB_BASEURL` | 空（根路径） | 网关路径前缀，自动归一成 `/x/y` |
| `CCWEB_CLAUDE_BIN` | 空 | 显式指定 claude；为空则依次查 PATH、程序同目录 |
| `CCWEB_AUTH_TOKEN` | 空 | 非空即启用 Bearer 鉴权（WS 走 `?token=`） |
| `CCWEB_DATA_DIR` | `$TMPDIR/ccweb` | **数据目录**：socket、设置、claude 家目录都在这下面 |
| `CCWEB_SETTINGS_FILE` | `$DATA_DIR/settings.json` | 持久化配置（含第三方端点与密钥），权限 0600 |
| `CCWEB_CLAUDE_HOME` | `$DATA_DIR/claude` | 派给 claude 子进程的 HOME（登录态与转录落在这里） |
| `CCWEB_PROJECTS_ROOT` | `$HOME` | 「新建会话」可选目录的根 |
| `CCWEB_MAX_SESSIONS` | `8` | 常驻会话上限（单会话约 176 MB 内存） |
| `CCWEB_IDLE_TIMEOUT` | `30m` | 空闲会话回收阈值 |
| `CCWEB_PERMISSION_MODE` | 空 | 新会话默认权限模式 |
| `CCWEB_MODEL` | 空 | 新会话默认模型 |


## 第三方模型 / 中继接入

设置页（右上角 ⚙）里可以直接填 **API 地址 + 密钥**，无需环境变量。保存后写进
`$CCWEB_DATA_DIR/settings.json`（0600），并以 `ANTHROPIC_*` 环境变量注入**新建**的 claude 进程：

| 设置项 | 注入的环境变量 |
|---|---|
| API 地址 | `ANTHROPIC_BASE_URL` |
| API 密钥 | `ANTHROPIC_API_KEY`（`x-api-key` 头） |
| Bearer 令牌 | `ANTHROPIC_AUTH_TOKEN`（`Authorization: Bearer`） |
| 默认模型 | `ANTHROPIC_MODEL` |
| Opus / Sonnet / Haiku 别名 | `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` |
| 默认权限模式 | `--permission-mode` 启动参数 |

要点：

- 设置优先于宿主环境变量（追加在后面，后者生效），因此可以在同一台机器上给本应用单独配置中转。
- **只对新建会话生效**；已在跑的进程环境变量改不了，需要关掉重开。
- 密钥经接口返回时一律脱敏；输入框留空表示「不修改」，清除要点「清除」再保存。
- 「测试连接」先 `GET /v1/models`（不计费），不支持时退回一次 `POST /v1/messages`（max_tokens=1）。

## 数据目录

`CCWEB_DATA_DIR` 下统一生成：

```
$CCWEB_DATA_DIR/
  ccweb.sock          # 唯一监听入口
  settings.json       # 设置（0600）
  claude/             # claude 的 HOME：登录态、~/.claude/projects 转录
```

会话列表/历史就是读 `$CCWEB_CLAUDE_HOME/.claude/projects/**/*.jsonl`。
把 `CCWEB_CLAUDE_HOME` 指回 `$HOME` 可复用操作者已有的登录态（但数据就不再集中）。

## 安全提醒

**这是一个浏览器里的命令执行面板。** 一旦反代到内网可访问地址而没有任何鉴权，
等于把机器的 shell 敞开。部署时至少做到：

1. 设置 `CCWEB_AUTH_TOKEN`；
2. 网关层再加一层认证 / 仅监听 localhost / 只对内网开放；
3. 不要用 `bypassPermissions` 作为默认权限模式。

## 开发

```bash
make test       # 后端 go test + 前端 vitest
make vet        # go vet
make fmt        # gofmt
make clean      # 清理产物
```

前端单独开发（后端已在跑）：

```bash
cd frontend && npm run dev    # Vite 开发服务器，需自行把 /api 与 /ws 代理到 socket
```

## 目录结构

```
backend/
  cmd/ccweb/            进程入口（配置装配、信号、emit 接线）
  internal/
    config/             环境变量 → Config
    gateway/            unix socket、baseurl 剥离、路由、WS 升级、SPA
    wsframe/            最小 WebSocket 帧编解码（零第三方依赖）
    hub/                会话事件订阅与广播
    agent/              子域：claude 进程与会话
      protocol/         stream-json NDJSON 编解码与消息构造
      process/          定位 claude、参数拼装、环境净化、进程启动
      session/          单会话状态机（握手 / 轮次 / 审批 / 中断）
      manager/          会话池、上限、空闲回收
    history/            读取 ~/.claude/projects/**/*.jsonl
    project/            工作目录枚举与校验
    authz/              Bearer / query token 鉴权
    webui/              前端产物内嵌（go:embed）
frontend/
  src/transport/        线上协议类型 + WebSocket 客户端
  src/lib/              纯函数：消息归一化、diff、路径解析
  src/store/            zustand 全局状态
  src/components/       布局 / 聊天 / 工具卡片 / 审批
```

## 协议要点（做二次开发必读）

- 启动参数必须带 `--permission-prompt-tool stdio`，否则审批请求不会到达前端。
- 客户端必须先发 `initialize` 控制请求，**否则 CLI 一个字节都不输出**。
- `control_request` 的 `request_id` 在顶层；`control_response` 的在 `response.request_id`。
- `--include-partial-messages` 会先给逐字增量、再给完整消息，前端必须「替换」而非「追加」。

更多细节见三份 `AGENTS.md`。

## 许可证

Apache-2.0，见 [LICENSE](./LICENSE)。
