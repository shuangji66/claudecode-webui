// 与后端 / claude CLI 之间的线上协议类型。
//
// 后端把一个 claude 会话的事件统一包成 WireEvent 推给前端：
//   { kind, sid?, data }
// 前端上行命令是 ClientCommand。

export type WireEventKind =
  | "session.snapshot"
  | "session.ready"
  /**
   * CLI 换了会话 id（`/clear` 之后它会新开一份转录）。
   *
   * `data` 是 `{from, to}`。后端已经把 conversations.json 的记录迁到 `to`；
   * 前端要把本机按会话 id 存的状态一起搬过去，并把 activeId 切到新 id。
   * 不搬的话，界面停在旧 id 上继续显示清空前的历史，而后端在往新 id 写转录——
   * 两边各走各的，刷新就少一段。
   */
  | "session.replaced"
  | "session.state"
  /**
   * 断线重连后的补发：`sync {since, epoch}` 的应答，把断开期间漏掉的会话事件按原顺序
   * 一次性补回来（`data.events`）。补不齐时改回 `session.resync`。
   */
  | "session.replay"
  /**
   * 补不齐了（重放缓冲已淘汰，或后端重启过、序号对不上）：前端必须整份重放转录，
   * 不能凭本地消息流继续追加——那样会留下中间有空缺、且永远缺一段的历史。
   */
  | "session.resync"
  | "cli"
  | "permission"
  // 这条审批已经有结论（可能是别的设备/标签做掉的），收到就撤掉卡片。
  | "permission.resolved"
  /**
   * 同一会话的别的连接发出了一条提示词（后端在写 stdin 成功后广播）。
   *
   * CLI 不带 `--replay-user-messages` 时不回显 stdin 里的消息，而用户气泡是发送方
   * 本地乐观插入的：不补这条，另一台设备上只会看到模型突然开始思考。
   */
  | "prompt.echo"
  | "error"
  | "closed"
  | "claude.update"
  /** 系统通道：被盯住的那个仓库快照变了（git.watch 之后由后端推）。 */
  | "git.changed"
  | "pong";

export interface WireEvent {
  kind: WireEventKind | string;
  sid?: string;
  data?: unknown;
  /**
   * 会话事件的单调序号（后端 `session.Event.Seq`）。
   *
   * 断线期间的事件会丢：重连时用 `sync {since, epoch}` 把这段空缺补回来，
   * 前端按它去重（同一条事件可能既在补发帧里、又在实时广播里）。
   * 网关自己产生的事件（pong / 本地回错）没有这个字段。
   */
  seq?: number;
}

/** initialize 回包（后端原样透传 CLI 的响应）。 */
export interface InitPayload {
  claude_code_version?: string;
  models?: ModelInfo[];
  commands?: CommandInfo[];
  agents?: AgentInfo[];
  output_style?: string;
  current_permission_mode?: string;
  account?: { tokenSource?: string; apiProvider?: string };
  session_state?: string;
  capabilities?: string[];
  /**
   * 本会话实际连上的 MCP 服务，含**连不上的**（status 非 connected）。
   *
   * 这是「会话真的连上了什么」的唯一来源：设置 → MCP 里的探测只说明「这条配置
   * 能不能起来」，说明不了这个会话到底用了哪些。有失败的条目时界面要提示，
   * 否则用户只能从「工具调不通」倒推。
   */
  mcp_servers?: McpRuntimeServer[];
  [k: string]: unknown;
}

/** init 里的一个 MCP 服务运行态。 */
export interface McpRuntimeServer {
  name: string;
  /** connected / failed / needs-auth / pending / disabled …（开集，未知值照原样显示）。 */
  status: string;
  /** 定义来自哪（sdk / plugin / 某个配置作用域）。 */
  source?: string;
}


export interface ModelInfo {
  value: string;
  displayName?: string;
  description?: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
}

export interface CommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
  builtin?: boolean;
}

/** MCP server 的作用域 / 传输类型（与后端 internal/mcp 保持一致）。 */
export type McpScope = "user" | "project";
export type McpType = "stdio" | "sse" | "http";

export interface McpServer {
  name: string;
  scope: McpScope;
  type: McpType;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /**
   * 工具常驻工具表（claude 配置里的 alwaysLoad）。
   *
   * 不设时 claude 会把 MCP 工具延迟到 ToolSearch 后面：模型只看到
   * `mcp__<名>__<工具>` 这串名字、看不到描述，于是「有这个工具」这件事
   * 只能靠提示词记着。搜索类、需要模型主动想到的服务都该打开它。
   */
  always_load?: boolean;
  /** true = 已从 claude 的配置里摘出来，存在本应用的暂存文件里。 */
  disabled: boolean;
  /** 这条配置实际写在哪个文件（排错用）。 */
  config_path: string;
  /**
   * true = 由 ccweb 自己注册并维护（目前是自动化任务的 ccweb-schedule）。
   *
   * 后端每次启动都会把它写回配置，所以界面不给「删除」按钮（接口也会拒绝）；
   * 想暂时关掉用「停用」，那个状态是留在本应用暂存文件里的，重启后保持。
   */
  builtin?: boolean;
}

export interface McpPayload {
  user: McpServer[];
  project: McpServer[];
  project_root: string;
  user_path: string;
  project_path: string;
}

/** 插件（`claude plugin`）的一条已安装记录。 */
export interface PluginEntry {
  id: string;
  version: string;
  scope: "user" | "project" | "local" | string;
  enabled: boolean;
  install_path: string;
  project_path?: string;
  installed_at?: string;
  last_updated?: string;
  /** 插件自己声明的 MCP server：装之前/之后都值得先看一眼。 */
  has_mcp_servers: boolean;
}

/** 已注册的 marketplace。 */
export interface PluginMarketplace {
  name: string;
  /** directory | git | …（CLI 原始值）。 */
  source: string;
  path?: string;
  install_location: string;
}

/** marketplace 里可安装的插件。 */
export interface PluginAvailable {
  plugin_id: string;
  name: string;
  description: string;
  marketplace: string;
}

/** 插件变更任务（同一时刻只有一个）。 */
export interface PluginJob {
  kind: string;
  target: string;
  phase: "running" | "done" | "error";
  message?: string;
  error?: string;
  started_at: string;
  finished_at?: string;
}

export interface PluginsPayload {
  supported: boolean;
  reason?: string;
  home: string;
  installed: PluginEntry[];
  marketplaces: PluginMarketplace[];
  /** 可安装目录的总条数（明细走 /api/plugins/available 分页，官方市场一份就 3743 条）。 */
  available_total: number;
  available_at?: string;
  available_note?: string;
  job: PluginJob | null;
}

/** 可安装插件的一页。过滤与分页都在服务端做。 */
export interface PluginAvailablePage {
  items: PluginAvailable[];
  /** 当前过滤条件下的命中数。 */
  matched: number;
  /** 目录里一共有多少条。 */
  total: number;
  offset: number;
  limit: number;
  fetched_at?: string;
  note?: string;
}

/** 组件清单（只对已安装的插件有内容）。 */
export interface PluginDetails {
  text: string;
  skills: number;
  agents: number;
  hooks: number;
  mcp_servers: number;
}

/** 装之前能看到的清单信息（读 plugin.json 与目录，不跑 CLI）。 */
export interface PluginInspect {
  found: boolean;
  dir: string;
  hooks: boolean;
  mcp_servers: boolean;
  commands: number;
  skills: number;
}

export interface PluginDetailsPayload {
  id: string;
  details: PluginDetails;
  inspect: PluginInspect;
  /** 未安装时 CLI 会报 not found：这是正常情况，界面据它显示提示。 */
  error?: string;
}

/** 内置搜索（DeepSeek Search / Fetch API）的状态。密钥只回脱敏值。 */
export interface SearchStatus {
  base_url: string;
  search_count: number;
  search_enabled: boolean;
  search_api_key_set: boolean;
  search_api_key_masked: string;
  /** 用户级 MCP 配置里**真的有**这条内置服务（由后端 EnsureSearchMCP 维护）。 */
  attached: boolean;
  /**
   * 这条服务被「停用」摘进了本应用的暂存（不在 claude 的配置里，会话连不上）。
   *
   * 与 `attached` 互斥：`mcp` 列表里两者都会出现，只按「列表里有这一条」判会把它算成
   * 已注册，面板上就会写着「已注册，要关就点停用」——而它早就关了。
   */
  disabled: boolean;
  server_name: string;
  command: string;
  /** false 表示这套部署没装 MCP 管理（后端 Deps.Mcp 为 nil）。 */
  mcp_supported: boolean;
}

export interface SearchTestResult {
  ok: boolean;
  latency_ms: number;
  error?: string;
  count?: number;
  results?: { title: string; url: string }[];
}

export interface McpProbe {
  ok: boolean;
  latency_ms: number;
  error?: string;
  server_name?: string;
  server_version?: string;
  protocol?: string;
}

export interface AgentInfo {
  name: string;
  description?: string;
}

/**
 * 后端记的「还没结束的后台任务」（随 session.snapshot 下发）。
 *
 * 只补 `task_id` 这一类**只在实时事件里出现**的信息：中途连上来的设备走转录回放，
 * 拿不到 task_started，因此也就不知道「进行中」的那条后台操作该往哪儿发 stop_task。
 * 列表本身仍由前端从消息流现算（见 lib/backgroundTasks）。
 */
export interface LiveTask {
  task_id: string;
  tool_use_id?: string;
  description?: string;
  /** `local_agent` / `local_bash` / `mcp_task` …（只有 task_started 才带）。 */
  task_type?: string;
  subagent_type?: string;
  background?: boolean;
  /** 不算活动（观察者之类）：界面不该列出来。 */
  ambient?: boolean;
}

/** 后端推来的权限请求（can_use_tool）。 */
export interface PermissionPayload {
  request_id: string;
  tool_name: string;
  display_name?: string;
  description?: string;
  input?: unknown;
  blocked_path?: string;
  tool_use_id?: string;
  /** 非空表示这次调用来自子代理内部（审批面板据此标归属）。 */
  agent_id?: string;
  permission_suggestions?: PermissionSuggestion[];
}

export type PermissionSuggestion =
  | { type: "addRules"; rules?: { toolName: string; ruleContent?: string }[]; behavior?: string; destination?: string }
  | { type: "addDirectories"; directories?: string[]; destination?: string }
  | { type: "setMode"; mode?: string; destination?: string }
  | { type: string; [k: string]: unknown };

export interface SessionInfo {
  id: string;
  cwd: string;
  state: string;
  /** 创建会话时选中的提供商 / 模型 / 推理强度（后端记录）。 */
  provider?: string;
  model?: string;
  effort?: string;
  created_at?: string;
  last_active?: string;
}

export interface SnapshotPayload {
  info: { id: string; cwd: string; state: string };
  init?: InitPayload;
  /** 会话当前的事件序号；前端以它为基础，下一次重连用它补空缺。 */
  seq?: number;
  /** 会话对象的身份（见 session.Session.Epoch）；与本地记的不一致就必须整份重放。 */
  epoch?: string;
}

/** 随 prompt 发送的文件（base64）。 */
export interface WireAttachment {
  name: string;
  media_type: string;
  data: string;
}

/** 前端上行命令。 */
export type ClientCommand =
  // priority="now" = 插话：立刻写进 stdin，并要求 CLI 在当前回合读到它
  // （能后台化的工具被挪到后台）。不带则按 CLI 默认的 next 处理。
  | { kind: "prompt"; text: string; attachments?: WireAttachment[]; priority?: "now" }
  | { kind: "interrupt" }
  | { kind: "model"; model: string }
  | { kind: "permission_mode"; mode: string }
  | {
      kind: "permission";
      request_id: string;
      allow: boolean;
      updated_input?: unknown;
      updated_permissions?: unknown;
      message?: string;
    }
  // 系统通道专用：让后端盯住一个仓库（Git 面板可见时），有变化就推 git.changed。
  // 分栏后两栏可能各看一个仓库，所以订阅是一个集合：unwatch 带 cwd 只退一个，
  // 不带表示「退掉全部」（旧客户端 / 全局清理）。
  | { kind: "git.watch"; cwd: string }
  | { kind: "git.unwatch"; cwd?: string }
  /**
   * 补齐断线期间漏掉的会话事件。
   *
   * `since` 是已经处理过的最大事件序号，`epoch` 是那次会话的身份（见
   * `SessionSnapshot.epoch`）：后端对象换过（进程被重启/回收再 resume）时序号会从头
   * 开始，只比 `since` 会把新进程的前几条当成老进程的续集拼上去。所以两者一起带上，
   * 对不上就回 `session.resync`，由前端整份重放转录。
   */
  | { kind: "sync"; since: number; epoch?: string }
  | { kind: "ping" };

/** 单个模型的展示与能力元数据。 */
export interface ModelSpec {
  name?: string;
  /** 该模型声明的推理档位；界面上还会多出「默认」（不声明）一档。 */
  reasoning_efforts?: string[];
  supports_image?: boolean;
  /** 上下文窗口（token 数）；未声明时由后端回落到全局压缩窗口。 */
  context_window?: number;
  /** 最大输出 token 数；未声明时不注入。 */
  max_output_tokens?: number;
}

/**
 * 密钥的发送方式。
 *
 * claude CLI 的两个环境变量各绑一个请求头：ANTHROPIC_API_KEY → `x-api-key`，
 * ANTHROPIC_AUTH_TOKEN → `Authorization: Bearer`。同一个密钥只能走其中一个，
 * 因为对话请求由 CLI 发出、ccweb 无法在 401 之后换头重试。
 */
export type AuthMethod = "x-api-key" | "bearer";

/** 一个第三方模型提供商的脱敏视图（对话协议恒为 Anthropic Messages）。 */
export interface PublicProvider {
  id: string;
  name: string;
  base_url: string;
  api_key_set: boolean;
  api_key_masked: string;
  /** 密钥的发送方式：x-api-key（默认）或 bearer。老后端不返回时按 x-api-key 处理。 */
  auth?: AuthMethod;
  models_path: string;
  models: string[];
  /** 按模型 ID 的元数据；老后端可能不返回。 */
  model_meta?: Record<string, ModelSpec>;
  /** 该提供商给子代理用的模型；空表示不指定（CLI 自己按继承链解析）。 */
  subagent_model?: string;
}

/** 当前选中的模型（= claude CLI 的默认模型）。 */
export interface Selection {
  provider: string;
  model: string;
  /** 推理强度；空表示用模型默认值。 */
  effort?: string;
}

/** 后端 /api/settings 的脱敏视图（密钥永不回传）。 */
export interface PublicSettings {
  providers: PublicProvider[];
  selected: Selection;
  permission_mode: string;
  auto_compact_window: string;
  disable_unknown_model_window: boolean;
  /** 主题不在服务端：只缓存在浏览器（localStorage）。 */
  locale?: "zh" | "en" | string;
  font_size?: number;
  proxy_url?: string;
  /** 空闲会话回收阈值（分钟，默认 10，范围 5–60）。 */
  idle_minutes?: number;
  /** 常驻会话数上限（默认 8，范围 6–12，界面步进 2）；宿主自己执行，不是 CLI 环境变量。 */
  max_sessions?: number;
  /** 并发子代理上限（默认 10，范围 1–50）；只在会话启动时生效。 */
  subagent_max_concurrent?: number;
  /** 子代理递归深度（默认 1 = 关闭嵌套，范围 1–5）；只在会话启动时生效。 */
  subagent_spawn_depth?: number;
  /** 端口访问开关（默认关闭）。 */
  tcp_enabled?: boolean;
  /** TCP 直连端口（默认 3141，可在「设置 → 访问」里改）。 */
  tcp_port?: number;
  /** 密码只回「是否已设置」，摘要与明文都不下发。 */
  tcp_password_set?: boolean;
  /**
   * TCP 登录会话的有效期（小时，默认 24，范围 12–72、步进 12）。
   *
   * 会话表在服务端落盘，所以这是登录态唯一的过期边界——重启进程不会失效。
   */
  login_ttl_hours?: number;
  path: string;
}

/** 端点连通性探测结果。 */
export interface ProbeResult {
  ok: boolean;
  endpoint: string;
  method: string;
  status: number;
  latency_ms: number;
  detail: string;
  /** 按配置的认证方式被拒、换成它才成功；保存时应当写回提供商。 */
  auth_switched_to?: AuthMethod;
}

/** 网关模型列表条目。 */
export interface GatewayModel {
  id: string;
  display_name?: string;
  owned_by?: string;
  /** 部分网关返回上下文窗口，添加模型时用于预填。 */
  context_length?: number;
  /** 部分网关返回最大输出 token 数，添加模型时用于预填。 */
  max_output_tokens?: number;
}

/** /api/settings/models 的响应。 */
export interface ModelsResult {
  models: GatewayModel[] | null;
  endpoint: string;
  status: number;
  detail: string;
  /** 解析失败时的响应体片段，便于判断网关到底返回了什么。 */
  raw?: string;
  /** 尝试过的路径。 */
  tried?: string[];
  /** 每个候选路径的探测结果。 */
  attempts?: { path: string; status: number; note: string }[];
  /** 本次实际使用的认证方式，以及「换头后才成功」时的那一个。 */
  auth?: { header: AuthMethod; switched_to?: AuthMethod };
}

/** 一条已授权目录（工作区）。 */
export interface WorkspaceEntry {
  path: string;
  name: string;
  last_used: string;
  /** 读取时实时探测：目录可能被移动 / 卸载。 */
  exists: boolean;
}

/** GET /api/workspaces 的响应。 */
export interface WorkspacesPayload {
  workspaces: WorkspaceEntry[];
  current: string;
  /** CCWEB_PROJECTS_ROOT，目录选择器的默认起点。 */
  root: string;
}

/** 目录选择器（GET /api/fs/list）里的一行。 */
export interface FsPickEntry {
  name: string;
  path: string;
}

/**
 * GET /api/fs/list 的响应。
 *
 * 注意与文件树（/api/fs/tree）的 FsListing 区分：这个接口只回名字和绝对路径，
 * 没有 type/size/truncated。两边曾经同名，TS 的声明合并把两种线上形状混成一个。
 */
export interface FsPickListing {
  path: string;
  parent: string;
  entries: FsPickEntry[];
  roots: string[];
}

/** POST /api/fs/host-file 的响应：宿主文件的字节（base64）。 */
export interface HostFile {
  name: string;
  media_type: string;
  size: number;
  data: string;
}

/**
 * POST /api/fs/access 的响应：应用用户能否直接读写该目录。
 * writable=false 时才需要走飞牛授权（authorizeUserFile）补 ACL。
 */
export interface FsAccess {
  path: string;
  writable: boolean;
  reason?: string;
}

/** 文件树的一行。path 相对工作区根，使用 POSIX 斜杠。 */
export interface FsEntry {
  name: string;
  path: string;
  type: "dir" | "file" | "other";
  size?: number;
}

export interface FsListing {
  root: string;
  path: string;
  entries: FsEntry[];
  truncated: boolean;
}

/** /api/fs/file 的文本预览结果。binary=true 时 content 为空。 */
export interface FsFile {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string;
}

/** 一侧的增删行数；binary=true 时 git 报的是 `-`/`-`。 */
export interface GitLineCounts {
  additions: number;
  deletions: number;
  binary?: boolean;
}

/** git status 的一条记录；XY 的两位分别是索引侧与工作区侧。 */
export interface GitStatusEntry {
  path: string;
  xy: string;
  staged?: GitLineCounts;
  unstaged?: GitLineCounts;
}

/** 工作区里的一个 Git 仓库；path 相对工作区根，根仓库为 ""。 */
export interface GitRepo {
  path: string;
  name: string;
  /** 绝对路径，直接当后续 /api/git/* 的 cwd 用。 */
  root: string;
  /** 仓库落在另一个仓库里面（子模块 / 嵌套检出）。 */
  nested?: boolean;
}

export interface GitStatus {
  is_repo: boolean;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  detached?: boolean;
  entries: GitStatusEntry[];
  truncated?: boolean;
  root?: string;
}

export interface GitLogEntry {
  hash: string;
  hash_full: string;
  parents: string[];
  subject: string;
  author: string;
  date: string;
  refs: string;
}

/** 一次提交的详情：元数据 + 补丁（`GET /api/git/show`）。 */
export interface GitCommit extends GitLogEntry {
  /** 完整正文（`%B`，首行就是 subject）。 */
  message: string;
  author_email?: string;
  /** 补丁文本；界面按文件切段渲染。 */
  diff: string;
}

export interface GitBranches {
  current: string;
  names: string[];
}

/** 侧栏对话列表的一行（后端合并转录 + 元数据 + 实时会话）。 */
import type { UsageSnapshot } from "../lib/usage";

export interface ConversationInfo {
  id: string;
  cwd: string;
  /** 自定义标题优先；为空时前端用首条消息 / 目录名回落。 */
  title: string;
  created_at: string;
  last_active: string;
  messages: number;
  archived: boolean;
  /** 侧栏置顶：只影响列表排序（置顶的排在同组最前），不是「默认恢复哪一条」。 */
  pinned?: boolean;
  live: boolean;
  state?: string;
  provider?: string;
  model?: string;
  effort?: string;
  /** 上次保存的用量快照（上下文 / 缓存 / tok/s 的原料），重开对话时还原底部统计。 */
  usage?: UsageSnapshot;
}

/** /api/history/transcript 的回放数据；lines 是 claude 原始事件行。 */
export interface TranscriptPayload {
  id: string;
  cwd?: string;
  lines: unknown[];
  truncated?: boolean;
  /**
   * 本对话子代理的收尾状态（后端读 `subagents/*.meta.json`）。
   *
   * 主转录里没有 `system/task_*` 行，后台子代理的结论只靠 `<task-notification>`
   * 那条 user 行，而被中断（TaskStop）的子代理**不写通知**——不靠这份补，重开对话后
   * 它们会永远停在「运行中」。
   */
  subagents?: SubagentState[];
  /**
   * 哪些 user 行是插话（宿主机记在 `<session>/interjections.jsonl` 里）。
   *
   * 转录本身区分不出来：实测 2.1.330，`priority=now` 的消息与排队投递的消息在 jsonl
   * 里字段完全相同（18/18），连 `queue-operation` 与 `turnPosition` 都一样。所以这个
   * 事实只能在写 stdin 的那一刻靠 CLI 回显拿到（见后端 session.KindInterjection）。
   * 老会话没有这份名单：那时插话算新一轮。
   */
  interjected_uuids?: string[];
}

/** 一个子代理的收尾状态（见 TranscriptPayload.subagents）。 */
export interface SubagentState {
  agent_id: string;
  /** 发起它的那次 Agent 调用，用来把状态折回对应的工具卡片。 */
  tool_use_id?: string;
  description?: string;
  /** claude 已收尾。**收尾 ≠ 成功**：成败看通知里的 status。 */
  finished: boolean;
  /**
   * 最后一次请求的 token 总量（prompt + output，CLI 的 `subagent_tokens` 口径）。
   *
   * 后端从子代理自己的转录里读：后台子代理的用量只在 stdout 的 `task_notification`
   * 里，而写进主转录的那条 `<task-notification>` 不带 `<usage>`，重启后就靠这份恢复。
   *
   * **它不是「消耗了多少」**——那是 `total_tokens`，两者差一到两个数量级。
   */
  tokens?: number;
  /**
   * 累计消耗（每次请求的 prompt + output 求和，按 `message.id` 去重）。
   *
   * CLI 自己不给这个数（`task_notification.usage.total_tokens` 同样是最后一份快照），
   * 后端整份扫子代理转录才算得出来。实测一份 97 次请求的审查子代理：单次 232K、
   * 累计 16.4M。界面上报「消耗」必须用它。
   */
  total_tokens?: number;
  /** 子代理转录最后一行的时刻（unix 毫秒）：重启后算「跑了多久」用它。 */
  ended_at?: number;
}

/** 子代理转录旁的 meta.json（读不到时后端不带这个字段）。 */
export interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
  finished?: boolean;
}

/** /api/history/preview 的返回：会话最近一句问与答（侧栏悬浮预览用）。 */
export interface HistoryPreview {
  user?: string;
  assistant?: string;
}

/** /api/history/subagent 的回放数据：子代理对话不在主转录里，走这条旁路。 */
export interface SubagentTranscriptPayload extends TranscriptPayload {
  agent: string;
  meta?: SubagentMeta;
}

/** 一个已安装的 claude 版本（/api/claude/status）。 */
export interface ClaudeVersion {
  version: string;
  path: string;
  size: number;
  installed_at: string;
  /** 仍从这个二进制跑的会话数（网关现算）；删除前据此提示会打断几个对话。 */
  in_use?: number;
}

/** 安装任务的阶段；字符串由后端定义，不要改成数字。 */
export type ClaudeJobPhase = "downloading" | "extracting" | "verifying" | "done" | "error" | "cancelled";

export interface ClaudeJob {
  version: string;
  source: string;
  phase: ClaudeJobPhase;
  downloaded: number;
  total: number;
  error?: string;
  started_at: string;
  finished_at?: string;
}

/** claude 平台包的下载源标识（与后端 claudebin.Sources 一致）。 */
export type ClaudeSource = "npmmirror" | "tencent" | "huawei" | "official";

/** 「设置 → 部署」的状态快照。 */
export interface ClaudeStatus {
  /** 本机对应的 npm 平台包后缀，例如 linux-x64、linux-arm64-musl。 */
  platform: string;
  /** 版本目录，方便在 NAS 上排查。 */
  dir: string;
  installed: ClaudeVersion[];
  /** 当前生效版本；空表示没有可用版本。 */
  active: string;
  source: ClaudeSource;
  latest: string;
  update_available: boolean;
  job: ClaudeJob | null;
}

/** /api/claude/check 的返回。 */
export interface ClaudeCheck {
  source: string;
  latest: string;
  versions: string[];
}

/** 技能来源：个人（claude home 下）/ 项目（仓库内）/ claude.ai 同步（只读）。 */
export type SkillScope = "personal" | "project" | "synced";

/** 一条技能（不含正文）。 */
export interface SkillEntry {
  name: string;
  scope: SkillScope;
  /** 取自 frontmatter，claude 靠它决定何时自动加载。 */
  description: string;
  path: string;
  updated: string;
  size: number;
  read_only: boolean;
  /** 非空表示 SKILL.md 存在但读不出来。 */
  invalid?: string;
}

/** 技能正文。 */
export interface SkillDoc extends SkillEntry {
  content: string;
}

/** 一条导入结果（批量导入逐条返回，单条失败不影响其它条）。 */
export interface SkillImportResult {
  /** 来源路径（飞牛导入时有值；本地文件导入时为空）。 */
  path?: string;
  name?: string;
  ok: boolean;
  /** 失败原因原文，界面直接显示。 */
  error?: string;
}

/** /api/skills 的返回。 */
export interface SkillsPayload {
  personal: SkillEntry[];
  project: SkillEntry[];
  synced: SkillEntry[];
  /** 项目技能所属的工作目录；空表示没有可用的工作区。 */
  project_root: string;
  /** 个人技能目录的绝对路径（接口原样给出，排错时用；界面不展示）。 */
  personal_root: string;
}

/** 自动化任务的时间规则（字段组合由 kind 决定，与后端 schedule.Rule 一致）。 */
export interface ScheduleRule {
  kind: "once" | "minutes" | "hours" | "daily" | "weekdays" | "weekly" | "monthly" | "cron";
  /** minutes/hours 的间隔。 */
  interval?: number;
  /** HH:MM，用于 daily/weekdays/weekly/monthly。 */
  time?: string;
  /** weekly 的星期集合（0=周日 … 6=周六）。 */
  weekdays?: number[];
  /** monthly 的日期（1..31，该月没有这一天就落在月末）。 */
  day?: number;
  /** once 的绝对时间（RFC3339）。 */
  at?: string;
  /** 5 字段 cron：分 时 日 月 周。 */
  cron?: string;
  /** IANA 时区；空表示服务器本地时区。 */
  timezone?: string;
}

/** 投递目标：指定对话 / 首次新建后复用 / 每次新建。 */
export interface ScheduleTarget {
  kind: "conversation" | "new-reuse" | "new-each";
  conversation_id?: string;
}

/** 一次投递记录（只确认消息投进了对话，不代表模型执行成功）。 */
export interface ScheduleDelivery {
  at: string;
  conversation_id?: string;
  prompt: string;
  /** 非空表示这次没投出去（工作区失效、会话起不来等）。 */
  error?: string;
}

/** 一条自动化任务。 */
export interface ScheduleTask {
  id: string;
  name: string;
  prompt: string;
  target: ScheduleTarget;
  workspace: string;
  rule: ScheduleRule;
  status: "active" | "paused" | "ended";
  /** 下一次计划投递时间（RFC3339，UTC）；已结束的任务没有。 */
  next_run?: string;
  updated_at: string;
  created_at: string;
  last_delivered_at?: string;
  last_error?: string;
  deliveries?: ScheduleDelivery[];
}

/** /api/schedules 的返回。 */
export interface SchedulesPayload {
  tasks: ScheduleTask[];
  limits?: { min_gap_seconds?: number; max_deliveries?: number };
}

/** 内置浏览器的一个内核（Chromium / Firefox）。 */
export interface BrowserKernel {
  id: string;
  label: string;
  /** 浏览器自身的版本号（界面展示用）。 */
  version: string;
  /** playwright 缓存目录的后缀（chromium-1243 里的 1243）。 */
  build: string;
  installed: boolean;
  /** 装好之后真的能启动（Firefox 依赖系统 libnss3 的符号版本，可能装得上但起不来）。 */
  available: boolean;
  /** available 为 false 时的原因（截断后的 playwright 报错）。 */
  problem?: string;
}

/** 内置浏览器运行时的状态快照（`GET /api/browser`）。 */
export interface BrowserStatus {
  /** 运行时根目录（用户可以据此手工清理）。 */
  root: string;
  /** 固定的 playwright 包版本。 */
  playwright: string;
  /** runner 脚本与全部内核就绪。 */
  installed: boolean;
  /** 解析到的 node；空表示没找到。 */
  node_path: string;
  node_version: string;
  kernels: BrowserKernel[];
  /** "" | downloading | extracting | installing | done | error | cancelled */
  phase: string;
  progress: number;
  total: number;
  /** 当前动作（「正在下载 Chromium …」），进度条上方那行字。 */
  note: string;
  error: string;
  source: string;
  running: boolean;
  /** 正在跑启动自检：结论还没出来，「可用」这时只是「还没测出问题」。 */
  testing: boolean;
}
