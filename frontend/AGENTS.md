# frontend/AGENTS.md — 前端规范

技术栈：**React 19 + TypeScript 7 + Vite 8 + Tailwind CSS v4 + zustand + Vitest 5（jsdom 31）**。
不引 UI 组件库（消息外壳、气泡、折叠、Markdown 都是自研），保持包体小、便于内嵌。

构建链要求 Node ≥ 22（Vite 8 的门槛）。升级依赖时按「`npx tsc --noEmit` → `npx vitest run` →
`make dev`」三步验；Vite 8 换成了 rolldown，若 `vite.config.ts` 报插件类型不兼容，先确认
vitest 没有再嵌一份旧 vite（`npm ls vite` 应该只有一个版本）。

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
  lib/queue.ts         待发送（插话）队列：入队/删除/编辑/队首、何时能自动发
  lib/autofill.ts      全局禁用浏览器/密码管理器自动填充（App 挂载时补属性）
  lib/clipboard.ts     复制文本（Clipboard API → execCommand 回退）
  lib/download.ts      带鉴权的文件下载（fetch → blob → <a download>，token 走头）
  lib/newChat.ts       「新对话」判定（按对话元数据，不是 items 是否为空）
  lib/permissionModes.ts 权限模式判定与危险模式标记（唯一入口）
  lib/sessionExport.ts 会话导出 Markdown（右上角「更多」菜单）
  lib/sidebarView.ts   左侧栏视图偏好：分组/排序/归档筛选 + 手动顺序（纯函数 + localStorage）
  lib/subagents.ts     从消息流收集子代理（页头计数 / 审批归属，纯函数）
  lib/turns.ts         「轮」的切分与视口所在轮（对话区刻度跳转，纯函数）
  lib/usage.ts         用量换算：上下文/缓存命中/tok/s（只从 CLI 的 usage 派生）
  lib/workspace.ts     文件路径/porcelain 分组/unified diff 解析（纯函数）
  lib/conversations.ts 对话归属/最近对话排序（纯函数）
  lib/labels.ts        界面词汇表 / claude 指令中文说明（conversationTitle 等）
  lib/mcpForm.ts       MCP 表单转换：参数/环境变量的文本互转、校验、一行摘要
  lib/plugins.ts       插件响应兜底、目录查询串、id 拆分（纯函数）
  lib/fnos.ts          飞牛宿主桥接：目录授权（authorizeUserFile）+ 回包归一化（纯函数部分可测）
  assets/claude-code.svg 左侧栏品牌图标
  store/useAppStore.ts zustand 全局状态（只做状态搬运）
  store/useSidebarStore.ts 右侧栏数据（文件树/Git/预览，所有 fetch 收敛在这里）
  store/useSkillsStore.ts  设置页技能数据（/api/skills 的列表与正文）
  store/useMcpStore.ts     设置页 MCP 数据（/api/mcp 的列表、探测结果、停用开关）
  store/useSearchStore.ts  内置搜索数据（/api/search 的配置、测试结果、注册状态）
  store/usePluginStore.ts  设置页插件数据（/api/plugins 的列表/任务轮询/详情）
  components/common/   共享 UI 原语：Dialog / SystemDialogs / Select / Menu / Button / Icons / StateDot
                       / Collapsible（折叠块）/ FileIcon（按扩展名给颜色的文件图标 + 文件夹图标）
                       / ErrorBoundary（渲染异常兜底，挂在 main.tsx 最外层）
  components/layout/   Sidebar（工作区/对话列表）/ ConversationPreview（会话悬浮预览）/ TopBar / TokenGate / SettingsDrawer（只留导航壳）
                       / WorkspaceDialog / SkillsSettings / PluginsSettings / McpSettings / SearchSettings / DeploySettings / HistoryDialog
                       / ClaudeInstallPrompt
  components/layout/settings/  设置页分区：GeneralSettings / ModelsSettings / ProxySettings / Section（共用分区标题）
  components/chat/     ChatPane / MessageList / Composer / bubbles / ThinkingBlock / ModelMenu
                       / UsageStats / ResultBar / WorkspacePicker
  components/tools/    ToolCardHost（注册表）/ AgentCard / BashCard / EditCard / GenericCard（兜底）
  components/permission/ PermissionPanel（按钮由 permission_suggestions 决定）
  components/right/    RightSidebar（标签页）/ FilesPanel / GitPanel / TerminalView / SubagentPanel
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
   `index.html` 的启动兜底（白屏自我解释）同样只能用 `textContent`：它显示的是未捕获异常
   信息 / 资源地址，里面可能带着工作区文件名或服务端报文，拼成 HTML 就等于给了工作区内容
   一个在本应用同源里执行脚本的机会（能读走 localStorage 里的 token）。
7. 用户可见文案走 `useT()`：`t("中文", "English")`；默认中文，测试未挂 Provider 时也是中文。
   新增文案不要只写中文。
8. 主题由 `<html data-theme="light|dark">` 决定，Tailwind 的 `dark:` 已绑定该属性；
   禁止再用 `@media (prefers-color-scheme: dark)` 覆盖设计令牌。
   **主题偏好只存浏览器**（`ccweb-theme-pref`，`lib/theme.ts` 的 `themePreference` /
   `setThemePreference`），不进 `settings.json`：设置页切主题不调后端，`applyPreferences`
   也绝不读 `settings.theme`。`index.html` 的启动脚本读同一份缓存，避免闪白。
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
13. **右侧栏是「开始页 + 标签页」**：没有标签时显示开始页——工作区文件 / Git / 新建终端
    三张卡片，**不要自动打开「文件」标签**；栅格用**容器查询**（`@container` +
    `@min-[21rem]:grid-cols-2`）而不是视口断点：右侧栏宽度是拖出来的，与 viewport 无关，
    窄了排成一列，否则描述会被折成「浏览工作区文 / 件」这种断字。描述仍要短到一行放得下；
    点卡片或 `+` 菜单才开标签。顶部一排标签（文件 / Git / 每个终端各一个），
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
    当前对话被归档时**回到「新对话」页**（`setActive(null)`，localStorage 的
    `ccweb-active-session` 一并清掉），**不要**自动打开同工作区的下一条：那个「下一条」只是
    按最近活跃猜的，用户归档完想停下时却被拉进另一个对话、又起一个 claude 进程。
    删除当前对话仍打开该工作区的下一条（没有就空态）——删除的意图是「继续干活」。
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
21. **文件图标走 `common/FileIcon`**（`FileIcon` / `FolderIcon` / `classifyFile`）：
    颜色区分语言、形状区分类别（参考 DSH 的 `FileTypeIcon` + `classifyFileType`）。
    文件树、Git 列表、预览标题都用它，不要再退回单一的 `IconFile`；图标一律 `aria-hidden`。
22. **危险权限模式必须标红 + 二次确认**：`dontAsk`（不询问）与 `bypassPermissions`（跳过权限）
    会让命令不经审批直接执行，误点一次就已经跑完了。`lib/permissionModes.ts` 是唯一判定入口，
    下拉选项带 `danger`（触发器与菜单项都变红），切换前用 `askConfirm` 弹一句人话说明。
    新增设置权限模式的入口也必须走同一套。
    **权限模式菜单没有「空模式」**：`""` 与 `default` 在 CLI 侧等价（不传参数就是 default），
    以前并排列出「标准模式 / 默认模式」两项，既重复、选中空值还会让后端报「mode 为空」。
    现在只列 default/acceptEdits/plan/dontAsk/bypassPermissions，`permissionLabel("")` 按 default 显示。
    **模式是会话级实时切换，不是「新会话生效」**：claude 的控制协议有 `set_permission_mode`
    （实测 2.1.325 连进行中的回合也接受，从下一次工具判定起生效），所以菜单直接发
    `{kind:"permission_mode"}`。界面显示的当前模式**只认 CLI 上报的值**（`store.modes`：
    `session.state` 带来的 `system/status`，加上重连快照的 `info.mode`）——模型自己
    `ExitPlanMode`、回包被拒、进程重启换回默认模式，都只有 CLI 知道，界面自己记一份必然飘。
    没有活着的进程（新对话 / 会话已结束）时，切换写进 `settings.permission_mode`
    （设置页的「默认权限」），建会话时生效，否则在新对话里选模式等于什么都没发生。
    **「跳过权限」要求会话启动时带 `--allow-dangerously-skip-permissions`**
    （`process.Args` 里按版本探测后一直带；它只开能力、不会以 bypass 启动），
    没带的会话切过去会被 CLI 拒绝——后端现在已经等回包，错误会原样显示在对话里。
23. **左侧栏的「分组 / 排序 / 筛选」走 `lib/sidebarView.ts`**：分组（按工作区 / 按工作区树 /
    单列表）、排序（手动 / 最近更新）、筛选（隐藏已归档 / 全部 / 仅已归档）三种偏好存在
    localStorage（`ccweb-sidebar-view`），手动顺序存在 `ccweb-session-order`
    （按工作区路径分键，单列表用 `__flat__`）。手动排序的入口有两个：桌面拖拽 +
    会话「更多」菜单里的上移/下移（触屏没有拖拽）。视图偏好是**每台设备**的，不进后端。
24. **回合进行中的消息走「待发送」队列，不许直接写 stdin 之外的地方**（`lib/queue.ts` +
    `store.queued`）：插话要带 **`priority: "now"`**（`sendPrompt` 的第 4 个参数）——只写裸
    user 帧的话 CLI 按默认的 next 处理，要等本轮工具收尾，看起来跟排队一样（「插话没生效」
    就是这么来的）。`Composer` 在 `busy` 时按 Enter 只调 `onQueue`（草稿清空，消息进输入框
    **上方**的待发送面板），`Ctrl/⌘+Enter` 才是 `onSend`（立刻插话）。面板每条**点正文就地展开
    编辑框**（Enter 保存 / Shift+Enter 换行 / Esc 取消，`lib/queue.updatePrompt` 保持位置；正文与
    附件都清空等于删掉，附件可逐个移除）、右侧垃圾桶直接删（编辑态里也有「删除」）、可用右侧箭头立即发。编辑态要调
    `onEditingQueued(qid|null)`：store 会**按住自动发送**（`editingQueuedId`），编辑结束后补发——
    不按住的话这一轮结束时会把改到一半的旧文本发出去。
    **进行中且有草稿（`hasDraft` = 正文或附件非空）时，右下角主按钮必须是「发送（排队）」，中断缩成
    旁边的 28px 小圆钮**：手机键盘的回车是换行，只给中断就等于没法插话；草稿清空后再换回单一中断。
    投递时机由 store 决定：**只有「本轮正常结束的 `result`」发队首**（判定在
    `lib/queue.shouldFlushAfter`），被中断/出错时留在队列里；`session.state ready`、切对话、
    重连都**不**触发——那会在用户按 Esc 之后偷偷把消息发出去。队列跟着对话走（`queued[sid]`），
    上限 `MAX_QUEUED`（8 条，附件是 base64 常驻内存），只在内存里、刷新即丢（与草稿一致）。
25. **首屏只留壳层，重的面板按需加载**：`App.tsx` 对 SettingsDrawer / RightSidebar /
    WorkspaceDialog / HistoryDialog 一律 `lazy()` + `Suspense`，不要改回静态 import——
    这几块占了首屏包体的一半（实测主 chunk 604 KB → 382 KB，gzip 173 KB → 118 KB）。
    模态用 `useLazyMount`：**首次打开才挂载，之后保持挂载**，关闭再打开不会丢表单状态。
26. **设置页按页签懒加载**：`SettingsDrawer` 只剩导航壳，每页在自己首次被访问时挂载
    （`visited` 集合）并动态 import。各页 `useEffect` 一挂载就发请求（技能、插件目录、
    MCP、搜索），全部常驻会让「打开设置」变成一次并发拉取，插件目录首次还可能联网十几秒。
    新增页签照这个模式加，不要写成「全部渲染 + hidden」。
    `Section`（分区标题 + 说明）统一在 `settings/Section.tsx`，不要再在页面里各写一份。
27. **键盘焦点必须可见**：全局 `:focus-visible` 兜底在 `styles.css` 末尾（无 layer，
    优先于 utilities），所以页面上那 30 多个 `outline-none` 只影响鼠标。新增输入控件
    不需要自己写 focus 样式，也不要用 `!important` 去盖掉那条规则。
28. **会话起不来 ≠ 历史读不到**：`openConversation` 在 `POST /api/session` 失败
    （claude 未安装 / 版本被删 / 409 并发冲突）时仍然要 `loadTranscript()` 回放转录，
    然后再报错。少了这一步，界面会显示「开始新的对话」，看起来像整段对话被弄丢。

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
- **新建对话页居中**（参照 DSH）：只要当前对话还没开始（`lib/newChat.ts` 的 `isNewChat`：
  没有 activeId，或对话 `messages === 0 && !title` 且 items 为空）`ChatPane` 就把品牌 / 工作区选择器 /
  `Composer` 一起垂直居中（`flex-1` + `my-auto`，内容过高时回落成可滚动，不会裁掉顶部），
  已经有消息时才回到贴底布局。**判定要看对话元数据，不能只看 items 是否为空**：
  打开旧对话时转录是异步拉回来的，只看 items 会让每次点开历史对话先闪一下新对话页。
  上方 `WorkspacePicker` 选中工作区走既有的 `startConversationIn`（切当前工作区 +
  在该目录新建对话）：只切不建会让首条消息落到 `ensureSession` 的「恢复最近对话」上，
  用户明明选了工作区却进了旧对话。
- **Git 多仓库**：`loadRepos()` 拉 `/api/git/repos`，`pickRepo()`（纯函数，`lib/workspace.ts`）
  决定默认选中（保持当前 > 工作区根 > 第一个）；之后所有 git 请求的 cwd 都用
  `repo || cwd`（`gitCwd()`），文件树仍用工作区 `cwd`。
- **会话悬浮预览**：鼠标在会话行上停 220ms 弹 `ConversationPreview`（标题 + 工作区/时间/条数 +
  最近一问一答），离开/滚动/点击即收；触屏没有 hover 不显示；卡片 `pointer-events-none`，
  不挡点击。内容来自 `GET /api/history/preview`（后端只读转录尾部 64KB，不进列表接口），
  前端按 id 缓存，一轮结束后（`result`）清掉该 id 的缓存。
- **会话行的两套显示（对齐 DSH）**：桌面（`md` 以上）不悬停只显示相对时间，
  悬停 / 键盘聚焦 / 该行菜单打开时换成操作组「归档 · 置顶 · ⋯」；触屏没有 hover，
  只有时间与「⋯」常驻（归档 / 置顶在菜单里也能点，那是触屏唯一的入口）。
  操作组用 `md:hidden` ↔ `md:group-hover/session:flex` 切换（`display` 而不是 `opacity`）：
  三颗按钮必须真的把时间和标题挤掉，用透明度叠在时间槽上会盖住长标题。
  **右键会话行等同点「⋯」**（`onContextMenu` → 同一个菜单，锚在整行上，并顺手收掉悬浮预览）
  ——不要把右键做成第二套菜单，也不要只在按钮上挂事件。
- **置顶（`pinned`）只是排序偏好**（`lib/conversations.pinnedFirst`）：两种排序模式都先过它，
  置顶的永远在同一组最前，组内顺序保持原样；它不进 `LastFor`，不影响「默认恢复哪一条」，
  也不结束进程。行上常驻一颗小图钉表示置顶状态，取消置顶从行内按钮或菜单点。
- **侧栏状态标记**（`lib/conversations.conversationStatus`，优先级从高到低）：待审批 →
  强调色圆点；进程 `busy`/`starting` → 进度环；完成但没看过 → 绿点；活跃但空闲 → 不画点；
  没有常驻进程 → 灰点。「完成未看」由 `applyEvent` 在 `result` 到达且该对话不是当前打开的
  那条时置位（`doneIds`），`setActive` 打开即清除——不清就会永远挂着绿点。
- **用量统计只认 CLI 给的数字**（`lib/usage.ts` + `store.usage`）：`stream_event` 的
  message_start/message_delta 提供上下文与输出，`result.usage` 是回合末值，
  `result.modelUsage.<model>.contextWindow` 才是模型窗口（init 里没有）。CLI **不提供**
  「步骤数」「实时 tok/s」「官方上下文百分比」——步数用工具调用次数、tok/s 用输出 ÷ API 耗时、
  上下文用 (input+cache_read+cache_creation) ÷ contextWindow，都是同一套数据的换算，
  不要在界面上编造。
  上下文占用显示成一个小圆环（`UsageStats` 里的 `UsageRing`，≥70% 转琥珀、≥85% 转红），
  旁边跟百分比；绝对值和缓存命中率放 `title` 里。
- **用量要跟着对话持久化**：每回合结束（`result`）把快照 `PATCH /api/conversations {id, usage}`
  存进 `conversations.json`（内容没变就不发）。重开对话时：转录里的 `assistant.message.usage`
  给出最新的 token 数（更准），持久化那份补上转录里没有的 `apiMs` / `contextWindow`
  （`mergeUsage`）；实时 WS 快照优先，不覆盖。窗口再兜底用设置里的模型窗口。
  只存快照、不存派生指标——tok/s 与百分比都是算出来的。
- 新增事件类型：先改 `transport/types.ts` → 再在 `applyEvent` 里分支 → 最后补测试。
- **系统通道**：`bootstrap` 里 `openSystemChannel()` 打开一条 **不带 id** 的 `/ws`
  （`wsUrl("", token)`），只收应用级事件（`claude.update`）。它与会话连接分开：会话连接
  随对话开关（关对话、换工作区、删对话都会断），更新提示跟对话无关，没有打开任何对话时
  也要收到。系统通道的 `onEvent` 只放行 `claude.update` 再交给 `applyEvent("", ev)`——
  别的 kind 带着空 sid 会写进各会话的桶里。重连成功后补拉一次 `/api/claude/status`
  （断线期间可能发布了新版）。

## 4. 消息模型（Item）

| kind | 来源 | 渲染 |
|---|---|---|
| `user` | 本地插入 / CLI 回显去重 | 右对齐浅色气泡 |
| `assistant` | `assistant.content[].text`（一条消息可有多个 text 块，各自成段）或 `stream_event` 增量 | 左对齐气泡 + Markdown（标题/列表/表格/引用/链接/代码块），`streaming` 时显示光标 |
| `thinking` | `assistant.content[].thinking` | 折叠块 |
| `tool` | `assistant.content[].tool_use` + `user.content[].tool_result` | 按工具名分派卡片（Agent/Task 用 `AgentCard`，带子代理状态与「查看对话」） |
| `result` | `result` 消息 | 耗时/被拒数（不显示费用）；出错时显示 `result.result` 里的原因与 subtype |
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

**卡片只认 `store.perms`**：本机点「允许/拒绝」是乐观删除（`replyPermission`），
在其他设备/标签上做掉的那次由后端广播的 `permission.resolved{request_id}` 触发删除——
两条路都不能省。事件缺失的表现不是报错，而是**卡片一直挂着、一轮里越攒越多**；
`closed` 时整桶清空（进程没了，挂起的审批永远不可能被批准）。

## 6. 样式

- Tailwind v4（`@tailwindcss/vite` + `@import "tailwindcss"`），无 `tailwind.config.js`。
- 颜色用语义令牌（`bg-canvas/panel/ink/line/brand`），强调色 `#D97757`；不要写死 slate/blue。
- 深色主题只认 `<html data-theme="dark">`；系统跟随在 `lib/theme.ts` 解析后写入。
- 移动端优先：侧边栏在 `md` 以下变成抽屉；输入框用 `max-h` 限制高度；
  输入区、设置页底部栏都要留 `env(safe-area-inset-bottom)`。
- 长输出必须折叠或限高（`max-h-80 overflow-auto`），否则会毁掉滚动体验。
- **长对话只渲染最近一批**（`MessageList`）：默认 80 条，顶部「加载更早的 N 条」按批展开，
  展开时用「距底部距离」锚住视口（否则会跳一下）。每条消息是 `memo` 化的 `MessageRow`，
  流式追加只重渲染最后一条；行上带 `content-visibility: auto` + `contain-intrinsic-size`，
  离屏行不参与布局绘制。**不做自己算高度的虚拟列表**：消息高度差异太大，容易抖，
  也会破坏浏览器查找与锚点。
- **对话区右侧有轮次刻度**（`MessageList` + `lib/turns.ts`）：每条用户消息一个刻度，
  点一下跳到那一轮（被 80 条窗口截掉时会先展开再滚），当前轮用强调色加宽；悬停变宽、
  `title` 显示该轮首行。刻度出现时（≥2 轮）隐藏原生滚动条并给内容留 `pr-9`，
  避免和右对齐的用户气泡叠在一起；刻度整体 `pointer-events-none`，只有刻度本身可点，
  底部让出 64px 给「回到底部」按钮。
- **对话区右下角必须有「回到底部」按钮**（`MessageList`）：不贴底时出现，圆形、带下箭头；
  不贴底期间来了新消息时按钮上点一个强调色小圆点，`aria-label` 换成「有新内容，回到底部」。
  点击后恢复贴底跟随；`prefers-reduced-motion` 下直接跳，不做平滑滚动。
- **三栏表头统一 `h-14`（56px）**：左侧栏品牌行、对话 TopBar、右侧栏标签行在同一个 flex 行里，
  高度不一致时分隔线会错开 4px（截图里一眼能看出来）。新增表头不要再写
  `h-[58px]` / `h-[52px]` 这类魔法数字。**只有对话和右侧栏画 `border-b`**：
  左侧栏品牌区和工作区之间不画线（留白够了，画线反而把侧栏切成两截）。
- **右侧栏停靠要看视口**：`clampWidth` 除了用户拖动值与 70% 视口上限，还要给对话区留
  `MIN_CHAT_WIDTH`（420px）；视口小于 `280 + 420 + 300 = 1000px` 时改成浮层（`fixed` + 遮罩），
  不再和对话抢横向空间。不要再写死 `md:relative` 那一套。
  **宽度必须由「用户偏好 + 当前视口」派生**（`preferredWidth` 存偏好、`useViewportWidth()`
  跟踪 resize、渲染时 `clampWidth(preferredWidth, viewport)`）：只在拖动时 clamp 的话，
  窗口缩小后右侧栏不会自己变窄，会一直把对话挤成一条缝，直到用户拖一下才被纠正。
- 设置页是居中模态（移动端全屏），左导航分「通用 / 模型 / 技能 / 插件 / MCP / 代理 / 部署 / 关于」；
  「关于」页只放：一句话特性、版本号（`/api/info` 的 version）、致谢
  （DeepSeek / DeepSeek Harness / dsh-better-sidebar），以及**标题右侧的 GitHub 图标**
  （只有图标不带文字，`aria-label` 说明是仓库链接，`https://github.com/shuangji66/claudecode-webui`，
  `target=_blank` + `rel=noreferrer`）。不要再加「源码」区块或运行形态说明。
  不要把设置项塞进这一页。通用设置即时保存，
  模型配置在底部「保存模型设置」统一提交，代理保存后重启所有 claude 会话。
  「部署」页管 claude 版本（下载源 / 安装进度 / 切换生效版本），切换只影响之后新建的会话。
  「技能」页读写 SKILL.md（`store/useSkillsStore.ts` 收敛请求）：个人技能对所有会话生效，
  项目技能跟着当前工作区走；claude.ai 同步来的只读。改完 claude 会在当前会话内热加载，
  不要提示用户重启。
  「插件」页驱动 `claude plugin`（`store/usePluginStore.ts`）：已安装列表、marketplace 增删改、
  可用插件浏览、详情（组件清单 + token 成本）。**变更动作是后台任务**：发出请求后轮询
  `/api/plugins` 的 `job.phase`，期间按钮置灰；装/停用/更新后要重开会话生效。
  **轮询失败必须把 `pollTimer` 置空**：`load()` 用 `!pollTimer` 判断「要不要接着轮询」，
  定时器触发后句柄不会自己消失——不清的话一次网络抖动就让「正在安装」永久卡住，
  只能刷新页面才恢复。
  「详情」对已安装插件用 `plugin details`，未安装的只有清单文件里的信息（`inspect`）——
  文案要区分这两种来源，不要把小标题当成完整清单。
  **详情是页内视图（列表 ↔ 详情，带「返回」），不要再叠一层 Dialog**：手机上
  「设置模态 + 底部 sheet」互相盖，清单根本翻不动；页内视图还能整页滚动、直接操作
  （安装/停用/更新/卸载）。CLI 原文用 `pre` + `whitespace-pre-wrap` 自动换行，
  不要横向滚动——右侧被切掉会被当成「显示不全」。
  **「可安装」不能整段铺开**（官方市场实测 3743 条、全量 JSON 1.27 MB）：
  过滤与分页都在**服务端**（`GET /api/plugins/available`，见 `lib/plugins.ts` 的
  `availableQuery`），前端只拿一页（`AVAILABLE_PAGE_SIZE` = 20），底部「显示更多」按
  offset 追加。顶部给搜索框（250ms 防抖，别每敲一个字发一次）、市场筛选下拉、
  「只看未安装」；计数在过滤时显示「命中 / 总数」。目录缓存由后端落盘，重进设置页
  直接读缓存——不要在前端再存一份全量列表。
  插件能声明 hooks / 自带 MCP server（等于执行第三方代码），有条件时必须标红提示。
- 「MCP」页读写 claude 的两份配置文件（`store/useMcpStore.ts`）：用户级 `.claude.json`
  与项目级 `.mcp.json`，可增删改、停用/启用、探测连通性。**必须提示「重开会话才生效」**
  （MCP server 在会话启动时连接），停用项要标出来并说明「配置已摘到本应用暂存」。
  表单转换在 `lib/mcpForm.ts`（参数一行一个、环境变量 KEY=VALUE），不要塞进组件。
  「MCP」页顶部还有**内置搜索**（`SearchSettings` + `useSearchStore`）：基地址/密钥/条数、
  测试连接、注册到用户级 MCP。密钥框永远留空回填、空输入=不改，**界面上也不显示脱敏串**
  （连密钥尾巴都会在截图/录屏里流出去）：已设置只体现在 placeholder「已设置（留空不修改）」
  与「清除密钥 / 清除」按钮上。模型页的 API 密钥同理。
- 模型页提供商只有一个时默认展开，多个时默认折叠；新建提供商可以选预置（自动填
  ID / 协议 / Base URL / 默认模型）或选「自定义」手填 ID；显示名留空跟随 ID。
  预置里标「需兼容端点」的只适合拉模型列表，claude 对话需要 Anthropic 兼容端点。
  每个模型可填上下文窗口 / 最大输出（`128K` / `1M` 写法），从网关拉取时用
  `context_length` / `max_output_tokens` 预填。
- 聊天页的模型与推理等级是 `components/chat/ModelMenu.tsx` 的两级菜单（参照 DSH）：
  一级「模型 / 推理等级」，模型页按提供商分组；菜单里不展示图片能力标记。
  档位列表由 `providerForm.effortChoices` 给出：**默认（`""`，不声明推理等级）** +
  模型声明的档位；没有声明档位的模型不出现这一行。`effortFor` 遇到无效值一律回落到「默认」，
  别再回落到「模型的第一个档位」——那等于替用户向 API 声明了一个推理等级。
  **改档位不是热切换**：CLI 没有 `set_effort`，`--effort` 只在进程启动时固定，
  `selectModel` 保存后调 `applyEffortChange`（判定在 `providerForm.effortApply`）：
  空闲就 `close → POST /api/session {resume:id}` 按同一 id 重开（上下文在转录里），
  进行中只记进 `effortRestarts`，等 `result` 到达再重开——不要在 busy 时直接杀进程。
  **还没发过消息的对话没有转录，`--resume` 一定失败**：这种情况关掉后新建一个
  （`restartSession` 里单独一条分支，不能走 `createSession`——它的「已在空对话里就不新建」
  守卫会把重开挡掉）。
- 右上角「更多」是下拉菜单（复制会话为 Markdown / 下载 Session 日志），不要直接打开设置。
- **全局禁用浏览器自动填充**：`lib/autofill.ts` 在 `App` 挂载时给所有
  `input/textarea` 补 `autocomplete=off`（密码框用 `new-password`）与主流密码管理器的
  ignore 标记；新增普通输入框不用再逐个手写。
  **凭证类输入框（API 地址 / 密钥 / Bearer 令牌 / 访问令牌）必须静态写 `{...NO_AUTOFILL}`**：
  密码管理器在元素插入时就扫描，MutationObserver 的回调是微任务，晚一步 1Password
  就会弹「填充密码」浮层（截图里出现在 API 地址框上）。
- **不许用浏览器原生控件承载 UI**：
  - 模态统一 `components/common/Dialog.tsx`（遮罩、标题区、滚动体、底部栏、Esc/遮罩关闭、
    背景滚动锁、移动端底部安全区都在里面）。不要再手写 `fixed inset-0 … rounded-t-2xl`。
  - 下拉统一 `components/common/Select.tsx`（自绘 listbox + 键盘 ↑↓/Enter/Esc），
    **禁止 `<select>`**——原生展开面板由系统绘制，深浅色/字号/圆角都不受主题控制。
  - 弹出菜单统一 `components/common/Menu.tsx`（Portal + 视口夹取 + 下方放不下时向上翻 +
    点外部/Esc 关闭），不要在组件里各写一套 document 监听。**向上翻要用 `bottom` 锚定
    底边**（`anchoredPosition` 已这么做）：按估算高度算 `top` 会让高菜单飘到视口顶端、
    和触发器脱节。菜单高度上限由定位层给出（`panelMaxHeight()`），内部滚动。
    **估算高度必须把分组标题算进去**（`menuHeight()`）：漏算时估算比内容矮，明明下方
    空间够也会被裁出一条滚动条（侧栏「分组 / 排序 / 筛选」菜单就是这么踩的）。
    `panelMaxHeight()` 取 80vh / 560px：60vh 在手机竖屏只有 274px，够不着普通菜单。
  - 确认 / 输入走 `askConfirm` / `askPrompt`（`SystemDialogs` 在 `App` 挂一次），
    **禁止 `window.confirm` / `window.prompt` / `window.alert`**。
  - 按钮统一 `components/common/Button.tsx`（primary/secondary/ghost/danger + sm/md），
    新代码不要再复制 `bg-brand px-4 py-2 …` 这类串。
- `document.title` 默认 `Claude Code`，有活动会话时跟随会话名；结果条不显示费用。
- **右上角「更多」只有「复制会话为 Markdown / 下载 Session 日志」**：设置入口只在侧栏底部，
  不要再往这个菜单里加设置（曾经重复过一次）。下载走 `lib/download.ts`（token 放头里），
  后端是 `GET /api/history/export`，返回的 zip 里是 claude 原始转录，不经二次加工。

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
  `attachments`（类型/大小/格式化）、`sessionExport`（Markdown 导出）、`newChat`（按元数据判定）、
  `permissionModes`（危险模式标记）、`sidebarView`（偏好合并/手动顺序）、`clipboard`（回退路径）、
  `queue`（入队/上限/删除/编辑保序/中断或出错不自动发）、
  `autofill`、`providerCatalog`、`subagents`、`usage`、`fnos`（宿主判定三条件/回包归一化）。
- 右侧栏纯函数（`workspace`）覆盖 statusOfXY、MM 双分组、unified diff 行号、预览类型、
  `pickRepo` 默认选中。
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
