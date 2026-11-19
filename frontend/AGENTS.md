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
  lib/password.ts      访问密码复杂度判定（与后端 authz.ValidatePassword 同一规则）
  lib/access.ts        端口访问的端口范围校验（1025–65535，与后端 settings 一致）
  lib/download.ts      带鉴权的文件下载（fetch → blob → <a download>，token 走头）
  lib/newChat.ts       「新对话」判定（按对话元数据，不是 items 是否为空）
  lib/drafts.ts        输入框草稿（按对话存 localStorage，重进前端不丢；只存正文）
  lib/askQuestion.ts   模型提问（AskUserQuestion）：解析 questions、推荐标记、提交自检与答案编码（纯函数）
  lib/askDrafts.ts     模型提问的作答草稿（按 request_id 存 localStorage，切对话/重载不丢）
  lib/permissionModes.ts 权限模式判定与危险模式标记（唯一入口）
  lib/sessionExport.ts 会话导出 Markdown（右上角「更多」菜单）
  lib/sidebarView.ts   左侧栏视图偏好：分组/排序/归档筛选 + 手动顺序（纯函数 + localStorage）
  lib/fnosAuth.ts      飞牛路由授权：回调页路径判定、state、回包解析（纯函数）
  lib/dirs.ts          已授权目录页的受保护路径判定（等于/祖先/子路径，镜像后端）
  lib/ooxml.ts         OOXML 公共件：fflate 解 zip、部位路径归一、rels 解析、按本地名找元素
  lib/xlsx.ts          只读 Excel：共享字符串 / 日期格式 / 内联字符串 → 二维表（自写解析）
  lib/pptx.ts          只读 PPT：按 presentation.xml 页序取文本框与图片（自写解析）
  lib/dragImage.ts     手动排序的拖影：自己造一块与行同宽的替身交给 setDragImage
  lib/subagents.ts     从消息流收集子代理（页头计数 / 审批归属，纯函数）
  lib/turns.ts         「轮」的切分与视口所在轮（对话区刻度跳转，纯函数）
  lib/usage.ts         用量换算：上下文/缓存命中/tok/s（只从 CLI 的 usage 派生）
  lib/workspace.ts     文件路径/porcelain 分组/unified diff 解析（纯函数）
  lib/markdownMedia.ts 正文媒体地址解析：`![](路径)` 归一化成工作区相对路径（纯函数）
  lib/conversations.ts 对话归属/最近对话排序（纯函数）
  lib/labels.ts        界面词汇表 / claude 指令中文说明（conversationTitle 等）
  lib/mcpForm.ts       MCP 表单转换：参数/环境变量的文本互转、校验、一行摘要
  lib/skillsImport.ts  技能导入：从文件/相对路径推断技能名、文件类型判定、名字合法性（镜像后端）
  lib/plugins.ts       插件响应兜底、目录查询串、id 拆分（纯函数）
  lib/fnos.ts          飞牛宿主桥接：目录授权（authorizeUserFile）+ 回包归一化（纯函数部分可测）
  lib/mention.ts       输入框 `@` 引用语法：token 检测/格式化/替换/面包屑（纯函数，对齐 DSH grammar）
  assets/claude-code.svg 品牌图标：左侧栏 / 鉴权页品牌标记 + 浏览器标签页图标（index.html 的 favicon）
  store/useAppStore.ts zustand 全局状态（只做状态搬运）
  store/useSidebarStore.ts 右侧栏数据（文件树/Git/预览，所有 fetch 收敛在这里）
  store/useSkillsStore.ts  设置页技能数据（/api/skills 的列表与正文）
  store/useMcpStore.ts     设置页 MCP 数据（/api/mcp 的列表、探测结果、停用开关）
  store/useSearchStore.ts  内置搜索数据（/api/search 的配置、测试结果、注册状态）
  store/usePluginStore.ts  设置页插件数据（/api/plugins 的列表/任务轮询/详情）
  store/useDirsStore.ts    设置页「目录」数据（飞牛已授权目录的列表/撤销）
  components/common/   共享 UI 原语：Dialog / SystemDialogs / Select / Menu / Button / Icons / StateDot
                       / Collapsible（折叠块）/ FileIcon（按扩展名给颜色的文件图标 + 文件夹图标）
                       / ErrorBoundary（渲染异常兜底，挂在 main.tsx 最外层）
                       / Zoomable（ZoomBar + ZoomableImage：图片缩放条与按 zoom 撑开的图）
  components/layout/   Sidebar（工作区/对话列表）/ HoverPreview（悬浮概览外壳）/ ConversationPreview、WorkspacePreview（会话/工作区的概览内容）/ TopBar / TokenGate（访问鉴权页）/ SettingsDrawer（只留导航壳）
                       / AuthCallbackPage（飞牛授权回调页，不挂应用壳层）
                       / FeaturePage（功能区整页视图外壳 PageShell + 插件/MCP/技能三页）
                       / SchedulePage（自动化任务）/ HistoryPage（历史记录）
                       / WorkspaceDialog / SkillsSettings / PluginsSettings / McpSettings / SearchSettings / DeploySettings
                       / ClaudeInstallPrompt
  components/layout/settings/  设置页分区：GeneralSettings / ModelsSettings / DirsSettings（飞牛已授权目录）/ ProxySettings / AccessSettings（TCP 端口与访问密码）/ Section（共用分区标题 + SettingRow/SettingRows 行式设置项）
  components/chat/     ChatPane / MessageList / Composer / bubbles / ThinkingBlock / ModelMenu
                       / MentionMenu（@ 候选菜单）/ useMention（候选拉取、防抖与键盘仲裁）
                       / ImageLightbox（正文图片放大）
                       / UsageStats（环 + 用量弹层，另导出 UsageSummary）/ ResultBar / WorkspacePicker
  components/tools/    ToolCardHost（注册表）/ AgentCard / BashCard / EditCard / AskQuestionCard（提问回放）
                       / GenericCard（兜底）
  components/permission/ PermissionPanel（按钮由 permission_suggestions 决定）
                       / AskUserQuestionPanel（模型提问：翻页 + 单选多选 + 自定义回答 + 提交自检）
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
5. **凭据只存 localStorage**（键名 `ccweb-token`；存的是登录会话令牌或环境变量令牌，
   绝不存访问密码），并通过 `?token=` 传给 WS（浏览器限制，无法设头）。
   鉴权页必须先用 `loginAccess` 换令牌再写入：直接把输入存下再刷新，输错只会看到
   「无法连接服务」；密码本身也不能当 Bearer 用（后端只认会话令牌）。
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
12. 输入框 `+` 是**添加菜单**（`common/Menu` 的 `attachTo`：贴在输入卡上方、与它同宽且
    左右对齐、朝上长，不盖住输入框；高度只给通用上限的一半，命令多时面板内部滚动）：
    本地文件/图片、
    从飞牛选择、claude 指令（中文短说明见 `lib/labels.commandDescription`，未收录的回落
    CLI 原文）；
    " / " 仍由用户键入触发补全。从飞牛挑中的图片/PDF 走 `readHostFile`（`POST /api/fs/host-file`，
    后端只放行这两类）转成附件，其余类型只把路径写进消息——不要在前端读任意宿主文件。
    **桌面截图要能直接 Ctrl+V**：textarea 的 `onPaste` 用 `lib/attachments.clipboardFiles`
    取文件（优先 `items.getAsFile()`，Safari/部分 Linux 的 `files` 是空的），有文件才
    `preventDefault`——纯文本粘贴必须原样交给浏览器。读成附件的路径与「+ → 本地文件」共用
    `addFiles`（同一套类型/单文件/10MB 总量校验）；截图常常没有文件名，用
    `withPastedName` 补成 `clipboard-<时间>.png`，别让附件芯片和模型看到的附件名变成空白。
    **附件里的图片缩略图是按钮，点开走 `ImageLightbox`**（同一份 `attachmentDataUrl` 拼
    data URL；内联图片没有工作区路径，所以不挂「在右侧栏打开」）。预览状态只存附件 id，
    从 `files` 里派生：删掉这条附件、或发送后 `files` 清空，预览自动关闭，不要另存一份快照
    自己记着关。非图片附件不摆预览按钮（点了只会看到一个文件图标）。
    **发出去的图片在用户气泡里直接显示，并可点开预览**（对齐 DSH）：`store.sendPrompt`
    用 `userBubblePayload` 把附件拆成两半——图片进 `UserItem.images`，其余仍是正文里的
    「附件：名字」；`UserBubble` 画缩略图（按钮 → `ImageLightbox`），只发图片时正文为空。
    回放转录走 `lib/normalize.ts` 的 `userImagesOf`：从 user 消息的 `image` block 取回
    同一批 base64 字节（没有文件名，补 `image-N.<ext>`），**只认 base64**——`source.type
    === "url"` 不内联（那会让界面去第三方拉图），退回一行「N 个图片/PDF」占位；认不出字节的
    image block 也必须保留这行占位，否则「只发了图」的消息回放时会整条消失。
    去重同样要认这种情况：只发图片时本地与回显的 `text` 都是空串，靠「两边都有 images」判定。
13. **右侧栏是「开始页 + 标签页」**：没有标签时显示开始页——工作区文件 / Git / 新建终端
    三张卡片，**不要自动打开「文件」标签**；栅格用**容器查询**（`@container` +
    `@min-[21rem]:grid-cols-2`）而不是视口断点：右侧栏宽度是拖出来的，与 viewport 无关，
    窄了排成一列，否则描述会被折成「浏览工作区文 / 件」这种断字。描述仍要短到一行放得下；
    点卡片才开标签。顶部一排标签（文件 / Git / 每个终端各一个），
    标签自带 × 关闭；文件与 Git 是单例，终端每次都新建（上限 8，标签名 `bash`、`bash 2`…）。
    顶部 `+` **直接回到开始页、不弹菜单**（`active === ""` 就是开始页；开始页里自己不显示
    这颗按钮）。开始页是盖在标签面板上面的一层，**标签面板照旧只隐藏不卸载**：
    终端里挂着 PTY，卸载等于杀 shell；关标签才结束进程。
    不要再加「启动页 + 返回」式的切换。Git 只拉不推（`/api/git/pull`，`pull --ff-only`），
    拉取**直接执行、不弹确认**（成功安静刷新，失败由面板顶部错误条说明原因）。
    **Git 状态不自己轮询**：面板可见时 `watchGitRepo(cwd)` 在系统通道上发 `git.watch`，
    后端变了就推 `git.changed`，由 `useSidebarStore.gitChanged` 刷新状态/分支/历史；
    切走标签或卸载时 `watchGitRepo(null)` 退订（后端会跟着停掉轮询）。
    **看得见才订阅**：页面在后台（`document.hidden`）退订、回前台补订并补刷；
    功能区整页视图盖住侧栏时（侧栏只是 `display:none`）由 `App` 传 `visible={view === null}`，
    `GitPanel` 的 `active` 与它相与——否则没人看也在 NAS 上每 3 秒跑一次 git。
    **文件/目录行的「更多」菜单有「引用到对话」与「下载」**：引用只调
    `useAppStore.requestMention(绝对路径, "file"|"dir")`（带单调 `seq`；同一条点第二次
    值没变，没有 seq 就重放不了），格式化与插入由 `Composer` 负责（`mentionPath` 按会话
    cwd 折成 `@相对路径`，cwd 外保留绝对）；下载用 `lib/runtime.fsDownloadUrl` 拼地址，
    再按类型选 `lib/download` 的入口：**文件走 `downloadFromUrl`（fetch → blob →
    `<a download>`）**，超 256MB 的文件与目录的 zip 走 `downloadInFrame`（隐藏 iframe）。
    **绝对不要让顶层锚点导航到下载地址**：在飞牛 App 的 WebView / 宿主 iframe 里那是一次
    页面跳转，应用页面被顶掉、WS 跟着断开重连（踩过）。`<a>` 也带不上 Authorization 头，
    token 只能放 query；blob 路径不会把大文件读进内存（超限自动退回 iframe），
    目录仍由后端打包成 zip，前端不自己遍历。
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
    **弹窗里的「已授权目录」是唯一入口**：打开时现查一次飞牛授权列表（`useDirsStore.load` →
    `GET /api/dirs`），把旧「快捷入口」并进来——芯片 = 飞牛授权目录 ∪ 已登记工作区（按路径去重），
    点一下就是进入该目录。**不要再单独摆一行「快捷入口」**：同一目录会出现两块芯片，
    用户分不清哪个才是「已授权」。
    **这一栏只做跳转，没有任何删除入口**：撤销授权是「设置 → 目录」的事；应用自己的安装目录
    （ClaudeCode）也在列表里，在这里顺手删掉等于自断手脚。移除工作区仍然走侧栏工作区行的菜单。
    当前路径只认顶部输入框，**底部那行只读路径、以及「上一级」行右侧的父路径都删掉了**
    （重复信息，完整路径留在 `title` 里悬浮可见）。
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
    **工具条窄了先折权限模式的文本**（对齐 DSH）：输入框工具条是 `@container` 容器，
    权限模式触发器在 `@max-[460px]` 下只留盾牌图标 + 箭头（`Select` 的 `labelClassName`，
    文本 `display:none`）。用**容器查询而不是视口断点**：工具条宽度由侧栏拖动/分屏决定，
    视口再宽也可能只有 360px。文本没了就得让 `aria-label` 带上当前模式
    （`权限模式 接受编辑`），否则读屏只剩「权限模式」三个字。
23. **左侧栏的「分组 / 排序 / 筛选」走 `lib/sidebarView.ts`**：分组（按工作区 / 按工作区树 /
    单列表）、排序（手动 / 最近更新）、筛选（隐藏已归档 / 全部 / 仅已归档）三种偏好存在
    localStorage（`ccweb-sidebar-view`），手动顺序存在 `ccweb-session-order`
    （按工作区路径分键，单列表用 `__flat__`）。手动排序的入口有两个：桌面拖拽 +
    会话「更多」菜单里的上移/下移（触屏没有拖拽）。视图偏好是**每台设备**的，不进后端。
    **拖拽的落点由行的上/下半决定**（`dropHalf`：上半插到它前面、下半插到它后面，
    `moveTo` 的落点就是提示线画的地方）：拖到哪一行，就在那一行的上沿或下沿画一条
    2px 强调色提示线 + 左端圆点（`styles.css` 的 `.side-drop-line`，对齐 DSH 的
    `dropBefore`/`dropAfter`）。三条边界：
    - **线只在真能落下去的行上画**（`canDrop`：同组、不是自己、置顶状态一致）。
      跨工作区、拖到自己、在置顶项与非置顶项之间都不给线——`pinnedFirst` 是最后一道排序，
      允许落位会变成「画了线却被拉回去」。
    - **落位只认真正的 `drop`**：拖到列表外松手或按 Esc 取消都不改顺序，
      提示线是预告而不是「已经插进去」。
    - **拖影自己造**（`lib/dragImage.ts`，对齐 DSH 的 `useRowDragPreview`）：浏览器默认那张
      截图在手机上会被缩小，看起来像把被拖的那行压扁了。我们在视口外挂一块与行同宽的
      不透明替身交给 `setDragImage`，`dragend` 时摘掉；拿不到 `setDragImage` 的 WebView
      静默回落到默认拖影。
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
    上限 `MAX_QUEUED`（8 条，附件是 base64 常驻内存），只在内存里、刷新即丢。
    **输入框草稿相反**：正文按对话存 localStorage（见规则 30），重进前端还在。
25. **首屏只留壳层，重的面板按需加载**：`App.tsx` 对 SettingsDrawer / RightSidebar /
    WorkspaceDialog / FeaturePage 一律 `lazy()` + `Suspense`，不要改回静态 import——
    这几块占了首屏包体的一半（实测主 chunk 604 KB → 382 KB，gzip 173 KB → 118 KB）。
    模态用 `useLazyMount`：**首次打开才挂载，之后保持挂载**，关闭再打开不会丢表单状态。
    **所有 hook 必须在 `if (!open) return null` 之前**：关闭时组件仍挂载、只是早返回 null，
    少渲染一条 hook 就是 React #300（「Rendered fewer hooks than expected」），
    用户看到的是整屏「界面出错了」。`WorkspaceDialog` 踩过一次，有回归用例钉住。
26. **设置页按页签懒加载**：`SettingsDrawer` 只剩导航壳（外壳是
    `settings/SettingsSurface.tsx` 的 `SettingsSurface` + `SettingsPane`），每页在自己首次
    被访问时挂载（`visited` 集合）并动态 import。各页 `useEffect` 一挂载就发请求，全部常驻
    会让「打开设置」变成一次并发拉取。
    新增页签照这个模式加，不要写成「全部渲染 + hidden」。
    `Section`（分区标题 + 说明）统一在 `settings/Section.tsx`，不要再在页面里各写一份。
    **设置项优先用 `SettingRow` 排成一行一项**（对齐 DSH 的 Setting-Cell）：左边标题 + 说明、
    右边控件，分隔线画在行上（`py-4`，约 73px 一行）；不要把一个设置竖着摞成
    「标题 / 说明 / 控件」三层——那正是「密度太低」的来源。枚举项用 `Select variant="pill"`
    （宽度跟着当前值走），两三项用分段控件；说明可以直接跟着当前值变，
    不要再在控件下面另挂一行解释。

26.1 **侧栏功能区是整页视图，不是弹窗**（对齐 DSH）：插件 / MCP / 技能中心 / 自动化任务 /
    历史记录这五项从左侧栏「新对话」下面那排入口打开，**接管左侧栏以外的剩余区域**
    （`App.tsx` 里与 `ChatPane` 二选一，移动端铺满视口），不再用 `Dialog`：
    - **对话区只是 hidden、不卸载**：输入框草稿、滚动位置与 WS 连接都要留着；
      右侧栏同样是 `hidden`（卸载等于 SIGHUP 掉里面的终端 shell）。
    - **入口原地高亮**（`activeFeature`，`aria-current="page"`），再点一次回到对话；
      点某条对话或「新对话」也会切回来（`App` 里按 `activeId` 复位）。
    - **页头**是 `PageShell`：`safe-top` + `h-14`（与对话/右侧栏表头对齐）、标题、
      页面自己的动作、右侧一颗「回到对话」；移动端再给一颗抽屉入口（那时左侧栏是抽屉）。
    - **懒加载**：`FeaturePage` 自己 `lazy()`，五个页面各自一个 chunk；页面按
      「挂载即进入、关闭即卸载」组织，不要再套 `open` prop。
    - **不要再改回「居中弹窗 + 复用设置几何」**：弹窗会盖住对话区，还要先关掉才能接着干活。
26.2 **功能区的固定 / 取消固定只缓存浏览器**（`lib/sidebarFeatures.ts`，键
    `ccweb-sidebar-feature-hidden`）：入口清单与顺序在 `FEATURE_KEYS`，存的是**隐藏名单**
    （新入口默认出现），未知 id 一律忽略。
    - **图钉就在功能行的右侧**（对齐 DSH）：点它取消固定，该入口从主列表移到「更多」；
      「更多」不是固定管理面板，它就是被取消固定的入口的落脚处，**点条目照样进入**，
      条目行尾的图钉把它固定回主列表（`MenuItem.trailing`，不触发进入、也不关菜单）。
    - 没有任何入口被取消固定时**不渲染「更多」**；展开态与收起态（图示栏）同一套规则。
    - 行是容器而不是按钮：`side-row` 的外层是 `div.group/feature`，里面才是进入按钮 +
      图钉按钮（按钮不能嵌套）。图钉在桌面悬停才露出，触屏常显。
    - **触发元素的 `currentTarget` 要先取出来再 setState**：放进更新函数里等它执行时
      已经是 `null`，菜单会「点了没反应」。
    - 设置（`openSettings`）不在这份清单里：它是应用本身的入口，始终留在侧栏底部。
27. **键盘焦点必须可见**：全局 `:focus-visible` 兜底在 `styles.css` 末尾（无 layer，
    优先于 utilities），所以页面上那 30 多个 `outline-none` 只影响鼠标。新增输入控件
    不需要自己写 focus 样式，也不要用 `!important` 去盖掉那条规则。
28. **会话起不来 ≠ 历史读不到**：`openConversation` 在 `POST /api/session` 失败
    （claude 未安装 / 版本被删 / 409 并发冲突）时仍然要 `loadTranscript()` 回放转录，
    然后再报错。少了这一步，界面会显示「开始新的对话」，看起来像整段对话被弄丢。
29. **正文图片走 `![]()` → `/api/fs/raw`，不做「裸路径自动变链接」**：`lib/markdownMedia.ts`
    是唯一解析入口。相对路径按**会话 cwd** 解析（实测：模型在 cwd 等于工作区时写
    `probe/x.png`，cwd 在工作区外时写绝对路径），绝对路径必须先确认落在 cwd 内、再换算成
    相对写法（后端 `fsapi.cleanRel` 明确拒绝绝对路径）。只内联位图：SVG 的 data URI 一律
    拒绝（同源页面里 SVG 能带脚本），http(s) 图片不自动加载（会向第三方暴露「这条消息被
    看了」），降级成链接；加载失败退回字面语法，宁可显示原文也不要破图。
    **不做裸路径识别**：正文里「我改了 `README.md`」和「点开 README.md」长得一模一样，
    自动 linkify 会把每一处文件提及都变成按钮。图片语法是明确意图，裸路径不是。
    `MarkdownMediaContext` 只在 `ChatPane` 提供；`FilesPanel` 的 md 预览不提供，退回旧行为
    （图片语法显示成字面文本）——那里的相对基准是文件所在目录而不是工作区根，
    要支持得先给 `resolveMedia` 加 base 前缀。
    **放大弹窗顶部的「在右侧栏打开」**（`ImageLightbox` 自绘的顶部栏）走
    `useSidebarStore.openRequest`，请求里带**单调递增的 `seq`**（只存路径的话，同一张图
    点第二次值没变，effect 不会重跑）。
    **消费者只能有一个**：`RightSidebar` 读 store → `openTab("files")` + 把请求存进自己的
    state → 作为 `pending` prop 透传给 `FilesPanel`（后者按 `seq` 去重并调 `openPath`）。
    曾经让两个组件各自订阅 store，结果是「先开标签、面板才挂载」，先挂载的那个把 seq 用掉、
    后挂载的永远看不到请求——首次进入前端时只开了「文件」标签、不进预览。
    `FilesPanel` 在 `cwd` 为空时**必须不消费**（留着等下一轮），否则 `readFile` 抛
    「未选择工作区」，这次点击照样白丢。data URI 的内联图片没有相对路径，因此不显示这个按钮。
    **请求是一次性的，由 store 记「已消费」**：`RightSidebar` 处理完必须
    `consumeOpenFile()`（子代理那条是 `clearSubagentView()`）。右侧栏「关掉就卸载」，
    只靠组件内的 `useRef(0)` 记已处理，重新挂载时 ref 归零，同一请求会被重放——
    用户只是收了侧栏，再打开却又被拉进一张早就看完的图 / 一个子代理标签。
    同理，「文件」标签关掉时要清掉透传给 `FilesPanel` 的 `pending`（面板重新挂载后
    它的去重 ref 也归零）。子代理请求的 `nonce` 因此走**模块级计数器**：请求清空后
    若从 state 里读上次的 nonce，同一个子代理点第二次会拿到重复序号而被丢掉。
    **灯箱自身是三段布局**（顶部栏 / `flex-1 min-h-0` 的图片区 / 缩放栏），移动端走
    `Dialog` 的 `centered`（视口居中 + 四角圆角），不要退回底部 sheet：贴底会把图片压在
    屏幕下沿，`76dvh` 的图加上下两条栏还会顶出 `max-h`。`key={src}` 让换图时缩放复位——
    `src` 为空时组件只是 return null，state 还留着。
    **缩放控件只有一份**（`common/Zoomable.tsx`：`ZoomBar` + `ZoomableImage` + `stepZoom`），
    正文灯箱与右侧栏文件预览共用；缩放状态由调用方持有，因为复位时机不同——
    灯箱按 `src`（`key={src}`），侧栏按选中的路径（`<FilePreview key={path}>`）。
    只有图片给缩放条：PDF 走 `<iframe>` 自带控件，文本/markdown 没有缩放的概念。
    **显示尺寸由 `fitSize()` 算，不是纯 CSS**：基准是 `min(原始像素, 适应窗口)`
    ——小图按原样显示（放大只会糊），大图按长边缩进窗口；`zoom` 再在这个基准上等比放大。
    `object-fit: scale-down` 看着像，但它在 zoom>1 时会把尺寸锁死在原始像素，缩放直接失效；
    `h-full w-full object-contain` 又会把小图拉到窗口大小。所以 `ZoomableImage` 用
    `ResizeObserver` 量窗口、用 `onLoad` 量原图，把结果写进 img 的 `width/height`。
    根节点固定 `h-full w-full` 供测量，滚动交给调用方（灯箱的正方形、侧栏的 `dsh-scroll`）。
    **预览窗口固定 1:1**：边长取容器的短边（`width: min(100cqw, 100cqh)` + `aspect-ratio: 1`），
    图片区那一层挂 `container-type: size`。所以 `panelClassName` 必须把高度定下来
    （移动 `h-full` 吃 Dialog 的 `max-h-[85dvh]`，桌面 `md:h-[82vh]`）——高度是 auto 时
    size containment 会让容器塌成 0，正方形直接消失。桌面尺寸与「设置」弹窗对齐
    （`md:h-[82vh] md:max-w-[900px]`）。缩放发生在正方形**内部**（内层 `overflow-auto`），
    放大后仍在这块窗口里滚，不会把弹窗撑大。
30. **输入框草稿按对话存浏览器本地（`lib/drafts.ts`）**：APP 被杀 / webview 被回收 / 页面
    重载都会把 React 状态清掉，打了半天的提示词不能就这么没了。`Composer` 的 `draftKey`
    由 `draftKeyFor(activeId, currentWorkspace)` 给出（有会话用会话 id，还没有会话就按
    工作区分桶），**每次改动立刻落盘、不做防抖**：localStorage 同步写，几 KB 的 JSON 可以
    忽略，而防抖会在 webview 被直接杀掉时丢掉最后几个字。三条边界：
    - **只存正文**。附件是 `File` / blob，序列化不了；把 base64 塞进 localStorage 既顶满配额、
      又会让整张草稿表写失败。附件与待发送队列仍然只在内存里。
    - **键换了不能把字弄丢**：会话一建好就把「新对话页」那份（`ws:<工作区>`）用 `moveDraft`
      迁到新 id 下（`createSession` 与 `restartSession` 的空对话分支里做），否则切键的一瞬间
      输入框会被新 id 的空草稿顶掉；删对话时 `dropDraft(id)` 一并清掉。
    - **已经发出去的那一条不能再搬回来**（踩过）：在新对话页直接发首条消息时，`onSend`
      里才新建会话，`moveDraft` 会把「正在发送」的正文搬到新 id 下，Composer 换键重读草稿
      就把刚发出去的一串原样放回输入框。`submit` 成功后会核对「发送那一格的草稿已被搬走
      （为空）+ 新一格草稿逐字等于本次正文」，命中就连新格一起清掉；判据不能只看键变了，
      否则会抹掉用户在这期间切过去、自己新打的草稿。
    - **有界**：单条 ≤ `MAX_DRAFT_CHARS`（超长不落盘，别连累别人；但**只跳过写入，
      不删已存的那一版**——粘贴一大段日志就把草稿抹成空白，等于刷新后什么都没了）、最多
      `MAX_DRAFT_ENTRIES` 条、30 天没动过的自动淘汰；读不出来（隐私模式 / 坏 JSON / 配额满）
      就当没有草稿，绝不能让输入框报错。

31. **飞牛「设置 → 目录」只在两端做**：**列表与撤销**走后端（`/api/dirs`、`/api/dirs/remove`，
   uid 只认网关注入的 `X-Trim-Userid`，见根 AGENTS.md 4.6.2）；**授权（添加）只能在前端**做——
   宿主内 `pickUserFile({directory:true})`，独立浏览器 `openAppAuth("pickUserFile", …)`。
   **宿主外的回包必须由回调页接住**：`redirectUri = <baseurl>/callback`，`main.tsx` 用
   `isAuthCallbackPath` 把它从 `App` 分流成 `AuthCallbackPage`（不经过令牌门、不建 WS），
   回调页只解析 + postMessage，**state 的比对在发起方**（`authSucceeded`）。
   直连端口访问（没有 `/app/` 前缀）打不开 `/app-auth`，只给一句人话，不要跳 404。

32. **页头的「在飞牛打开工作区」只在宿主内出现**（`TopBar` 里右边栏按钮左侧的文件夹图标）：
   点一下用 `openFnosFileManager(path)`（宿主桥接，等同右侧栏文件菜单的「在文件夹显示」）
   在飞牛文件管理器里打开**会话所属工作区的根目录**（`workspaceFor` 最长匹配，没有会话时
   用 `currentWorkspace`）。可见性由 `lib/fnos.canRevealInFnos` 一个纯函数给出：**有路径 +
   在宿主内 + 不是 `channel === "tcp"`**。端口访问必须单独挡——那条路上页面开在普通浏览器里，
   而 `fnosHostAvailable()` 只回答「页面结构像不像宿主」，单靠它会在直连端口上摆一个点了就报
   「当前不在飞牛宿主中」的按钮。失败提示复用 store 的 `openWorkspaceInFiles`（写 `error`
   由 `App` 统一显示），不要在组件里另起一套。

33. **右侧栏预览里，md / html 有「源码 ↔ 渲染」两视图**（标题栏左侧那颗按钮，`FilesPanel` 的
   `FilePreview`）：`previewKind` 给出 `markdown` / `html`，其余类型只有一种看法、不摆按钮。
   **默认都先给源码**（md 与 html 一致）：打开文件先看它到底写了什么，渲染是显式的第二下
   ——反过来会让工作区里的页面一打开就执行。html 的渲染视图用 `<iframe sandbox="" srcDoc={content}>`：
   `sandbox=""` 同时禁掉脚本与 `allow-same-origin`，页面拿到的是不透明源，读不到本页
   localStorage（token 在那儿），也发不出同源请求；**内容走已经取回的文本，不走
   `/api/fs/raw`**——那条路的后端白名单只有图片/PDF，也不该为了预览把 `text/html` 变成一个
   同源 URL。不要改用 `dangerouslySetInnerHTML`（规则 6）。源码视图复用行号渲染，
   「仅渲染前 3000 行」的提示只在真的显示源码时出现。
   **源码行的长行按面板宽度折行**（`whitespace-pre-wrap` + `[overflow-wrap:anywhere]`，
   容器不要 `min-w-max`）：右侧栏宽度是拖出来的，窄栏里横向滚动条基本没法用；
   只写 `break-words` 不够——无空格的长串（base64 / 长路径 / 长 URL）不会断。
   Git 面板的 diff 仍是横向滚动，那是另一块面板，别顺手改。

33.1 **Office 预览是三条懒加载路径**（`components/right/preview/`）：

   - `OfficePane` 是外壳：用 `store.readBytes`（→ `GET /api/fs/blob`）取字节，再渲染
     `React.lazy` 的 `DocxPreview` / `XlsxPreview` / `PptxPreview`。**三个渲染器各自一个
     chunk**，`OfficePane` 本身很轻、静态 import 到 `FilesPanel` 没问题（FilesPanel 在
     右侧栏 chunk 里）。不要为了「少一个文件」把 docx-preview 这类重库提到静态 import。
   - `FilePreview` 里**先判 Office 类型、再判 `file.binary`**：Office 文件的 binary 一定是
     true，顺序反了显示成「二进制文件，不支持文本预览」。
   - **docx 用 docx-preview**（样式还原值得体积，只解析不执行宏/不取外部关系）；它的
     wrapper 灰底、`section.docx` 宽度、页边距的收敛都在 `styles.css` 的
     `.docx-preview-host` 规则里——`section` 不给 100% 宽度时 flex 会按 max-content 撑开，
     窄栏里正文右侧被裁；页边距不夹到 28px 时 A4 的 3.17cm 会让每行只剩四五个字。
   - **xlsx / pptx 自己解**（`lib/ooxml.ts` + `lib/xlsx.ts` / `lib/pptx.ts`，zip 用 fflate）：
     不引 SheetJS（npm 停在 0.18.5，有原型污染漏洞，7.5MB）与 pptx-preview（闭源混淆包）。
     边界写死在解析层（200 行 × 50 列 / 100 页 / 单元格 300 字符），超了提示下载；
     解析不执行公式、不访问外部关系，公式没有缓存值时显示 `=B2-C2` 本身。
   - 解析失败要显示原因（不吞成空白）；用户还能用文件行菜单的「下载」打开。

34. **输入框 `@` 是工作区文件引用**（`lib/mention.ts` + `components/chat/useMention.ts` +
   `MentionMenu.tsx`，对齐 DSH 的 `dsh-client-ui-input-trigger` + `dsh-client-ui-reference`）：
   语法、格式化、替换、面包屑全在 `lib/mention.ts`（纯函数、有单测），组件里不要再写一套正则。
   `@` 只在**行首或空白之后**触发（`user@example.com` 不弹菜单），含空格的路径用 `@"…"`，
   目录引用以 `/` 结尾且**引号保持打开**（`@"my dir/`）——这是 Tab 能继续下钻的前提。
   四条交互边界：
   - **键盘先交给菜单仲裁**（`mention.handleKey(e)` 在 `onKeyDown` 最前面）：`Tab` 进目录、
     `Enter` 引用、`↑↓` 选候选、`Esc` 关闭；菜单开着时这几个键都要 `preventDefault`，
     否则 Tab 把焦点移走、Enter 会把半截 `@查询` 发出去。选中后插入的是正文 `@相对路径`，
     文件内容仍由模型自己用 Read 读，不要改成附件。
   - **光标是唯一输入**：`mentionAt(text, caret)` 从光标往前扫，所以 textarea 的
     `onChange`（带 `selectionStart`）、`onSelect`、`onClick`、`onKeyUp` 都要同步 caret；
     换对话（`draftKey` 变了）时 caret 要归零，否则会在新草稿里命中一个假 token。
   - **候选还在路上时不许插入旧行**：`loading` 期间 `pick`/`drill` 直接返回、Enter 被吞掉
     （唯一例外是与查询无关的「从飞牛选择」行——它只在飞牛宿主里出现）。请求经 store 的
     `completePaths(cwd, query, signal)`，防抖 120ms 并在下一次按键时 abort；组件不直接 fetch。
   - **飞牛行只在飞牛宿主里出现**：可见性由 `lib/fnos.canPickFnos({channel, inHost})` 决定
     （宿主内且 `channel !== "tcp"`，与页头「在飞牛打开工作区」同一条规则）——TCP 直连端口
     或独立浏览器里不摆这一行，点了必然报「当前不在飞牛宿主中」。它仍与 `+` 菜单同一个
     选择器：图片/PDF 走 `readHostFile` 成附件，其余类型写成 `@绝对路径` 并顶掉敲下的
     `@查询`（`pickFromFnos(mention)` 的那条分支）。
   `cwd` 由 `ChatPane` 传（会话 cwd，新对话时是当前工作区）；空串时菜单只剩飞牛行（若在宿主内）。

## 3. 状态管理（zustand）

- 每个会话的消息独立存 `items[sid]`，切换会话不重新拉取；
- WebSocket 实例放在**模块级 `Map`**，不进 store（避免被当成可序列化数据）；
- store 的 action 只做三件事：调 API、转发命令、把事件交给纯函数；
- **对话列表**存 `conversations`（后端合并转录+元数据+live），`openConversation(id)` 负责
  `--resume`、切换工作区、回放 transcript、连接 WS；组件不要自己调 `/api/session`。
- 新建对话用 `createSession`；空对话等首条 prompt 才由后端落元数据，前端不要提前 touch。
- **工作区行本身就是展开/收起开关**，不要再放单独的箭头按钮；点击**只展开/收起**，
  不切当前工作区、更不替用户打开那个目录的最近一条对话（点一下想看列表却进了旧对话）。
  换工作区只有两条路：点具体对话（`openConversation` 自己会切）或点行尾「+」新建。
  **工作区行没有常亮底色**（对齐 DSH）：当前工作区只靠文字色（`text-ink` / `text-ink-2`）
  区分，悬停才整行高亮——`data-active` 挂在行上会让人以为它是「已选中的导航项」。
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
- **悬浮概览（工作区与会话共用外壳 `HoverPreview`）**：鼠标在行上停 220ms 弹出，
  离开/滚动/点击即收；触屏没有 hover 不显示；`pointer-events-none`，不挡点击。
  **定位从侧栏右沿（`aside`）算起**：卡片整个落在对话区域里、纵向跟着悬停的那一行；
  用行的右沿加距离会压在分隔线上（行在侧栏里还留着列表 padding），看起来像盖住了左边栏。
  抽屉模式（`md` 以下）没有并排的对话区域，不弹；对话区域窄于 200px 也不弹。
  - 会话卡（`ConversationPreview`）：标题 + 完整 cwd + 时间/条数 + **会话状态**。
    **不显示最近一问一答**（对齐 DSH：概览只回答「哪条、在哪、什么状态」），因此也不再请求
    `/api/history/preview`。**状态只在卡片里报一次**：行上不挂原生 `title`（它会把 cwd + 状态
    再弹一次）；文案走 `lib/labels.conversationStatusLabel`，与行上的 `StateDot` 同一口径。
  - 工作区卡（`WorkspacePreview`）：显示名 + 完整 path + 对话数/最近使用。
    `workspaces.json` 只有 `last_used`、没有创建时间——**别拿 last_used 冒充「创建于」**。
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
  **置顶项与非置顶项之间拖不出落点**（`sidebarView.canDrop`）：`pinnedFirst` 是最后一道排序，
  允许落位就成了「提示线画在最上面、松手却被拉回置顶项之后」。拖拽只改组内相对顺序；
  要换位置就先取消置顶，不要为此去掉这层排序。
- **「复制 Session ID」已暂时下线**（`Sidebar.tsx` 的 `SHOW_COPY_SESSION_ID = false`）：
  菜单项藏起来了，但 `copySessionId`、剪贴板失败回落与实现都**没删**，恢复时改回 `true`
  并恢复它的组件测试。下线的理由：这个 id 只服务 `--resume` / 排查，粘进对话不会让模型
  回看别的会话，容易让人误以为它是跨会话寻址。
- **关于这个 id 的事实**：它就是 `--resume`、转录文件名、`conversations.json`、
  前端 `activeId` 的同一个值；在**右侧栏终端**里接管要显式换 HOME，否则 claude 找的是
  应用用户的 `~/.claude/projects`、必然报 "No conversation found"：
  `HOME=$CCWEB_DATA_DIR/claude $CCWEB_DATA_DIR/claude/versions/<版本>/claude --resume <id>`
  （ccweb 给子进程的 HOME 是 `CCWEB_CLAUDE_HOME`，默认就是 `<数据目录>/claude`；
  `HOME=$CCWEB_DATA_DIR/claude <版本>/claude` 少了一层 `versions/`，路径根本不成立）。
  另外这个 id 只属于 `--resume` /
  转录这一套：claude 自己的多会话（`ListAgents` / `SendMessage`、Remote Control）用的是
  「自动生成的会话名 + 6 位 ref」（如 `claudecode-5c [11a448]`），与 UUID 无法互转
  （实测不是它的哈希；claude 用 `-n/--name` 设显示名、`--remote-control-session-name-prefix`
  设名字前缀）。菜单项把完整
  id 写进剪贴板、`hint` 给前 8 位（让人确认复制的是哪条）；剪贴板被拒（局域网 http / 非安全
  上下文）时回落 `askPrompt` 让用户手抄，不要做成「点了没反应」。
- **分叉会话**：菜单项 → `store.forkConversation(id, title)`（`POST /api/conversations/fork`），
  后端建好新会话并返回 id，前端 `refreshConversations()` 后直接 `openConversation(newId)`。
  标题**必须**由调用方带上「原名（分叉）」后缀：fork 出来的转录首条消息与原会话一模一样，
  不加工列表里就是两条同名对话。复制的是上下文不是权限——新进程要重新审批。
  返回值**必须**是 `openConversation` 的结果（拿不到 `res.id` 直接算失败并写 error）：
  后端没给 id、或新对话打不开（cwd 未授权 / 会话起不来）都算分叉没成，
  报成功只会在界面上留下一条打不开的对话。
- **侧栏状态标记**（`lib/conversations.conversationStatus`，优先级从高到低）：待审批 →
  强调色圆点；进程 `busy`/`starting` → 进度环；完成但没看过 → 绿点；活跃但空闲 → 不画点；
  没有常驻进程 → 灰点。「完成未看」由 `applyEvent` 在 `result` 到达且该对话不是当前打开的
  那条时置位（`doneIds`），`setActive` 打开即清除——不清就会永远挂着绿点。
- **用量统计只认 CLI 给的数字**（`lib/usage.ts` + `store.usage`）：`stream_event` 的
  message_start/message_delta 提供上下文与输出，`result.modelUsage.<model>.contextWindow`
  才是模型窗口（init 里没有）。**上下文只能取单次请求的数**：`result.usage` /
  `result.modelUsage` 是**整轮累计**（SDK 类型：usage 是主循环的 per-turn 汇总、modelUsage
  跨轮累计，与 `duration_api_ms` 同口径），长任务一轮几十上百次请求会把 cache_read 累加到
  几百万——当上下文用就会显示「已用 9.1M / 窗口 976.6K」、进度环顶满（踩过一次）。
  `result` 只补窗口 / 整轮输出 / 整轮输入（`turnInputTokens`）/ API 耗时，`plausibleContext`
  再把超过窗口的存量值判废。
  **占用与消耗是两个数，别互相覆盖**：占用 = 最近一次请求的输入侧（窗口还剩多少）；
  消耗 = 这一轮/这个会话所有请求之和（`turnInputTokens` / `session*Tokens`，含缓存）。
  界面上它们是同一个弹层的两段（见下），不是两个入口。
  回答下面那行小字报的是**本轮消耗**（输入含缓存 + 输出），不是「输出 tok」——
  工具回合里输入侧占绝大多数，只报输出会让人以为没花钱。
  **tok/s 用最近一次请求的口径**（`genMs` / `genTokens` = `message_start` → `message_delta`
  的到达间隔与那一次的输出）：整轮输出 ÷ `duration_api_ms` 会把每次请求的首字延迟摊进分母，
  实测 200 tok/s 被读成 70，看上去像模型很慢；上游把整段回复合并下发（算出来超过
  `MAX_GENERATION_TPS`）时不显示速度，别编。
  CLI **不提供**
  「步骤数」「实时 tok/s」「官方上下文百分比」——步数用工具调用次数、tok/s 用上面那对原始
  数据换算、上下文用 (input+cache_read+cache_creation) ÷ contextWindow，都是同一套数据的
  换算，不要在界面上编造。
  **只有一个入口：底栏右侧的圆环 + 百分比**（`UsageStats.tsx` 的 `UsageStats`，≥70% 转琥珀、
  ≥85% 转红），点开的**同一个弹层**里依次是：已用 / 窗口，然后是**一块合并的整体**——
  会话累计的合计 / 输入 / 输出（输入、输出各占一行，不写「会话累计消耗」这种分组标题）
  紧接最近一次请求的未命中缓存 / 缓存读取 / 缓存写入 / 缓存命中（「未命中缓存」就是
  `input_tokens`，即这次没吃到缓存也没写进缓存的那部分，别叫「新输入」，容易读成
  「本轮新加的内容」），最后是生成速度与「累计 = N 轮 · M 次工具 · K 条事件」。**弹层不报本轮消耗**（它在回答下面那行小字里），也不写解释性小字——只摆数字。
  曾经把 token 详情拆成输入框下方一颗居中胶囊（`TokenUsage`，图标 + 总量），试过之后又并回来了：
  两个入口的内容互相重复，用户要点两次才能看全一遍。不要再加第二颗按钮。
  `UsageSummary` 只是那行文字（轮数 / 工具 / tok/s），不要往它上面挂交互。
- **用量要跟着对话持久化**：每回合结束（`result`）把快照 `PATCH /api/conversations {id, usage}`
  存进 `conversations.json`（内容没变就不发）。重开对话时：转录里的 `assistant.message.usage`
  给出最新的 token 数（更准），持久化那份补上转录里没有的 `apiMs` / `contextWindow`
  （`mergeUsage`）；实时 WS 快照优先，不覆盖。窗口再兜底用设置里的模型窗口。
  只存快照、不存派生指标——tok/s 与百分比都是算出来的。
- 新增事件类型：先改 `transport/types.ts` → 再在 `applyEvent` 里分支 → 最后补测试。
- **退出登录只在需要鉴权时出现**：`info.auth_required` 为真时，侧栏底部在「设置」上方
  显示「退出登录」（收起状态是一个图标按钮）。点击调 `store.logout()`：吊销后端会话、
  清本地令牌、整页重载回到鉴权页；后端不可达也要清本地凭据。unix socket 且未配令牌时
  不显示。
- **系统通道**：`bootstrap` 里 `openSystemChannel()` 打开一条 **不带 id** 的 `/ws`
  （`wsUrl("", token)`），只收应用级事件（`claude.update` / `conversations.changed` /
  `git.changed`）。它与会话连接分开：会话连接随对话开关（关对话、换工作区、删对话都会断），
  更新提示与 Git 订阅跟对话无关，没有打开任何对话时也要收到。系统通道的 `onEvent` 只放行
  这三类再交给 `applyEvent("", ev)`——别的 kind 带着空 sid 会写进各会话的桶里。
  重连成功后补拉一次 `/api/claude/status`（断线期间可能发布了新版）；**Git 订阅要重发**
  （服务端的观察者跟着连接走，`watchGitRepo` 记的 `gitWatchCwd` 在 `onStatus("open")`
  时补一次，并顺手刷新那次断线期间错过的变化）。

## 4. 消息模型（Item）

| kind | 来源 | 渲染 |
|---|---|---|
| `user` | 本地插入 / CLI 回显去重；转录回放从 `image` block 取回图片 | 右对齐浅色气泡 + 图片缩略图（点开 `ImageLightbox`） |
| `assistant` | `assistant.content[].text`（一条消息可有多个 text 块，各自成段）或 `stream_event` 增量 | 左对齐气泡 + Markdown（标题/列表/表格/引用/链接/代码块），`streaming` 时显示光标 |
| `thinking` | `assistant.content[].thinking` | 折叠块 |
| `tool` | `assistant.content[].tool_use` + `user.content[].tool_result` | 按工具名分派卡片（Agent/Task 用 `AgentCard`，带子代理状态与「查看对话」） |
| `result` | `result` 消息 | **成功回合不渲染**（耗时/token 已经在回答下面那一行）；出错时显示原因、subtype 与被拒次数，不显示费用 |
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

**卡片浮在输入框上方、覆盖对话区**（`ChatPane` 输入区外层 `relative` + 卡片层
`absolute inset-x-0 bottom-full`）：待审批/提问**不参与布局**。占布局高度时，卡片一出现就把
消息区顶上去、正在读的位置跳一下，长卡片（模型提问最多 4 题）还会把输入框挤出屏幕。
四条细节：
- **卡片背景必须不透明**（`PermissionPanel` 用 `bg-amber-50` / `dark:bg-amber-950`，
  卡片内的 JSON 块用 `bg-white` / `dark:bg-black/40`）：它盖在对话之上，`/80`、`/20` 这类
  透明度会让下面的消息透上来，和审批的命令糊成一片（截图复现过：标题与工具输出叠在一起）。
  这条**只约束这块浮层**——对话区里那些贴在自己背景上的浅色块不在此列。
- 卡片层外层 `pointer-events-none`、卡片容器 `pointer-events-auto`：空白处的点击照常落到
  下面的消息上，滚轮在卡片上照样能滚（卡片层自己 `max-h-[64dvh]` + `overflow-y-auto`，
  只为「同时挂着多张卡」兜底）。
- **待审批期间不渲染 `TurnTimer`**（「少女祈祷中 31s」那一行）：卡片会盖住它，露一半更难看；
  而且「有待审批」本身就说明这一轮没结束，那行没有新信息。
- 提问卡片**自己**定高、内部滚动（见下），所以它的边框不会跟着内容滚走；
  卡片层的滚动只为「同时挂着多张卡」兜底。
- 别把它改回「消息区末尾的流内块」：那样底栏要么被容器裁掉、要么把输入框顶走。

**模型提问走另一张卡片**（`AskUserQuestionPanel`，`ChatPane` 按 `tool_name === "AskUserQuestion"`
分流）。它**不是审批**：官方工具表里这个工具的 Permission required 是 No，所以不给「始终允许 /
切到某模式」，标题写「模型提问」。三条不能改的：

- **答案在 `updatedInput` 里**：`{questions: <原样回传>, answers: { [问题原文]: label | label[] }}`
  （`lib/askQuestion.askUpdatedInput`）。只回 `{behavior:"allow"}` 等于没答——模型拿不到任何选择。
  `response` 是整卡级自由回复，带上它 CLI 会替换掉整份 answers，逐题作答时不要用它。
- **逐题拒绝**：`AskDraft.refused` 是每题独立的开关，提交时换成一句占位文本
  （`ASK_SKIP_ZH` / `ASK_SKIP_EN`，按界面语言给）。claude 的 answers 没有空值语义，只能这么
  表达「这题不答」；`allow:false` 的整批拒绝**已删除**——它让人以为只跳过了当前这题（踩过）。
  整批放弃走输入框的「停止」。跳过之后再选选项/写文本会清掉 `refused`（和 DSH 一样）。
- **提交前自检**：每题必须选一项、写非空文本、或明确跳过，否则 `firstUnanswered` 跳回第一道
  未处理的题并内联提示，不发回包；「下一页」只是浏览，不校验。
- **推荐项只加徽章、不预选**：`(Recommended)` / `（推荐）` 去后缀只用于展示，回给模型的仍是
  原始 label；本地预选 CLI 拿不到（它的 idle 超时只提交对话框里已选中的），预选只会误导。

**卡片自己就是「定高 + 内部滚动」的盒子**：`flex max-h-[60dvh] flex-col overflow-hidden`，
头部（含 `1/4` 进度）与底栏 `shrink-0`，中间「题干 + 选项 + 输入框」一个
`dsh-scroll min-h-0 flex-1 overflow-y-auto`。两条约束：
- **单张卡片必须比外层浮层的上限小**（卡片 60dvh / 浮层 64dvh）。卡片如果是被浮层滚走的，
  它的**边框会跟着内容一起滚**，上下边就被裁掉、看起来像「边框被盖住」——踩过两次：
  先做成浮层里的流内块（底栏被裁），再做成 `sticky` 底栏（边框跟着滚）。
- 底栏**不要**再加 `sticky`：卡片内部滚的是中间那块，底栏是 flex 子项，本来就是固定的；
  加了只会和 `overflow-hidden` 打架。
- 「不回答 / 下一题 / 提交」必须永远看得见，所以底栏不能进滚动区；
  题干太长时让它跟着选项一起滚（对齐 DSH 的「问题正文、超长详情和选项共享内部滚动区」）。

其他要点：单选点一下即自动翻页、「这题不答」也会翻页（回来还能取消）、最后一题停在原地等
「提交」；`Enter` 继续 / `Shift+Enter` 换行，IME 组合期不拦（`nativeEvent.isComposing`）。草稿按 `request_id` 存 localStorage
（`lib/askDrafts`），切对话 / 重载回来还在；提交成功、`permission.resolved`、中断、进程结束
都要清掉。用户配了 `askUserQuestionTimeout` 时卡片顶部提示一句（值来自 `/api/info` 的
`ask_question_timeout`）——**ccweb 不改用户设置**。历史回放交给 `AskQuestionCard`：从 result
的 JSON 里认 `answers`，认不出就折叠显示原文。

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
  **估算高度必须按行类型给**（`OFFSCREEN_TEXT` 120px / `OFFSCREEN_ROW` 32px）：统一用
  120px 估一行 28px 的紧凑行时，展开一组 80 行会让滚动高度虚高 2000+px，随着行真正渲染
  一路回缩——手机上表现就是「内容加载不过来 + 位置乱跳」。**过程组内部不做离屏跳过**
  （`MessageRow` 的 `offscreen={false}`）：那一整块是用户主动展开的，行又便宜，
  跳过只会让展开瞬间的高度反复回算。
- **对话区右侧有轮次刻度**（`MessageList` + `lib/turns.ts`）：每条用户消息一个刻度，
  点一下跳到那一轮（被 80 条窗口截掉时会先展开再滚），当前轮用强调色加宽；悬停变宽、
  `title` 显示该轮首行。刻度出现时（≥2 轮）隐藏原生滚动条并给内容留 `pr-9`，
  避免和右对齐的用户气泡叠在一起；刻度整体 `pointer-events-none`，只有刻度本身可点，
  底部让出 64px 给「回到底部」按钮。
- **过程展示三档 + 收起，是两条独立的轴**（`lib/viewMode.ts` + `lib/process.ts`，默认「标准」）：
  - **档位只决定「展开之后每一步怎么画」**：简洁 = 连续过程折成一行组头（人话摘要，
    点开看每一步，`ProcessGroup`）；标准 = **不分组**，每一步各自一行（工具卡片折成一行，
    点开看正文）；详细 = 每一步都是完整卡片，直接铺开。
  - **收起是轮级的**（`TurnSpan` + `TurnCollapse`，对齐 DSH）：一轮结束就把**整轮**的思考与
    工具调用收进轮首一行「已完成，用时 19 分 52 秒 ⌄」，只留正文输出；点开那一行才按当前档位
    把过程还原回原位。**进行中的轮永远不收**，也**不挂那一行**（跑起来的时候必须看得见步骤）。
    用户手动开合过的轮记在 `MessageList` 的 `manual` 里（键是轮首那条的 **item id**，不是数组
    下标——「加载更早」会整体平移下标），自动逻辑不再改它。
  - **收起时机两档**（`lib/viewMode.ts` 的 `collapseTiming`）：`onComplete`（默认）= 一轮结束就收；
    `onNextSend` = 最新一轮结束后仍保持展开，等用户发出下一条消息才收（那时它不再是最后一轮，
    自动落进前者）。偏好存 `ccweb-collapse-timing`。**它和档位互不影响**——别再把它写进档位说明。
  - **「这一轮结束没有」认 `result`，回放里认会话状态**（`lib/process.turnSpans`）：转录回放
    没有 result 行，只靠扫列表会把历史轮次全判成还在跑（整段历史都不收、也没有耗时）。
    `turnSpans(items, running)` 的 `running` 必须传 store 的真实状态。
  - 组头（简洁档）是**人话摘要**：进行中取「正在跑的那件事」（`正在读取文件`），已结束按类别
    次数拼 `已读取文件并执行了命令`（两类用「并」、三类用逗号、超过三类加「等」），类别与拼接
    都在 `lib/process.ts`，未知工具归到「调用工具」——绝不能因为工具名没见过就不显示组头。
  - **收起后显示的回复也是两档**（`foldedReplies`：`all` 全部回复 / `final` 仅最终回答）：
    `final` 时被折叠的轮次只留**最后一条有正文的** Assistant 回复（`lib/process` 的
    `hiddenReplyIds`，按用户消息切轮），阶段回复整行跳过、不缩成占位。**最新一轮在过程仍展开时
    （运行中 / 「下次发送时收起」的保留期）一条都不隐藏**——过程都没收，回复先消失会像丢消息。
    偏好存 `ccweb-folded-replies`，默认 `all`。
  - **复制入口只给最终回答**（`lib/process.replyCopy` + `AssistantBubble` 的 `showCopy`/`copyText`）：
    一轮里模型会写好几段过渡正文（夹在思考与工具调用之间），每段各挂一个复制按钮只是噪音，
    复制出来也只是半句话。只有**本轮最后一条有正文的回答**拿得到 `copyText`，也就只有它渲染
    复制按钮。复制的内容是**整轮的正文输出**（按顺序拼起这一轮所有 assistant 正文），不是最后
    那一段——收起态下过渡正文多半看不见，不带上就等于复制不全。**思考过程（thinking）不进
    复制内容**（那是推理不是输出），CLI 包的 API 错误消息也不算正文。过渡正文本身在收起时
    照常显示：收起藏的是「过程」（思考 + 工具调用），正文输出一直留着。
  - **回显去重必须往回找整轮，不能只看最后一条**（`normalize.echoAlreadyShown`）：
    `applyUser`（CLI 回显）与 `appendPromptEcho`（后端广播）原来都只在「最后一条是 user」
    时才去重。插话发生在**回合进行中**，本地气泡后面早就跟上了 thinking / tool，尾巴不是
    user，于是去重失效——回显/广播被当成新的一条用户消息插进来，那条**没有 `interjected`
    标记**，这一轮就被切成两半（前半截当成「已完成」收起、还冒出复制按钮）。
    现在的边界是**上一条 `result`**：一轮之内的本地气泡才算候选；跨过 result 就是上一轮的
    事，用户真的又说了一遍同样的话，不能吞。`hasImages` 允许两条空正文的图片消息互认。
  - **插话（`priority=now`）不切轮**（`UserItem.interjected`）：它是往正在跑的这一轮里补一句，
    不是新的一轮。所有「按用户消息切轮」的地方都必须跳过它——`lib/process.turnSpans`、
    `lib/turns.turnsOf`/`windowStart`、`lib/process.hiddenReplyIds`、`normalize.stampTurnUsage`。
    切了的话一句话就把这一轮劈成两半：前半截被当成「已完成」收进一行（还冒出复制按钮），
    后半截当新一轮重新铺开。本机发送由 `sendPrompt` 按 `priority` 标记，别的设备收到的
    `prompt.echo` 带 `interjected`（后端 `promptEchoOf` 从 `cmd.Priority` 取）。
  - **「这一轮结束没有」在轮级判定里还要看「是不是最后一轮」**（`turnSpans` 的 `isTail`）：
    会话正在跑的时候，前面的轮次**必然已经结束**（后面已经开了新一轮）。只看「会话在不在跑」
    一刀切的话，历史轮次会被全判成进行中，于是对话进行中整段历史的思考与工具都摊在外面。
  - **收起行报口语时长并画一条分隔线**（`TurnCollapse`）：中文用 `formatDurationWords` 的
    「已完成，用时 3 分 15 秒」（`03:15` 要先心算，而这一行是一整轮的总括），英文沿用
    `formatDuration` 的 mm:ss。它下方必须有一条 `border-b`——这一行是「过程的总括」，正文是
    这一轮的结果，没有边界两者会糊成一团（DSH 同款）。
  - **底栏那行是「轮数 · 会话累计 token · tok/s」**（`UsageSummary`）：中间那个总量是
    `sessionInputTokens + sessionOutputTokens`，与弹层「合计」同一个数；它回答「这条路花了
    多少」，和 tok/s 只报最近一次请求不是一回事。`formatTokens` 按 1024 进位、K/M/B 三档
    （十亿级写成 `1144.4M` 既难读又容易和 M 混淆）。
  - **对话结束前不给复制按钮**（`replyCopy` 的 `finished` 参数）：跑到一半时「最后一条正文」
    只是半句话，挂个复制按钮既没意义，又会在过程里冒出来（表现为「思考过程下面多了一个
    复制按钮」）。轮次结束后才给，位置永远在最终回答那一行。
  - **纯空白的 thinking 块直接丢掉**（`lib/normalize.ts` 的 `applyAssistant`）：上游在工具调用
    之间常发一个 `" "`（实测一次会话里 57 条），渲染出来是一行「思考过程 · 1 字」，点开只有个
    空格。判定用 `block.thinking.trim()`，不是真值判断（`" "` 是真值）。
  - **偏好只存 localStorage（`ccweb-process-view`）**，不进 `settings.json`；旧值
    `compact`/`grouped` 当年就是「折成一行组头」，按「简洁」读，不改写磁盘上的值。
  - **行内摘要必须 `min-w-0 truncate`，不能 `shrink-0`**：思考行的预览是一整行英文时，
    会把「思考过程」这个标题挤成 0 宽、并把整行撑出容器；组正文的 `overflow-y-auto`
    还会顺带把 x 轴变成滚动容器，于是出现一条横向滚动条。组正文的横向裁剪见下一条的
    `overflow-x-clip`。
  - 组正文限高只在 `md` 以上生效（`md:max-h-[min(400px,50vh)]`）：手机上「页面里再套一个
    滚动区」很难摸到边界，展开的组直接跟页面一起滚；详细模式运行中不限高，卡片完整铺开。
    横向用 `overflow-x-clip` 而不是 `overflow-x-hidden`——后者会把元素变成滚动容器
    （另一轴被算成 auto），手机上又多一层能拦截触摸的滚动区。
  - 限高生效且那个方向还能滚时，正文边缘有 12px 渐隐（`styles.css` 的 `.process-fade-*`，
    用 `mask-image` 作用在内容上，不叠彩色层，深色主题不用另配颜色）；是否显示由
    `ProcessGroup` 里的 scroll/ResizeObserver 边缘跟踪给出，一屏放得下时不出渐隐。
- **工具卡片正文与紧凑行共用一份实现**：每个工具导出 `XxxBody`，`ToolShell` 只提供外壳
  （详细模式是带边框的卡片、紧凑模式是一行）；紧凑行展开后出现第二个标题、或两种模式
  信息量不一致，都是实现走偏了。**摘要必须兜底**（`lib/tools.toolSummary`）：未知工具回落
  第一个字符串参数，绝不能渲染成一行空白。
- **分组只影响渲染**：`Item`、`seq`、id、`data-item-id` 与转录回放都不动，「最近 80 条」的窗口
  仍按原始条目算，`start` 记的是原始下标。
- **对话区右下角必须有「回到底部」按钮**（`MessageList`）：不贴底时出现，圆形、带下箭头；
  不贴底期间来了新消息时按钮上点一个强调色小圆点，`aria-label` 换成「有新内容，回到底部」。
  点击后恢复贴底跟随；`prefers-reduced-motion` 下直接跳，不做平滑滚动。
- **贴底跟随必须认「内容变高」，不能只认「条数变化」**（`lib/scrollFollow.ts` 的
  `useFollowGrowth`）：展开思考过程 / 工具卡片、图片加载完成、过程组展开某一步，都只是
  高度变化而不改 `items` 条数，只跟条数的话新露出来的正文留在视口外——表现是「点开没反应，
  得自己往下滚」。规则只有一条：**贴着底就跟、往上滚过就不跟，滚回底部自然恢复，界面上
  不显示任何状态**（不要加「自动滚动已暂停」之类的提示）。
  - **贴底与否只认滚动方向，不认「距底多远」**（`MessageList.onScroll`）：跟随把 `scrollTop`
    推到底之后，流式内容常在下一个 scroll 事件被处理前又长高一截，事件到达时距底已 > 100px，
    按距离判会当作「用户往上翻了」把跟随悄悄关掉——表现是「滚着滚着突然不跟了，得手动点
    一次回到底部」。现在只有 `scrollTop` 变小（往上滚）才停、滚动到底才恢复。
  - **`useFollowGrowth` 不自己按几何算贴底**：它只认调用方给的 `shouldFollow`
    （`MessageList` 传 `stick`、`ProcessGroup` 传自己的 `bodyStick`）。在
    `ResizeObserver` 回调里现算 `scrollHeight - scrollTop - clientHeight` 必然得出
    「不贴底」（内容变高的瞬间 `scrollHeight` 已经变大、`scrollTop` 还没动），于是永远不跟。
  - **滚动容器自身的高度变化也要重新贴底**（`MessageList` 的 ResizeObserver）：输入区上方的
    审批卡片、任务清单、「少女祈祷中」计时行出现/消失都会挤占它的高度。高度一变，`scrollTop`
    停在原处就不再是最底部（内容没动、视口变矮了），表现是「回到底部」按钮自己冒出来、还带个
    「有新内容」圆点，像是用户自己翻上去了。这里**不做**「已经在底部就跳过」的优化：回调的
    触发原因就是几何变了，此刻按旧的 `scrollHeight/scrollTop` 判断会跳过写入。
    判贴底仍然只认 `stick`（由 `onScroll` 的方向维护），不要在尺寸回调里现算几何。
  - **用户自己发消息时强行回到底部并恢复跟随**（`MessageList` 的 `lastUserSent`）：他往上翻着
    读历史、直接发一句话，界面却停在他读的那段——自己刚发的气泡和后面的回复全在视口外，
    看起来就是「发了没反应」。判定是「最后一条 item 是 user，且它的 id 与上一次见到的不一样」，
    写在那个 `useLayoutEffect` 里、**早于 `!stick.current && hidden > 0` 的视口还原**（顺序反过来
    会先滚到底再按旧距离还原回去，闪一帧再跳回）。**这是唯一会强行接管滚动的情况**：别人发来的
    消息（另一台设备、定时任务投递）仍然遵守「往上翻就停下，只点亮『有新内容』」。
- **刻度高亮在贴底时直接取最后一轮**（`lib/turns.activeTurnIndex` 的 `atBottom`）：
  贴底那一刻视口顶部通常还停在最后一条回答的开头（一轮的末尾可能就是整屏），按
  「视口顶部落在哪一轮」算会一直亮着倒数第二轮，看起来「滚到底了刻度却没走到最后一个」。
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
- 设置页是居中模态（移动端全屏），左导航分「通用 / 模型 / 目录 / 代理 / 部署 / 访问 / 关于」
  ——技能 / 插件 / MCP 三页已移到左侧栏功能区（整页视图，见规则 26.1）；
  「目录」页只列飞牛已授权目录并提供添加/撤销（`DirsSettings` + `useDirsStore`）：
  **不打开目录、不标目录徽章、不写说明**，列表 `w-full` + 路径 `truncate`（完整值进 `title`），
  撤销前 `askConfirm`。后端给 `error` 时说原因（不在统一网关下 / 缺 token / scope 未声明），
  不能当成「还没有授权目录」；**`protected` 里的路径（应用自己的安装目录 / 数据目录）不给撤销按钮**
  ——后端也会拒绝，见根 AGENTS.md 4.6.2；
  「访问」页管**端口访问开关（默认关闭）**、TCP 端口（默认 3141，保存后立即换监听）与访问密码：
  开启后经 TCP 访问必须用密码登录（单密码、无用户名），unix socket 入口免密；
  密码有基础复杂度（`lib/password.ts`：≥8 位、含字母与数字），只以摘要落在服务端；
  端口范围 1025–65535（`lib/access.ts`），越界时保存按钮置灰；
  端口冲突等保存失败要把后端原因就地显示（不只靠全局错误条）。
  改密码后若当前通道是 `tcp`，要用新密码重新登录换会话令牌，
  否则下一个请求就 401；unix 通道绝不覆盖环境变量令牌。
  「关于」页只放：一句话特性、版本号（`/api/info` 的 version）、致谢
  （DeepSeek / DeepSeek Harness / dsh-better-sidebar），以及**标题右侧的 GitHub 图标**
  （只有图标不带文字，`aria-label` 说明是仓库链接，`https://github.com/shuangji66/claudecode-webui`，
  `target=_blank` + `rel=noreferrer`）。不要再加「源码」区块或运行形态说明。
  不要把设置项塞进这一页。通用设置即时保存，
  模型配置在底部「保存模型设置」统一提交，代理保存后重启所有 claude 会话。
  「部署」页管 claude 版本（下载源 / 安装进度 / 切换生效版本），切换只影响之后新建的会话。
  「技能」页有「导入」（`SkillImportDialog.tsx` + `store.importEntries / importFromPaths`）：
  一次多条，来源是本地文件/文件夹（内容在浏览器里，逐条 `PUT /api/skills/doc`）或飞牛选择器
  挑的 NAS 路径（交给后端 `POST /api/skills/import`，只认 SKILL.md）。飞牛选择器带
  `accept: [".md", ".markdown"]`（`pickFnosFiles` 的参数）——那只是选择器的门帘，
  前端 `isSkillFile` 与后端 `readSkillSource` 各自仍要挡一次。目标作用域与工作区
  在弹窗里选，与页面上的工作区下拉是同一个状态；同名标「覆盖」。**点「导入」后弹窗
  自己关掉**，逐条结果（成功数 + 每条失败原因）交给页面上的提示条（`SkillsSettings` 的
  `importNotice`，可手动关闭）——不要在弹窗里再摆一个「关闭」按钮：右上角 × 与 Esc
  已经能取消，两个按钮干同一件事只会让人以为有什么没做完。名字推断与合法性判定在
  `lib/skillsImport.ts`（纯函数、有单测），不要在组件里再写一份。**失败不许静默**：
  读不出来的文件要说出文件名与原因（成功的照常入清单），名字还空着的条目直接拦住导入
  ——按钮上写着「导入 N 个」，少导一个却不说，用户只会以为功能坏了。
  「技能」页读写 SKILL.md（`store/useSkillsStore.ts` 收敛请求）：个人技能对所有会话生效，
  项目技能跟着**页面上选中的工作区**走（`lib/workspaceTarget.ts`，与 MCP 页同一套；
  新建表单里也能直接选作用域与目标工作区，不跟活动对话）；claude.ai 同步来的只读。
  改完 claude 会在当前会话内热加载，不要提示用户重启。这一页是满高 flex，
  **底部按钮行必须留 `pb` + 安全区**，否则「创建/取消」会贴着弹窗下沿。
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
    **它必须 `createPortal` 到 body，不要改成就地渲染**：`position: fixed` 相对最近的
    包含块定位，而消息行的 `content-visibility: auto`（隐含 `contain: paint`）就会造出
    一个——浮层被关进那一条消息（小方块遮罩 + 关闭按钮被裁掉 + 桌面上关不掉，图片灯箱
    踩过）。`Dialog.test.tsx` 的「挂载位置」用例钉住这条。
    默认移动端是底部 sheet（表单类）；纯展示类（图片灯箱）传 `centered` 改成视口居中 +
    四角圆角，此时 `max-h` 用 85dvh——留出的上下空间同时兜住刘海与 Home Indicator。
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
  `autofill`、`providerCatalog`、`subagents`、`usage`、`fnos`（宿主判定三条件/回包归一化）、
  `fnosAuth`（回调页路径 / state 比对 / 回包解析）、`dragImage`（拖影替身）、
  `password`（访问密码复杂度：长度/字母/数字/控制字符）、
  `access`（端口范围 1025–65535）、
  `drafts`（按键存取 / 空正文即删除 / 超长不落盘 / 过期与溢出淘汰 / 搬迁与删除 / 坏 JSON 不抛错）。
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
| 关闭弹窗时整屏「界面出错了」（React #300） | 有 hook 排在 `if (!open) return null` 之后 |
