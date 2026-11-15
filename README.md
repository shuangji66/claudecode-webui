# Claude Code 控制台（ccweb）

把本地 `claude` CLI 包成一个**可视化 Web 界面**：单 Go 二进制、内嵌前端、只监听 unix socket，
由网关注入 baseurl 前缀反代。后端常驻 claude 子进程，通过 `stream-json` 协议双向转发，
主对话区不做终端模拟，全部是结构化渲染（消息流 / 工具卡片 / diff / 审批面板）。
右侧栏额外提供工作区文件树、Git 面板与一个真正跑在 PTY 上的 bash 终端。

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
| `CCWEB_DATA_DIR` | `$TMPDIR/ccweb` | **数据目录**：socket、设置、授权目录、claude 家目录都在这下面 |
| `CCWEB_SETTINGS_FILE` | `$DATA_DIR/settings.json` | 持久化配置（含第三方端点、密钥与界面偏好），权限 0600 |
| `CCWEB_WORKSPACES_FILE` | `$DATA_DIR/workspaces.json` | 授权目录与当前工作区，权限 0600 |
| `CCWEB_CLAUDE_HOME` | `$DATA_DIR/claude` | 派给 claude 子进程的 HOME（登录态与转录落在这里） |
| `CCWEB_PROJECTS_ROOT` | `$HOME` | 首次启动时自动授权的默认目录 |
| `CCWEB_AUTO_START` | `1` | 进程启动后自动在当前工作区拉起 claude（`0/false` 关闭） |
| `CCWEB_MAX_SESSIONS` | `8` | 常驻会话上限（单会话约 176 MB 内存） |
| `CCWEB_IDLE_TIMEOUT` | `30m` | 空闲会话回收阈值 |
| `CCWEB_PERMISSION_MODE` | 空 | 新会话默认权限模式 |
| `CCWEB_MODEL` | 空 | 新会话默认模型 |
| `CCWEB_TERMINAL_SHELL` | 空 | 右侧栏内置终端使用的 shell；空则依次尝试 `$SHELL` / `bash` / `sh` |


## 工作区与授权目录

左侧栏的「工作区」就是**授权目录**列表：

- 首次启动会把 `CCWEB_PROJECTS_ROOT` 写进 `workspaces.json` 作为默认工作区；
- 点工作区标题右侧的文件夹图标打开服务器目录浏览器，授权任意目录后立即切换过去；
- 切换工作区时若该目录没有运行中的会话，会通过 `POST /api/session/ensure` 自动拉起 claude；
- 会话创建只允许落在授权目录（及其子目录）内，直接调 API 传别的路径会得到 403；
- 目录被移动/卸载时列表会标记「不可用」，`CCWEB_AUTO_START` 会退到第一个仍存在的目录。

服务端目录浏览接口是 `GET /api/fs/list`（需要鉴权），只读、只列目录。

## 右侧栏：文件 / Git / 终端

对话区右上角的侧栏按钮（桌面和移动端都有）打开右侧栏，分三个页签：

### 文件

- 工作区文件树按目录**懒加载**，默认隐藏点文件，可一键显示；
- 点文件进入只读预览：文本（带行号，最多渲染 3000 行）、Markdown、图片、PDF；
- 文本预览上限 1MB，超出会明确提示截断；二进制文件只显示大小与「新窗口打开」；
- 树只读，不做上传/重命名/删除——写操作交给 Claude 或终端。

### Git

- 变更按 **Merge / Staged / Changes** 分组；同一个文件两侧都有改动（`MM`）会分别出现在两组，
  行数徽标各算各的，不重复相加；
- 点文件看 unified diff；行内按钮 stage / unstage / 丢弃工作区改动（丢弃需确认）；
- 提交框支持 `Ctrl/⌘ + Enter`；只提交已暂存内容，冲突未解决时禁用；
- 底栏显示当前分支、上游与 ahead/behind，可切换本地分支，也可「同步」= `pull --ff-only` + `push`；
- 「历史」页签读取最近 30 条提交，点开看该提交的补丁。

**没有**移植 dsh-better-sidebar 的提交图泳道、多 worktree 切换、revert/cherry-pick 和
AI 生成提交信息——这些要么依赖它的宿主事件日志，要么会把无头面板变成容易误操作的入口。

### 终端

- 真正分配 PTY 的交互式 shell（`xterm.js` 只负责渲染），cwd 就是当前工作区；
- 切换页签不会杀进程，关闭右侧栏会 SIGHUP 结束 shell（面板底部有提示）；
- 每个连接一个终端，单进程最多 8 个；WebSocket 输出走二进制帧，ANSI 序列不会被 JSON 转义破坏；
- **仅 Linux**：PTY 依赖 `/dev/ptmx`，其他平台会显示明确的「不支持」提示；
- shell 可用 `CCWEB_TERMINAL_SHELL` 指定。

### 安全边界

- 所有 `/api/fs/*`、`/api/git/*` 都要求鉴权；`/ws/terminal` 走 `?token=`；
- `cwd` 必须落在已授权工作区内，相对路径解析符号链接后仍要留在工作区内；
- Git 只调系统 `git` CLI，不经 shell，路径前加 `--literal-pathspecs`，rev/hash/分支前加
  `--end-of-options`；提交沿用用户全局 git 身份，从不设置 `user.name/email`；
- 图片 / PDF 的原始字节预览有类型白名单并带 `CSP: sandbox`，HTML/SVG 只能当文本看，
  避免工作区文件以同源页面身份执行脚本读到 token。

## APP 启动自动拉起 claude

`CCWEB_AUTO_START=1`（默认）时，进程启动后异步 `ensure` 当前工作区的会话。前端打开时
如果还没会话，也会再 ensure 一次；`manager.Ensure` 内部串行化，不会重复启动。

## 设置页

左侧栏底部的「设置」打开分页设置（通用 / 模型）：

- **通用**：主题（浅色 / 深色 / 跟随系统）、界面语言（简体中文 / English）、
  会话字号（12–20px）、新建会话的默认权限模式；修改即时写入 `settings.json`。
- **代理**：为 claude 子进程设置 HTTP/HTTPS/SOCKS5 代理，留空直连。保存后
  `POST /api/settings/proxy` 会重启所有运行中的 claude 会话，使代理变量立即生效；
  代理同时写入 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `SOCKS_PROXY`（大小写都有），
  `localhost` 与 `127.0.0.1` 自动走 `NO_PROXY`。
- **模型**：按协议管理提供商。新建提供商时要手动填写**提供商 ID**，显示名留空则跟随 ID；
  提供商列表在只有一个时默认展开、多个时默认折叠。每个模型可配置显示名（留空跟随模型 ID）、
  **推理强度档位**（`low` / `medium` / `high` / `xhigh` / `max`）、默认推理强度和**图片输入支持**。
  选中的推理强度会作为 `--effort` 传给新建的 claude 进程；对已有会话修改强度会在输入框下方
  提示「将在新会话生效」。
- 设置页不再展示运行环境 / 数据目录等诊断信息。

右上角「更多」是下拉菜单：可把当前会话复制为 Markdown，或进入设置。浏览器标题默认
`Claude Code`，进入会话后显示当前会话名称；对话结束只显示耗时，不再显示花费。

### 附件

输入框左侧的 `+` 可以选择文件或图片，发送时随 prompt 一起传给 claude：

- 图片：PNG / JPEG / GIF / WebP（单张 5MB），按 Anthropic `image` content block 发送；
- PDF：单文件 8MB，按 `document` content block 发送；
- 文本文件：单文件 1MB，服务端按 UTF-8 校验后作为文本块附加；
- 所有附件合计 10MB；WebSocket 帧上限已相应提高到 16MB。

不支持的类型、超过限制或非 UTF-8 文本会在输入框上方直接报错。

## 第三方模型 / 中继接入

在「设置 → 模型」里按**协议**添加「提供商」，每家填自己的 API 地址与密钥，
然后从它那里获取模型列表、勾选要添加的模型。

### 添加提供商

| 字段 | 说明 |
|---|---|
| 协议 | 决定「获取可用模型」用哪种列表地址与鉴权（见下表） |
| API 地址 | 该提供商的基础地址，列表与对话都用它 |
| API 密钥 | 对话时注入 `ANTHROPIC_API_KEY`（`x-api-key`）；留空表示不修改，清除要点「清除」再保存 |
| 模型 | 勾选添加后出现，可单独移除或点 ✓ 验证 |

协议 → 列表地址与鉴权（规则与 DSH 的 discovery 一致）：

| 协议 | 列表地址 | 鉴权 |
|---|---|---|
| `anthropic-messages` | `{root}/v1/models?limit=1000`（base 末尾的 `/v1` 会先剥掉） | `x-api-key` + `anthropic-version` |
| `openai-completions` / `openai-responses` | `{base}/models` | `Authorization: Bearer` |
| `google-generative-ai` | `{base}/models?pageSize=1000` | `x-goog-api-key` |

**对话始终走 Anthropic Messages**——claude CLI 只支持这一种协议。因此**地址会被归一化**：

- `anthropic-messages`：对话地址就是你填的地址（官方地址本身不带 `/v1`）；
- `openai-*` / `google-generative-ai`：这类地址习惯带 `/v1`（列表是 `{base}/models`），
  对话时**自动剥掉尾部 `/v1`**，否则 CLI 会拼成 `/v1/v1/messages` 而 404。

例：协议 OpenAI、地址 `http://127.0.0.1:7863/v1`
→ 拉列表 `…/v1/models`，对话 `…/v1/messages`。</br>
401 时会自动用同一把密钥换 `Bearer` 再试一次。

获取不到列表是正常情况：端点什么格式由它自己决定，手动输入模型名效果完全相同。

### 在聊天页选择模型

已添加的模型汇总到聊天输入框下方的**模型选择器**。选中的那个就是 claude CLI 的
**默认模型**——后端把它写进 `ANTHROPIC_MODEL`（同时把 opus/sonnet/haiku 三个别名
也指向它），CLI 因此固定使用它，不再暴露内置模型列表。模型元数据里声明了推理档位时，
输入框下方还会出现推理强度选择器；该值通过 `--effort` 在**新会话**启动时生效。

- **同一提供商内**切换：直接对当前会话发 `set_model`，立即生效，无需重开；
- **跨提供商**切换（含会话创建时还没选模型的情况）：地址与密钥在进程启动时就固定了，
  界面会**自动关闭并按相同目录重建会话**，随后正常对话。本轮正在运行时不允许切换。

> 早期版本用「default/opus/sonnet/haiku 四个别名槽位」手动映射，那套已废弃：
> 现在只有「已添加模型 + 当前选中」，不再需要手填别名。

## 数据目录

`CCWEB_DATA_DIR` 下统一生成：

```
$CCWEB_DATA_DIR/
  ccweb.sock          # 唯一监听入口
  settings.json       # 设置 + 界面偏好（0600）
  workspaces.json     # 授权目录 + 当前工作区（0600）
  claude/             # claude 的 HOME：登录态、~/.claude/projects 转录
```

会话列表/历史就是读 `$CCWEB_CLAUDE_HOME/.claude/projects/**/*.jsonl`。
把 `CCWEB_CLAUDE_HOME` 指回 `$HOME` 可复用操作者已有的登录态（但数据就不再集中）。

## 安全提醒

**这是一个浏览器里的命令执行面板。** 一旦反代到内网可访问地址而没有任何鉴权，
等于把机器的 shell 敞开。部署时至少做到：

1. 设置 `CCWEB_AUTH_TOKEN`；
2. 网关层再加一层认证 / 仅监听 localhost / 只对内网开放；
3. 不要用 `bypassPermissions` 作为默认权限模式；
4. 授权目录会扩大 Claude 可读写的范围——只添加确实需要的目录。

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
    project/            工作目录枚举与校验、目录浏览器
    workspace/          授权目录与当前工作区（workspaces.json）
    authz/              Bearer / query token 鉴权
    webui/              前端产物内嵌（go:embed）
frontend/
  src/transport/        线上协议类型 + WebSocket 客户端
  src/lib/              纯函数：消息归一化、diff、路径解析、i18n、主题
  src/store/            zustand 全局状态
  src/components/       布局 / 聊天 / 工具卡片 / 审批 / 设置分页
```

## 协议要点（做二次开发必读）

- 启动参数必须带 `--permission-prompt-tool stdio`，否则审批请求不会到达前端。
- 客户端必须先发 `initialize` 控制请求，**否则 CLI 一个字节都不输出**。
- `control_request` 的 `request_id` 在顶层；`control_response` 的在 `response.request_id`。
- `--include-partial-messages` 会先给逐字增量、再给完整消息，前端必须「替换」而非「追加」。
- 推理强度没有对应的控制请求，只能通过启动参数 `--effort` 固定；改强度需要新会话。
- WebSocket 断开后前端按指数退避自动重连，并用 ping/pong 心跳清理半开连接。

更多细节见三份 `AGENTS.md`。

## 许可证

Apache-2.0，见 [LICENSE](./LICENSE)。
