# frontend/AGENTS.md — 前端规范

技术栈：**React 19 + TypeScript + Vite 7 + Tailwind CSS v4 + zustand + Vitest**。
不引 UI 组件库（消息外壳、气泡、折叠、Markdown 都是自研），保持包体小、便于内嵌。

## 1. 目录职责

```
src/
  main.tsx             挂载入口
  App.tsx              壳层：加载 / 令牌门 / 侧边栏 / 内容区
  transport/types.ts   与后端、claude 的线上协议类型（唯一真源）
  transport/client.ts  WebSocket 客户端（只管收发，不含业务）
  transport/terminal.ts 内置终端 WebSocket 客户端（二进制输出 + JSON 控制帧）
  lib/model.ts         渲染模型（Item 联合类型）
  lib/normalize.ts     CLI 原始消息 → Item（纯函数，最重要的可测单元）
  lib/diff.ts          Edit 卡片的 diff 构造
  lib/runtime.ts       baseurl / token / fetch 封装
  lib/i18n.tsx         极简双语（useT(中文, English)）
  lib/theme.ts         主题/字号/语言的 DOM 应用与缓存
  lib/providerForm.ts  提供商/模型元数据表单转换
  lib/providerCatalog.ts 预置第三方提供商目录（对齐 DSH 的 pi-ai catalog）
  lib/attachments.ts   附件类型/大小/读取
  lib/workspace.ts     文件路径/porcelain 分组/unified diff 解析（纯函数）
  lib/conversations.ts 对话归属/最近对话排序（纯函数）
  lib/fnos.ts          飞牛宿主桥接：目录授权（authorizeUserFile）+ 回包归一化（纯函数部分可测）
  assets/claude-code.svg 左侧栏品牌图标
  store/useAppStore.ts zustand 全局状态（只做状态搬运）
  store/useSidebarStore.ts 右侧栏数据（文件树/Git/预览，所有 fetch 收敛在这里）
  store/useSkillsStore.ts  设置页技能数据（/api/skills 的列表与正文）
  components/layout/Sidebar.tsx 工作区/对话列表、重命名/归档/删除菜单
  components/right/    RightSidebar（标签页）/ FilesPanel / GitPanel / TerminalView（单个终端会话）
  components/common/   共享 UI 原语：Dialog / SystemDialogs / Select / Menu / Button / Icons / StateDot
  components/          layout / chat / tools / permission / settings
```

**分层规则**：组件不直接调 `fetch` 或 `WebSocket`；一律经 store / transport；
协议解析一律进 `lib/`，组件只消费 `Item`。右侧栏的 fetch 在 `useSidebarStore`，
终端 WS 在 `transport/terminal.ts`（终端是唯一需要真实字节流的例外）。

## 2. 不可破坏的约定

1. **路径必须经 `runtimeBase()`**。不要写 `/api/...` 绝对路径，也不要用 `import.meta.env.BASE_URL`
   —— 前缀是运行期由后端 `<base href>` 注入的。
2. **`lib/normalize.ts` 的「替换而非追加」不能退化**。流式增量与完整消息是两套数据，
   追加会导致每句话重复显示。
3. **工具卡片必须保留 `GenericCard` 兜底**。工具集会随 CLI 版本漂移，
   禁止硬编码工具清单；新增工具只在 `ToolCardHost` 的 registry 加一行。
4. **未知消息类型静默忽略**，不要 throw —— 协议会演进。
5. **令牌只存 localStorage**，并通过 `?token=` 传给 WS（浏览器限制，无法设头）。
6. **不要用 `dangerouslySetInnerHTML`**。Markdown 渲染走 React 节点（`common/Markdown.tsx`）。
7. 用户可见文案走 `useT()`：`t("中文", "English")`；默认中文，测试未挂 Provider 时也是中文。
   新增文案不要只写中文。
8. 主题由 `<html data-theme="light|dark">` 决定，Tailwind 的 `dark:` 已绑定该属性；
   禁止再用 `@media (prefers-color-scheme: dark)` 覆盖设计令牌。
9. 强调色是陶土色 `#D97757`，统一用 `bg-brand/text-brand/border-brand`。
10. 移动端输入区必须保留 `env(safe-area-inset-bottom)`；设置页底部操作栏同样要留安全区。
11. 不要加呼吸灯/无限 pulse 动画；状态点用静态圆点，流式光标也不闪烁。
    **唯一例外**是对话「进行中」的进度环（`common/StateDot` 的 `ongoing`：1.5s 匀速旋转 +
    弧长呼吸，对齐 DSH 的 StateDot），它表达的是「正在干活」而不是装饰；必须在
    `prefers-reduced-motion: reduce` 下停成静态弧。新增任何循环动画前先想清楚这一点。
12. 输入框 `+` 是**添加菜单**（`common/Menu`，宽 320、窄屏自适应）：本地文件/图片、
    从飞牛选择、claude 指令（中文短说明见 `lib/labels.commandDescription`，未收录的回落
    CLI 原文）；
    " / " 仍由用户键入触发补全。从飞牛挑中的图片/PDF 走 `readHostFile`（`POST /api/fs/host-file`，
    后端只放行这两类）转成附件，其余类型只把路径写进消息——不要在前端读任意宿主文件。
13. **右侧栏是标签页**：顶部一排标签（文件 / Git / 每个终端各一个），`+` 菜单开新标签，
    标签自带 × 关闭；文件与 Git 是单例，终端每次都新建（上限 8，标签名 `bash`、`bash 2`…）。
    **切标签只切 `hidden`、不卸载**：终端里挂着 PTY，卸载等于杀 shell；关标签才结束进程。
    不要再加「启动页 + 返回」式的切换。Git 只拉不推（`/api/git/pull`，`pull --ff-only`）。
14. 文件树/Git 面板的所有请求走 `useSidebarStore`；路径使用后端返回的 POSIX 相对路径，
    不要自己拼绝对路径。切换工作区由 `RightSidebar` 统一 `setCwd`，子面板不要重复调用。
15. Git 的 `MM` 文件必须同时出现在暂存与更改两组，各自用本侧行数；不要把两侧相加。
    `lib/workspace.ts` 的 `groupChanges` 是唯一分组入口。
16. **对话 id 是稳定 UUID**：新建由后端生成并同时用于 `--session-id`；打开旧对话必须
    `POST /api/session {resume:id}`，不能用 ensure/create 顶替。localStorage 的
    `ccweb-active-session` 存的就是这个 id。
17. **打开对话先回放 transcript 再连 WS**：`--resume` 不会回放历史；`openConversation`
    会读 `/api/history/transcript` 并用 `applyCLI(items,line,timestamp)` 折叠。切换对话时
    如果 `items[id]` 已有内容就不要再回放，避免重复。
18. **列表标题**走 `conversationTitle(自定义标题, items, locale)`：自定义 > 首条用户消息 >
    “新对话”。不要用目录名当空对话标题。
19. **归档/删除后**要刷新对话列表；删除是软删除，前端不要把转录当作可删除文件。
    当前对话被归档/删除时，打开同工作区下一条非归档对话；没有就回到新对话空态。
20. **添加授权目录：能读写就不申请授权**。应用以独立应用用户运行，用户能浏览不代表
    claude 能读写，所以提交前先 `probeDir(target)` → `POST /api/fs/access`：`writable`
    就直接登记（应用自己的数据目录、已授权共享、刚建的空文件夹都是这种），不再弹飞牛
    确认页。`writable=false` 才走飞牛 `authorizeUserFile(path)` 补 ACL（前端宿主桥接，
    后端 `trim.file.*` 只能查/删，不能授权），授权被取消/报错就不许登记工作区；探测
    本身失败按未授权处理，拿不到宿主（直连端口、`make dev`）才降级放行。
    不做版本分流：不按飞牛 App / 系统版本换通路。
    「选择飞牛目录」是 `pickUserFile`（挑选即授权）：挑完只在弹窗里进入该目录，
    不自动登记 / 关弹窗 / 进新对话，登记仍由用户点「添加」；「新建文件夹」
    走 `mkdirDir` → `POST /api/fs/mkdir`。工作区行的「更多」菜单只有重命名 / 在文件夹显示 /
    删除工作区三项，别把会话菜单的归档/结束进程混进去。

## 3. 状态管理（zustand）

- 每个会话的消息独立存 `items[sid]`，切换会话不重新拉取；
- WebSocket 实例放在**模块级 `Map`**，不进 store（避免被当成可序列化数据）；
- store 的 action 只做三件事：调 API、转发命令、把事件交给纯函数；
- **对话列表**存 `conversations`（后端合并转录+元数据+live），`openConversation(id)` 负责
  `--resume`、切换工作区、回放 transcript、连接 WS；组件不要自己调 `/api/session`。
- 新建对话用 `createSession`；空对话等首条 prompt 才由后端落元数据，前端不要提前 touch。
- **工作区行本身就是展开/收起开关**，不要再放单独的箭头按钮；点击只切当前工作区，
  `ensureSession(dir, false)` 在没有对话时保持空态，不自动起 claude。
- **已经在一个空的新对话里时，再点「新对话」是 no-op**：否则会新建进程再把旧空壳关掉，
  界面会闪一下。
- **新建对话页居中**（参照 DSH）：没有 activeId 时 `ChatPane` 把品牌 / 工作区选择器 /
  `Composer` 一起垂直居中（`flex-1` + `my-auto`，内容过高时回落成可滚动，不会裁掉顶部），
  有对话时才回到贴底布局。上方 `WorkspacePicker` 选中工作区走既有的 `startConversationIn`
  （切当前工作区 + 在该目录新建对话）：只切不建会让首条消息落到 `ensureSession` 的
  「恢复最近对话」上，用户明明选了工作区却进了旧对话。
- **Git 多仓库**：`loadRepos()` 拉 `/api/git/repos`，`pickRepo()`（纯函数，`lib/workspace.ts`）
  决定默认选中（保持当前 > 工作区根 > 第一个）；之后所有 git 请求的 cwd 都用
  `repo || cwd`（`gitCwd()`），文件树仍用工作区 `cwd`。
- **侧栏状态标记**（`lib/conversations.conversationStatus`，优先级从高到低）：待审批 →
  强调色圆点；进程 `busy`/`starting` → 进度环；完成但没看过 → 绿点；活跃但空闲 → 不画点；
  没有常驻进程 → 灰点。「完成未看」由 `applyEvent` 在 `result` 到达且该对话不是当前打开的
  那条时置位（`doneIds`），`setActive` 打开即清除——不清就会永远挂着绿点。
- 新增事件类型：先改 `transport/types.ts` → 再在 `applyEvent` 里分支 → 最后补测试。

## 4. 消息模型（Item）

| kind | 来源 | 渲染 |
|---|---|---|
| `user` | 本地插入 / CLI 回显去重 | 右对齐浅色气泡 |
| `assistant` | `assistant.content[].text` 或 `stream_event` 增量 | 左对齐气泡 + Markdown，`streaming` 时显示光标 |
| `thinking` | `assistant.content[].thinking` | 折叠块 |
| `tool` | `assistant.content[].tool_use` + `user.content[].tool_result` | 按工具名分派卡片 |
| `result` | `result` 消息 | 耗时/被拒数（不显示费用） |
| `system` | `system`（非 init/status） | 等宽小字，需清洗 ANSI |
| `error` | 后端 `error` 事件 / 连接关闭 | 红色提示 |

`tool_use` 与 `tool_result` 靠 `tool_use_id` 配对，卡片在结果到达前显示「运行中…」。

## 5. 审批面板

`PermissionPanel` 的按钮**由后端的 `permission_suggestions` 决定**，不要凭空生成：

- 总有「仅此次允许」`{allow:true}`、或「拒绝」`{allow:false,message}`；
- 有 `addRules` → 显示「始终允许 xxx」，回包带 `updatedPermissions`；
- 有 `setMode` 且无 `addRules` → 显示「切到 xxx 模式」，同时发一条 `permission_mode`；
- 「编辑后运行」：把 `input` 当 JSON 编辑，回包带 `updatedInput`（后端会透传给 CLI）。

不要把它做成简单的「是/否」——那会丢掉本项目相对 TUI 的增强点。

## 6. 样式

- Tailwind v4（`@tailwindcss/vite` + `@import "tailwindcss"`），无 `tailwind.config.js`。
- 颜色用语义令牌（`bg-canvas/panel/ink/line/brand`），强调色 `#D97757`；不要写死 slate/blue。
- 深色主题只认 `<html data-theme="dark">`；系统跟随在 `lib/theme.ts` 解析后写入。
- 移动端优先：侧边栏在 `md` 以下变成抽屉；输入框用 `max-h` 限制高度；
  输入区、设置页底部栏都要留 `env(safe-area-inset-bottom)`。
- 长输出必须折叠或限高（`max-h-80 overflow-auto`），否则会毁掉滚动体验。
- 设置页是居中模态（移动端全屏），左导航分「通用 / 模型 / 技能 / 代理 / 部署」；通用设置即时保存，
  模型配置在底部「保存模型设置」统一提交，代理保存后重启所有 claude 会话。
  「部署」页管 claude 版本（下载源 / 安装进度 / 切换生效版本），切换只影响之后新建的会话。
  「技能」页读写 SKILL.md（`store/useSkillsStore.ts` 收敛请求）：个人技能对所有会话生效，
  项目技能跟着当前工作区走；claude.ai 同步来的只读。改完 claude 会在当前会话内热加载，
  不要提示用户重启。
- 模型页提供商只有一个时默认展开，多个时默认折叠；新建提供商可以选预置（自动填
  ID / 协议 / Base URL / 默认模型）或选「自定义」手填 ID；显示名留空跟随 ID。
  预置里标「需兼容端点」的只适合拉模型列表，claude 对话需要 Anthropic 兼容端点。
  每个模型可填上下文窗口 / 最大输出（`128K` / `1M` 写法），从网关拉取时用
  `context_length` / `max_output_tokens` 预填。
- 聊天页的模型与推理等级是 `components/chat/ModelMenu.tsx` 的两级菜单（参照 DSH）：
  一级「模型 / 推理等级」，模型页按提供商分组；菜单里不展示图片能力标记。
- 右上角「更多」是下拉菜单（复制会话为 Markdown / 设置），不要直接打开设置。
- **全局禁用浏览器自动填充**：`lib/autofill.ts` 在 `App` 挂载时给所有
  `input/textarea` 补 `autocomplete=off`（密码框用 `new-password`）与主流密码管理器的
  ignore 标记；新增输入框不用再逐个手写。
- **不许用浏览器原生控件承载 UI**：
  - 模态统一 `components/common/Dialog.tsx`（遮罩、标题区、滚动体、底部栏、Esc/遮罩关闭、
    背景滚动锁、移动端底部安全区都在里面）。不要再手写 `fixed inset-0 … rounded-t-2xl`。
  - 下拉统一 `components/common/Select.tsx`（自绘 listbox + 键盘 ↑↓/Enter/Esc），
    **禁止 `<select>`**——原生展开面板由系统绘制，深浅色/字号/圆角都不受主题控制。
  - 弹出菜单统一 `components/common/Menu.tsx`（Portal + 视口夹取 + 下方放不下时向上翻 +
    点外部/Esc 关闭），不要在组件里各写一套 document 监听。**向上翻要用 `bottom` 锚定
    底边**（`anchoredPosition` 已这么做）：按估算高度算 `top` 会让高菜单飘到视口顶端、
    和触发器脱节。菜单高度上限由定位层给出（`panelMaxHeight()`），内部滚动。
  - 确认 / 输入走 `askConfirm` / `askPrompt`（`SystemDialogs` 在 `App` 挂一次），
    **禁止 `window.confirm` / `window.prompt` / `window.alert`**。
  - 按钮统一 `components/common/Button.tsx`（primary/secondary/ghost/danger + sm/md），
    新代码不要再复制 `bg-brand px-4 py-2 …` 这类串。
- `document.title` 默认 `Claude Code`，有活动会话时跟随会话名；结果条不显示费用。

## 7. 测试

```bash
cd frontend && npx vitest run      # 全部
npx vitest run src/lib             # 只跑纯函数
npx tsc --noEmit                   # 类型检查（构建也依赖它）
```

要求：

- **`lib/` 下的纯函数必须有单测**：`normalize`（流式去重、tool 配对、ANSI 清洗、
  未知类型忽略）、`diff`（结构化补丁 / old-new 兜底 / null 降级）、`runtime`（base、wsUrl、token）、
  `providerForm`（模型元数据/补丁/强度回落）、`theme`（system 解析/字号夹取）、`labels`（中英）、
  `attachments`（类型/大小/格式化）、`sessionExport`（Markdown 导出）。
- 右侧栏纯函数（`workspace`）覆盖 statusOfXY、MM 双分组、unified diff 行号、预览类型。
- 对话纯函数（`conversations`）覆盖工作区归属/最长匹配/归档跳过；`labels` 覆盖
  `conversationTitle` 的三级回落；`normalize` 覆盖 transcript 时间戳保留。
- **组件用 Testing Library**，断言用户可见的结果（文本、按钮），不要断言内部 state。
- 改 `normalize` 时先写一个会失败的用例，再改实现。
- 不要写依赖 `Date.now()` 精确值的断言。

## 8. 常见错误对照

| 现象 | 原因 |
|---|---|
| 每句话显示两遍 | 流式增量与完整消息都被追加了 |
| 工具卡片永远「运行中…」 | `tool_use_id` 没对上，或结果消息被当成纯文本 |
| 新工具显示空白 | 忘了 `GenericCard` 兜底 / 没注册 |
| 部署到子路径后资源 404 | 用了绝对路径，没走 `runtimeBase()` |
| 审批按钮点了没反应 | WS 未连接（`conn !== "open"`），或 `request_id` 传丢 |
| 类型检查报 CSS 导入 | 缺 `src/vite-env.d.ts` |
| 弹窗/下拉在深色主题下跟页面脱节 | 用了 `window.confirm` / `<select>` 等原生控件 |
