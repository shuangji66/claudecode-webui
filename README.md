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

# 2. 部署二进制（不再需要自己准备 claude）
cp bin/ccweb /opt/cc/

# 3. 启动（首次打开页面会提示安装 claude）
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
| `CCWEB_AUTH_TOKEN` | 空 | 非空即启用 Bearer 鉴权（WS 走 `?token=`） |
| `CCWEB_DATA_DIR` | `$TMPDIR/ccweb` | **数据目录**：socket、设置、授权目录、claude 家目录都在这下面 |
| `CCWEB_SETTINGS_FILE` | `$DATA_DIR/settings.json` | 持久化配置（含第三方端点、密钥与界面偏好），权限 0600 |
| `CCWEB_WORKSPACES_FILE` | `$DATA_DIR/workspaces.json` | 授权目录与当前工作区，权限 0600 |
| `CCWEB_CONVERSATIONS_FILE` | `$DATA_DIR/conversations.json` | 对话元数据（归档/删除/重命名/最近活跃），权限 0600 |
| `CCWEB_CLAUDE_HOME` | `$DATA_DIR/claude` | 派给 claude 子进程的 HOME（登录态与转录落在这里） |
| `CCWEB_CLAUDE_VERSIONS` | `$DATA_DIR/claude/versions` | 托管 claude 的版本目录（每个版本一个子目录；部署页可删除未生效版本） |
| `CCWEB_PROJECTS_ROOT` | `$HOME` | 首次启动时自动授权的默认目录 |
| `CCWEB_AUTO_START` | `1` | 启动后恢复当前工作区最近一条对话（`0/false` 关闭；没有对话则不新建） |
| `CCWEB_MAX_SESSIONS` | `8` | 常驻会话上限（单会话约 176 MB 内存） |
| `CCWEB_IDLE_TIMEOUT` | `30m` | 空闲会话回收阈值 |
| `CCWEB_PERMISSION_MODE` | 空 | 新会话默认权限模式 |
| `CCWEB_MODEL` | 空 | 新会话默认模型 |
| `CCWEB_TERMINAL_SHELL` | 空 | 右侧栏内置终端使用的 shell；空则依次尝试 `$SHELL` / `bash` / `sh` |


## 工作区与授权目录

左侧栏的「工作区」就是**授权目录**列表：

- 首次启动会把 `CCWEB_PROJECTS_ROOT` 写进 `workspaces.json` 作为默认工作区；
- 点「工作区」标题右侧的文件夹图标打开「添加授权目录」弹窗：可浏览服务器目录、
  新建文件夹，也可以直接点「选择飞牛目录」用飞牛自己的选择器挑（挑选即授权）；
- 添加时会先请飞牛把该目录的 ACL 授予应用用户（`authorizeUserFile`），用户取消就不登记。
  降级说明：脱离飞牛宿主（直连端口 / 本地开发）时跳过授权，按旧行为直接登记；
- 每个工作区行有「更多」（重命名 / 在文件夹显示 / 删除工作区）和「＋」（在该工作区新建对话）；
- 点工作区时自动打开它最近活跃的对话；没有对话才新建一条；
- 对话创建只允许落在授权目录（及其子目录）内，直接调 API 传别的路径会得到 403；
- 目录被移动/卸载时列表会标记「不可用」，`CCWEB_AUTO_START` 会退到第一个仍存在的目录。

相关接口（都需要鉴权）：`GET /api/fs/list` 浏览目录、`POST /api/fs/mkdir` 新建单层文件夹、
`POST /api/workspaces/rename` 只改显示名（不动真实路径）。

## 右侧栏：文件 / Git / 终端

对话区右上角的侧栏按钮（桌面和移动端都有）打开右侧栏。没开标签时是「开始页」——
工作区文件 / Git / 新建终端三张卡片；文件与 Git 各占一个标签（单例），终端每个会话
各占一个标签（`+` 菜单新建），标签自带 × 关闭，切走只隐藏不卸载：

### 文件

- 工作区文件树按目录**懒加载**，默认隐藏点文件，可一键显示；
- 点文件进入只读预览：文本（带行号，最多渲染 3000 行）、Markdown、图片、PDF；
- 文本预览上限 1MB，超出会明确提示截断；二进制文件只显示大小与「新窗口打开」；
- 每行有「更多」菜单；在飞牛宿主里是「在文件夹显示 / 复制路径 / 文件详情」，
  不在宿主只留「复制路径」；
- 树只读，不做上传/重命名/删除——写操作交给 Claude 或终端。

### Git

- 变更按 **Merge / Staged / Changes** 分组；同一个文件两侧都有改动（`MM`）会分别出现在两组，
  行数徽标各算各的，不重复相加；
- 点文件看 unified diff；行内按钮 stage / unstage / 丢弃工作区改动（丢弃需确认）；
- 提交框支持 `Ctrl/⌘ + Enter`；只提交已暂存内容，冲突未解决时禁用；
- 底栏显示当前分支、上游与 ahead/behind，可切换本地分支，也可「拉取」= `pull --ff-only`
  （**不推送**：推送请自己在终端里 `git push`）；
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

## 对话持久化与恢复

侧栏的对话列表来自两处，并以后端接口合并后的结果为准：

1. **claude 转录**：`$CCWEB_CLAUDE_HOME/.claude/projects/**/*.jsonl`，提供标题、消息数与时间；
2. **应用元数据**：`conversations.json`，保存自定义标题、归档、软删除、最近打开时间和模型信息。

新建对话时后端生成一个 UUID，同时作为应用侧会话 id 和 claude 的 `--session-id`；
因此转录文件名、侧栏条目、前端 localStorage 中的 `ccweb-active-session` 完全一致。
恢复对话时用 `--resume <uuid>` 拉起新进程，再用 `/api/history/transcript` 回放旧事件，
前端走与实时流相同的 `lib/normalize.ts`，所以工具卡片、thinking、diff 都能还原。

行为：

- 进入前端优先恢复上次打开的对话（localStorage）；没有则选当前工作区最近活跃的一条；
- 上次的对话被归档/删除、或工作区一条对话都没有时，自动新建一条空对话；
- 列表支持重命名、归档/取消归档、删除；「删除」是软删除（写墓碑、保留转录文件），
  并会结束正在运行的进程；
- 列表视图可分组（按工作区 / 树 / 单列表）、排序（手动 / 最近更新）、筛选已归档；
  手动排序支持拖拽与「更多」菜单里的上移/下移。视图偏好只存浏览器；
- 空闲回收或后端重启后，点对话条目会用同一 id 恢复；切换工作区会打开该工作区最近的对话。

> `--resume` 只恢复上下文，不会把历史消息重新推到 stdout；所以转录回放是必需的，
> 不能只靠 CLI 输出重建界面。

## APP 启动预热

`CCWEB_AUTO_START=1`（默认）时，进程启动后异步恢复当前工作区最近的一条对话
（而不是新建空对话）。前端仍会按自己保存的 active id 选择；`manager.Resume` 对同一
id 会复用进程，重复调用不会多起 claude。没有历史对话时后端不做任何事，由前端创建第一条。

## 设置页

左侧栏底部的「设置」打开分页设置（通用 / 模型 / 技能 / 代理 / 部署）：

- **通用**：新建会话的默认权限模式（置顶）、主题（浅色 / 深色 / 跟随系统）、
  界面语言（简体中文 / English）、会话字号（12–20px）；修改写入 `settings.json`。
- **代理**：为 claude 子进程设置 HTTP/HTTPS/SOCKS5 代理，留空直连。保存后
  `POST /api/settings/proxy` 会重启所有运行中的 claude 会话，使代理变量立即生效；
  重启用 `--resume` 恢复同一对话 id，对话记录不会丢；
  代理同时写入 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `SOCKS_PROXY`（大小写都有），
  `localhost` 与 `127.0.0.1` 自动走 `NO_PROXY`。
- **模型**：按协议管理提供商。新建提供商时可以先从**预置提供商**里选（Anthropic、DeepSeek、
  Z.AI、Kimi、Qwen、MiniMax、小米、OpenRouter 等 40+ 家），自动填协议、Base URL 和默认模型；
  也可以选「自定义」手动填写 ID。标注「需兼容端点」的预置只能用于拉取模型列表，
  对话需要该服务提供 Anthropic 兼容端点。提供商列表在只有一个时默认展开、多个时默认折叠。每个模型可配置显示名（留空跟随模型 ID）、
  **推理强度档位**（`low` / `medium` / `high` / `xhigh` / `max`）和**图片输入支持**，
  以及**上下文窗口**与**最大输出 token 数**（支持 `128K` / `1M` 写法，留空表示不声明）。
  从网关拉取模型时会用返回的 `context_length` / `max_output_tokens` 预填，仍可手改。
  上下文窗口注入 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`（否则 CLI 对未知模型按 200K 处理），
  最大输出注入 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`。
  聊天页的档位列表还会多出「默认」一档（见下一节）：它不传 `--effort`，推理等级由 API 自己决定。
  选中的档位作为 `--effort` 传给 claude 进程；切换档位后当前会话会按**同一 id 重开**
  （`--resume`，上下文保留），进行中则等这一轮结束后再重开。
- **429 / 额度耗尽快速失败**：后端给 claude 注入 `CLAUDE_CODE_MAX_RETRIES=2`、
  `CLAUDE_CODE_OVERLOADED_RETRY_MAX_WAIT_MS=5000` 与
  `CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES=0`，避免 CLI 默认重试 10 次、约 2.5 分钟后
  才把限流错误抛到界面上。瞬时抖动仍有 2 次重试。
- **部署**：从 npm 平台包按版本下载 claude（x64 / arm64 / musl 自动匹配），可选
  npmmirror、腾讯云、华为云或官方 registry；下载后按官方 `dist.integrity`（sha512）校验，
  镜像被换包会直接失败；安装中可以取消，临时目录会被清理。
- **技能**：读写 SKILL.md——个人技能（对所有会话生效，落在 `CCWEB_CLAUDE_HOME/.claude/skills`）
  与项目技能（跟着当前工作区走）；claude.ai 同步来的技能只读。改完热加载，无需重启会话。
- 设置页不再展示运行环境 / 数据目录等诊断信息。

右上角「更多」是下拉菜单：「复制会话为 Markdown」与「下载 Session 日志」（zip，
即 claude 原始转录）；设置入口只在侧栏底部。浏览器标题默认
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

已添加的模型汇总到输入框工具条上的**模型菜单**（参照 DSH 的两级菜单）：一级是
「模型」「推理等级」两行，模型页按提供商分组列出，推理等级页列出该模型的档位。
档位列表对齐 DSH：**默认** + 设置里为该模型声明的档位，默认选中「默认」——即不向 API
声明推理等级。模型没有声明档位时不出现推理等级这一行。
选中的那个就是 claude CLI 的**默认模型**——后端把它写进 `ANTHROPIC_MODEL`
（同时把 opus/sonnet/haiku 三个别名也指向它），CLI 因此固定使用它，不再暴露内置模型列表。
推理等级随进程启动生效，切换后当前会话会按同一 id 重开（上下文保留）；菜单里不展示图片能力标记。

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
  conversations.json  # 对话元数据：标题/归档/删除/最近活跃（0600）
  claude/             # claude 的 HOME：登录态、~/.claude/projects 转录
```

会话转录读 `$CCWEB_CLAUDE_HOME/.claude/projects/**/*.jsonl`；侧栏的归档/重命名等状态
读 `conversations.json`。把 `CCWEB_CLAUDE_HOME` 指回 `$HOME` 可复用操作者已有的登录态
（但数据就不再集中）。

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
    history/            读取 ~/.claude/projects/**/*.jsonl（摘要 + 转录回放 + 子代理旁路转录）
    conversation/       对话元数据（conversations.json：归档/删除/重命名/最近活跃/用量快照）
    project/            工作目录枚举与校验、目录浏览器
    workspace/          授权目录与当前工作区（workspaces.json）
    settings/           持久化配置（提供商/模型/密钥/界面偏好/代理）+ 端点探测
    fsapi/              右侧栏文件树 / 预览的路径围栏
    gitctl/             右侧栏 Git 面板（系统 git CLI）
    terminal/           右侧栏 Linux PTY 终端
    claudebin/          claude 版本管理（npm 平台包下载、sha512 校验、切换）
    skills/             技能管理（个人 + 项目 SKILL.md，synced 只读）
    authz/              Bearer / query token 鉴权
    webui/              前端产物内嵌（go:embed）
frontend/
  src/transport/        线上协议类型 + WebSocket 客户端（含内置终端的二进制帧客户端）
  src/lib/              纯函数：消息归一化、diff、路径解析、i18n、主题、用量换算、子代理收集
  src/store/            zustand 全局状态（对话 / 右侧栏 / 技能）
  src/components/       布局 / 聊天 / 工具卡片 / 审批 / 右侧栏 / 设置分页
```

## 协议要点（做二次开发必读）

- 启动参数必须带 `--permission-prompt-tool stdio`，否则审批请求不会到达前端。
- 客户端必须先发 `initialize` 控制请求，**否则 CLI 一个字节都不输出**。
- `control_request` 的 `request_id` 在顶层；`control_response` 的在 `response.request_id`。
- `--include-partial-messages` 会先给逐字增量、再给完整消息，前端必须「替换」而非「追加」。
- 推理强度没有对应的控制请求（控制协议里没有 `set_effort`），只能通过启动参数 `--effort`
  固定；所以改档位是「关掉进程 + 同一 id `--resume` 重开」，不是热切换。
- WebSocket 断开后前端按指数退避自动重连，并用 ping/pong 心跳清理半开连接。

更多细节见三份 `AGENTS.md`。

## 许可证

Apache-2.0，见 [LICENSE](./LICENSE)。
