// 全局状态：对话列表、消息流、权限队列、连接状态、工作区与第三方模型配置。
//
// 设计取舍：
//   - 每个对话的消息列表独立存在 items[id] 里，切换对话不重新拉取；
//   - WebSocket 实例放在模块级 Map 里（不进 state，避免被当成可序列化数据）；
//   - 所有协议归一化逻辑放 lib/normalize.ts，这里只做状态搬运；
//   - 「当前选中模型」是全局唯一值，它就是 claude CLI 的默认模型；
//   - 对话 id 是稳定 UUID：新建用 --session-id，打开旧对话用 --resume + transcript 回放；
//   - 工作区 = 已授权目录；切换工作区会打开该目录最近活跃的对话（没有才新建）。

import { create } from "zustand";
import { apiFetch, setToken } from "../lib/runtime";
import {
  appendError,
  settleStreaming,
  appendPromptEcho,
  appendUser,
  applyCLI,
  attachTurnUsage,
  commandsChanged,
  isTurnResult,
  mergeReplayed,
  prependSystem,
  settleSubagents,
  subagentFrame,
  turnsFromTranscript,
} from "../lib/normalize";
import {
  applyUsageMessage,
  mergeSpeedSamples,
  mergeUsage,
  messageTokens,
  settleTurnUsage,
  usageFromTranscript,
  type UsageSnapshot,
} from "../lib/usage";
import { localWorkFrom, NO_LOCAL_WORK, type LocalWork } from "../lib/localWork";
import { effortApply } from "../lib/providerForm";
import { isNewChat } from "../lib/newChat";
import { openFnosFileManager } from "../lib/fnos";
import { draftKeyFor, dropDraft, moveDraft } from "../lib/drafts";
import { userBubblePayload } from "../lib/attachments";
import type { Item } from "../lib/model";
import { ARCHIVED_NOTICE_EN, ARCHIVED_NOTICE_ZH } from "../lib/conversations";
import { tr } from "../lib/i18n";
import { ClaudeClient, type ConnStatus, type StatusDetail } from "../transport/client";
import type {
  AuthMethod,
  ClaudeCheck,
  ClaudeStatus,
  ConversationInfo,
  FsAccess,
  FsListing,
  FsPickListing,
  HostFile,
  GatewayModel,
  InitPayload,
  LiveTask,
  ModelsResult,
  PermissionPayload,
  ProbeResult,
  PublicSettings,
  Selection,
  SessionInfo,
  TranscriptPayload,
  WireAttachment,
  WireEvent,
  WorkspaceEntry,
  WorkspacesPayload,
} from "../transport/types";
import { normalizeSettings, type ProviderForm } from "../lib/providerForm";
import { belongs, latestConversation, timeValue, workspaceFor } from "../lib/conversations";
import {
  MAX_QUEUED,
  enqueuePrompt as pushQueued,
  headPrompt,
  removePrompt,
  shouldFlushAfter,
  updatePrompt,
  type QueuedPrompt,
} from "../lib/queue";
import { clearAskProgress } from "../lib/askDrafts";

export type { SessionInfo } from "../transport/types";

export interface InfoResponse {
  version: string;
  base_url: string;
  socket: string;
  claude_bin: string;
  claude_version: string;
  /** 是否有可用的托管 claude 版本（没有就弹安装引导）。 */
  claude_installed?: boolean;
  /** 当前生效的托管版本号。 */
  claude_active?: string;
  projects_root: string;
  /** 本应用在飞牛里的 appname（后端由 TRIM_APPNAME 派生）：打开授权页要带上它。 */
  trim_app?: string;
  data_dir: string;
  claude_home: string;
  settings_file: string;
  workspaces_file: string;
  conversations_file?: string;
  auto_start: boolean;
  current_workspace: string;
  auth_required: boolean;
  /** 本次连接的鉴权方式：环境变量令牌 / TCP 访问密码 / 不需要。 */
  auth_mode?: "token" | "password" | "none";
  /** 本次请求走的入口：unix socket 还是 TCP 直连。 */
  channel?: "unix" | "tcp";
  /** 正在监听的 TCP 端口（未监听时为 0）；「设置 → 访问」用它显示真实状态。 */
  tcp_port?: number;
  tcp_listening?: boolean;
  tcp_error?: string;
  frontend: boolean;
  max_sessions: number;
  /**
   * claude 用户级 settings 里的 `askUserQuestionTimeout`（`never` / `60s` / `5m` / `10m`），
   * 没配就是空串。提问卡片据此提示「CLI 到点会自己收尾」——我们不改用户设置，只显示。
   */
  ask_question_timeout?: string;
  started_at: string;
}

export interface ProjectEntry {
  name: string;
  path: string;
  has_git: boolean;
}

export interface ConnInfo extends StatusDetail {
  state: ConnStatus | "idle";
}

/** 设置补丁（与后端 settings.Patch 对应）。 */
export interface SettingsPatch {
  providers?: unknown;
  selected?: Selection;
  permission_mode?: string;
  auto_compact_window?: string;
  disable_unknown_model_window?: boolean;
  locale?: string;
  font_size?: number;
  proxy_url?: string;
  idle_minutes?: number;
  max_sessions?: number;
  subagent_max_concurrent?: number;
  subagent_spawn_depth?: number;
  tcp_enabled?: boolean;
  tcp_port?: number;
  /** 留空表示沿用已保存的密码。 */
  tcp_password?: string;
  /** 登录会话有效期（小时，12–72）。 */
  login_ttl_hours?: number;
}

interface AppState {
  info: InfoResponse | null;
  settings: PublicSettings | null;
  settingsSaving: boolean;

  /** 「设置 → 部署」的状态；null 表示还没拉过。 */
  claude: ClaudeStatus | null;
  /** 部署页的局部错误（检查更新失败、安装失败），不占用全局错误条。 */
  claudeError: string | null;

  workspaces: WorkspaceEntry[];
  workspaceRoot: string;
  currentWorkspace: string;
  workspaceBusy: boolean;
  starting: boolean;

  projects: ProjectEntry[];
  sessions: SessionInfo[];
  conversations: ConversationInfo[];
  activeId: string | null;

  items: Record<string, Item[]>;
  /**
   * 子代理的实时消息：`subagentItems[sid][agentId]`。
   *
   * 打开 --forward-subagent-text 后子代理的正文会混在同一个 stdout 里（带
   * parent_tool_use_id），必须按 agent 分流到这里，绝不能进主消息流。
   */
  subagentItems: Record<string, Record<string, Item[]>>;
  /**
   * 子代理的**实时** token 用量：`subagentTokens[sid][agentId]`。
   *
   * 为什么要单独存一份：CLI 的 `task_progress`（带 usage）只在子代理**调用过工具**之后
   * 才发，一个只思考、不调工具的子代理在结束前一条进度都不会来——列表上就只剩运行时间，
   * token 要等 `task_notification` 才出现。而 `--forward-subagent-text` 转发过来的
   * assistant 帧一直带着 usage，按 CLI 自己的口径（`prompt + output`，取最后一次请求）
   * 算出来与最终那条通知同源（`lib/usage.messageTokens`）。
   */
  subagentTokens: Record<string, Record<string, number>>;
  /**
   * 要在右侧栏打开的子代理对话。右侧栏的标签是它自己管的，这里只放一个「请求」，
   * nonce 让重复点同一张卡片也能把标签切回来。
   *
   * 请求是一次性的：右侧栏消费完必须 `clearSubagentView`（否则关掉侧栏再打开、
   * 组件重新挂载时会把上面那条请求重放一遍，用户会莫名其妙落在一个子代理标签上）。
   */
  subagentView: { agentId: string; label: string; nonce: number } | null;
  perms: Record<string, PermissionPayload[]>;
  inits: Record<string, InitPayload>;
  states: Record<string, string>;
  /**
   * 后端记的「还没结束的后台任务」：`liveTasks[sid]`（task_id ↔ tool_use_id）。
   *
   * 列表本身仍从消息流现算（见 lib/backgroundTasks），这一份只补一个东西：
   * `task_id` 只出现在实时的 task_started 里，中途连上来的设备走转录回放拿不到它，
   * 界面上「进行中」的条目就点不了中止。随 session.snapshot 一起来。
   */
  liveTasks: Record<string, LiveTask[]>;
  /**
   * 「待发送」队列：`queued[sid]`。回合进行中主手势（Enter / 发送按钮）投递哪一档由
   * 「繁忙时的发送行为」决定（`lib/busyEnter`）：默认只入队（可编辑、可删），本轮正常
   * 结束后自动发队首；选「插话发送」才立刻写进 stdin 并进本轮。`Ctrl/⌘+Enter` 永远用
   * 另一档。见 lib/queue.ts 与 store.flushQueued。
   */
  queued: Record<string, QueuedPrompt[]>;
  conns: Record<string, ConnInfo>;
  /**
   * 一轮跑完、但用户还没打开看过的对话。侧栏用它显示绿点；
   * 打开对话（setActive）即清除，否则绿点会一直挂着。
   */
  doneIds: Record<string, boolean>;
  /**
   * 每个会话当前生效的权限模式，只认 CLI 报上来的值（system/status 与 system/init）。
   * 界面上「记住自己点过什么」会骗人：模型自己 ExitPlanMode、回包被拒、
   * 重启后进程换了默认模式，都只有 CLI 知道。
   */
  modes: Record<string, string>;
  /**
   * 每个会话的实时用量（上下文 / 缓存命中 / 输出速度）。
   * 只从 CLI 真实给出的 usage 派生，见 lib/usage 的说明。
   */
  usage: Record<string, UsageSnapshot>;

  // 「获取可用模型」的临时结果（按提供商分别保存会太啰嗦，这里只留最近一次）
  /**
   * 最近一次拉目录是谁发起的（表单 uid，未保存的草稿没有 id）。
   *
   * 弹窗用它的**变化**判断「这次结果是不是为我拉的」：新发一次请求时它会立刻变，
   * 之后哪怕请求失败（`gatewayModels` 被清空、`modelsError` 留空）也能认出来，
   * 不必靠 `gatewayModels.length === 0` 去猜（上一家没模型时那个条件恒成立）。
   */
  modelsFor: string;
  /** `modelsFor` 那次请求还在飞（弹窗据此显示「正在获取模型列表…」）。 */
  modelsLoading: boolean;
  gatewayModels: GatewayModel[];
  modelsError: string | null;
  modelsRaw: string;
  modelsAttempts: { path: string; status: number; note: string }[];
  /**
   * 拉目录时「按配置的认证方式被拒、换成它才成功」的那一种（x-api-key / bearer）。
   * 非空且与表单当前值不同时，卡片会把它写回「认证方式」并提示保存——
   * 对话没有重试的机会，这里不改就等于下一次对话照旧 401。
   */
  modelsAuthSwitchedTo: AuthMethod | "";
  /**
   * 单模型验证的最近一次结果。key 是 `uid/model`——同一张卡片里的不同模型
   * 各自有自己的结论，`pending` 单独标出来（只靠 detail 里那句「验证中…」判断
   * 会把「后端真的这么说了」也当成在跑）。
   */
  verify: { key: string; pending: boolean; result: ProbeResult | null } | null;

  loading: boolean;
  error: string | null;
  /**
   * 一次性轻提示（toast）：只报一句人话，几秒后自己消失。
   *
   * 与 `error` 分开：错误条要用户处理（带关闭键、不会被自动收掉），
   * 而「麻烦先取消归档」这类说明看完就过去了。`seq` 让重复点同一处也能重新计时。
   */
  toast: { seq: number; text: string } | null;

  bootstrap: () => Promise<void>;
  loadSettings: () => Promise<void>;
  /** 重新拉 /api/info（改完 TCP 端口后刷新监听状态）。 */
  loadInfo: () => Promise<void>;
  /** 注销：吊销后端会话、清本地凭据并回到鉴权页。 */
  logout: () => Promise<void>;
  saveSettings: (patch: SettingsPatch) => Promise<boolean>;
  selectModel: (provider: string, model: string, effort?: string) => Promise<void>;
  fetchModelsFor: (form: ProviderForm) => Promise<void>;
  verifyModelFor: (form: ProviderForm, model: string) => Promise<void>;
  applyProxy: (url: string) => Promise<{ ok: boolean; warning?: string }>;

  loadClaudeStatus: () => Promise<void>;
  /** 查询 registry 最新版本；失败只写 claudeError。 */
  checkClaudeUpdate: () => Promise<ClaudeCheck | null>;
  /** 触发后台安装并轮询进度；成功返回 true。 */
  installClaude: (version: string, source?: string) => Promise<boolean>;
  /** 取消正在进行的安装；没有任务时后端幂等返回当前状态。 */
  cancelClaudeInstall: () => Promise<boolean>;
  /** 删除一个已安装且未生效的版本。 */
  deleteClaudeVersion: (version: string) => Promise<boolean>;
  setClaudeActive: (version: string) => Promise<boolean>;
  setClaudeSource: (source: string) => Promise<boolean>;

  refreshSessions: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  addWorkspace: (path: string, open?: boolean) => Promise<boolean>;
  removeWorkspace: (path: string) => Promise<boolean>;
  renameWorkspace: (path: string, name: string) => Promise<boolean>;
  /** 在指定工作区里新建一条对话（先切当前工作区，再创建；不打开旧对话）。 */
  startConversationIn: (path: string) => Promise<void>;
  /** 在飞牛文件管理器里显示目录；失败走全局错误条。 */
  openWorkspaceInFiles: (path: string) => Promise<void>;
  browseDirs: (path: string, hidden: boolean) => Promise<FsPickListing>;
  /**
   * 探测应用用户能否直接读写该目录。能读写就不必再申请飞牛授权，
   * 只有 writable=false（ACL 还没授予）时才走 authorizeUserFile。
   */
  probeDir: (path: string) => Promise<FsAccess>;
  /** 在目录选择器里新建一层文件夹，返回新目录绝对路径；失败直接抛错给弹窗展示。 */
  mkdirDir: (parent: string, name: string) => Promise<string>;
  /** 读取飞牛里挑中的图片/PDF（后端只放行这两类），用于转成对话附件。 */
  readHostFile: (path: string) => Promise<HostFile>;
  /**
   * 输入框 `@` 补全：按查询串返回工作区内的候选路径。
   *
   * 查询串原样交给后端分模式（含 `/` 就列那一层目录，否则在工作区里模糊搜索）；
   * `signal` 让下一个按键到来时取消上一次请求，避免慢盘上的迟到响应盖掉新结果。
   */
  completePaths: (cwd: string, query: string, signal?: AbortSignal) => Promise<FsListing>;
  /**
   * 右侧栏「引用到对话」的请求（带单调递增 seq）。Composer 消费一次后清空；
   * 由 `requestMention` 写入、`consumeMentionRequest` 清除。
   */
  mentionRequest: { seq: number; path: string; kind: "file" | "dir" } | null;
  /** 请 Composer 把某个工作区路径以 `@…` 的形式插进输入框（绝对路径，由 Composer 折算）。 */
  requestMention: (path: string, kind: "file" | "dir") => void;
  consumeMentionRequest: () => void;
  /**
   * 「把对话滚到这一条」的请求（右侧栏轨迹面板 → 对话区，带单调递增 seq）。
   *
   * 只由 `requestScrollToItem` 写入，不消费、不清空：消费方是 `MessageList`，
   * 它按 seq 去重。清空反而会出事——子代理标签里那份 `MessageList` 也是同一个
   * store 的消费者，谁先挂载谁清掉，主对话就永远收不到这次跳转（「在右侧栏打开」
   * 那次踩过同一个坑，见 AGENTS 里 `openRequest` 的说明）。
   */
  scrollRequest: { seq: number; itemId: string } | null;
  /** 请对话区滚到某一条消息（item id）。 */
  requestScrollToItem: (itemId: string) => void;
  /** 打开目录下最近一条对话；createIfEmpty=false 时没有对话就保持空态，不新建。 */
  ensureSession: (cwd?: string, createIfEmpty?: boolean) => Promise<SessionInfo | null>;
  createSession: (cwd?: string) => Promise<void>;
  /**
   * 打开一条既有对话。
   *
   * `onHistory` 在「转录已经铺进消息流」时调用一次，**早于 claude 拉起**——
   * 历史是磁盘上的 jsonl，跟子进程无关（见 openConversation 里的并行那一段）。
   * 历史记录页借此先把自己收起来，让用户在对话区看历史，而不是盯着列表等握手。
   */
  openConversation: (id: string, force?: boolean, onHistory?: () => void) => Promise<boolean>;
  renameConversation: (id: string, title: string) => Promise<boolean>;
  archiveConversation: (id: string, archived: boolean) => Promise<boolean>;
  pinConversation: (id: string, pinned: boolean) => Promise<boolean>;
  /** 从一条对话复制出新会话并打开它；title 是列表里显示的「原名（分叉）」。 */
  forkConversation: (id: string, title?: string) => Promise<boolean>;
  deleteConversation: (id: string) => Promise<boolean>;
  closeSession: (id: string) => Promise<void>;
  /** 让切换后的推理等级对已在跑的会话生效（必要时按同一 id 重开进程）。 */
  applyEffortChange: (id: string, effort: string) => Promise<void>;
  /** 关掉进程再按同一 id `--resume` 拉起来，上下文留在转录里。 */
  restartSession: (id: string) => Promise<boolean>;
  setActive: (id: string | null) => void;
  connect: (id: string) => void;
  disconnect: (id: string) => void;
  retryConnection: (id: string) => void;

  sendPrompt: (
    text: string,
    attachments?: WireAttachment[],
    attachmentLabel?: string,
    opts?: { priority?: "now" },
  ) => Promise<boolean>;
  /**
   * 只入队，不立刻写给 claude。回合进行中按 Enter 走这里；空闲时 Enter 语义不变
   * （入队后立刻发队首）。返回 false 表示没入队（满了 / 没有活动对话）。
   */
  enqueuePrompt: (text: string, attachments?: WireAttachment[], attachmentLabel?: string) => boolean;
  /** 从待发送里删掉一条。 */
  dropQueued: (id: string) => void;
  /** 改一条待发送的正文/附件（位置不变）；正文与附件都空等于删掉它。 */
  editQueued: (id: string, text: string, attachments?: WireAttachment[]) => void;
  /**
   * 标记「正在编辑哪一条待发送」。命中的那条在队首时按住自动发送——
   * 否则用户改到一半，这一轮结束就会把**旧文本**发出去、改动一起丢了。
   */
  setEditingQueued: (id: string | null) => void;
  /** 立刻把一条待发送消息写进 stdin（回合进行中就是插话）。失败放回队首。 */
  steerQueued: (id: string) => Promise<boolean>;
  /**
   * 把队首发出去。**只由「这一轮结束」的 result 事件触发**（见 applyEvent）：
   * 切对话、重连、状态变 ready 都不自动发——那会把「被中断后暂停的队列」偷偷放出去。
   */
  flushQueued: (sid: string) => Promise<boolean>;
  interrupt: () => void;
  setPermissionMode: (mode: string) => void;
  /** 在右侧栏打开某个子代理的对话。 */
  showSubagent: (agentId: string, label: string) => void;
  /** 右侧栏消费掉「查看子代理对话」请求后清空它（见 subagentView 注释）。 */
  clearSubagentView: () => void;
  /** 停止一个后台任务（子代理 / 后台命令）。 */
  stopTask: (taskId: string) => Promise<void>;
  replyPermission: (
    req: PermissionPayload,
    allow: boolean,
    updatedInput?: unknown,
    updatedPermissions?: unknown,
    message?: string,
  ) => void;

  applyEvent: (sid: string, ev: WireEvent) => void;
  clearError: () => void;
  /** 弹一条轻提示（覆盖上一条并重新计时）。 */
  showToast: (text: string) => void;
  clearToast: () => void;
}

const clients = new Map<string, ClaudeClient>();
/** 系统通道：与会话无关的应用级事件（目前只有 claude 有新版本）。
 *
 *  独立一条 WS，而不是复用会话连接：会话连接随对话开关（关对话、换工作区、删对话
 *  都会断），而「有新版本」跟对话无关——没有打开任何对话时也要收得到。
 *  复用 /ws 而不是再加一条 SSE：鉴权（?token=）、心跳、指数重连都已经在这里，
 *  而且 WS 已经过前置网关注入的验证。 */
let systemClient: ClaudeClient | null = null;
/** Git 面板当前盯着的仓库绝对路径；空串 = 不盯。
 *
 *  放在模块级而不是 store state：它只描述「系统通道该订阅什么」，没有任何组件
 *  会因为它的变化重渲染。断线重连后要照这个值重新订阅（服务端订阅跟着连接走，
 *  连接一断就取消了）。 */
/**
 * 每个会话已处理到的事件序号水位（`WireEvent.seq`）。
 *
 * 断线期间后端照样在产出事件（CLI 不会因为浏览器断开就停下），而 WS 只发给当前
 * 订阅者。重连后用 `sync {since: 水位, epoch}` 把这中间的缺口补回来——没有它，
 * 「断开期间跑完的那一轮」的正文、工具结果与结束时的 result（含本轮用量与速度）
 * 全部丢失，只有整页刷新（重建 store → 整份转录回放）才恢复。
 */
const eventSeq = new Map<string, number>();
/**
 * 每个会话记下的「会话对象身份」（`session.Session.Epoch`）。
 *
 * 进程被空闲回收 / 换档位重启后再用同一个 UUID `--resume`，后端的 seq 会从头开始。
 * 只比 seq 会把新进程的前几条当成老进程的续集拼上去，消息流彻底对不上，
 * 所以两者一起带上；对不上就整份重放转录。
 */
const eventEpoch = new Map<string, string>();
/**
 * 已应用过的事件序号，用来去重「补发帧」与「实时广播」的重叠。
 *
 * 补发帧（`session.replay`）与实时广播是两条独立的路：从「后端生成快照 → 前端发
 * sync → 后端回 replay」之间进来的实时事件会先落地，而它们同时也在补发的那一段里。
 * 只按「水位」跳过会把补发整段丢掉（早于水位的那几条恰恰是缺口本身），
 * 不去重则同一段正文出现两遍。所以逐条按序号认。
 *
 * 只留最近一段：序号单调递增，被淘汰的序号不会再出现（补发跨度受后端缓冲上限约束）。
 */
const appliedSeq = new Map<string, Set<number>>();

/** 记录一条已应用的事件；返回 false 表示这条之前已经处理过（重复投递）。 */
function markApplied(sid: string, seq: number): boolean {
  let set = appliedSeq.get(sid);
  if (!set) {
    set = new Set<number>();
    appliedSeq.set(sid, set);
  }
  if (set.has(seq)) return false;
  set.add(seq);
  if (set.size > 4096) {
    // 只做一次线性扫描：序号单调，低于「最大序号 - 2048」的不会再出现。
    let high = 0;
    for (const v of set) if (v > high) high = v;
    for (const v of set) if (v <= high - 2048) set.delete(v);
  }
  return true;
}

/**
 * 换会话对象（`epoch` 变了）时把水位与去重集合一起重置。
 *
 * 新进程的序号从 1 重新开始，而旧集合里装的是上一个进程的 1..N：不清的话新进程的
 * 前 N 条事件全部命中「已处理」被丢掉——正是「重启之后那一轮只剩后半截」。
 * 缓冲里的实时事件同理，它们属于旧 epoch 的序号空间，留着会按旧水位乱序应用。
 */
function resetSyncWatermark(sid: string, seq: number, epoch: string): void {
  eventSeq.set(sid, seq);
  eventEpoch.set(sid, epoch);
  appliedSeq.delete(sid);
  pendingLive.delete(sid);
  endSyncWindow(sid);
}

/**
 * 每个会话「最近一次有声」的时间（毫秒时间戳）。
 *
 * 两个来源都写它：① 收到任何一条会话帧；② 自己发出 prompt。**不放进 zustand state**：
 * 每条帧都触发一次 `set` 就是每条帧多一轮渲染，而读它的 `TurnTimer` 本来就每秒 tick
 * 一次，模块级变量足够及时。
 *
 * 为什么需要它：CLI 在一个字节都不回的那段时间里**什么都不发**——`api_retry` 只在
 * 失败后才有，`keep_alive` 又被后端丢掉了（AGENTS 4.2.3）。界面上只剩计时器在走，
 * 用户分不清「模型在想」和「上游已经没声了」。见 lib/silence 与 ChatPane 的提示行。
 */
const lastSoundAt = new Map<string, number>();

/** 记一次「上游出声了」（收到 CLI 帧）。 */
export function noteFrame(sid: string): void {
  lastSoundAt.set(sid, Date.now());
}

/** 记一次「刚发出去 prompt」：这一轮的沉默从此刻开始算，不沿用上一轮的旧时间。 */
export function notePrompt(sid: string): void {
  lastSoundAt.set(sid, Date.now());
}

/**
 * 读某个会话的最后一次有声时间；`undefined` 表示还没记过。
 *
 * 组件要跟着它重渲染，所以订阅了这个 Map 的**变化信号**：
 * `TurnTimer` 自己每秒 tick，不需要额外的事件源。
 */
export function lastSound(sid: string | null): number | undefined {
  return sid ? lastSoundAt.get(sid) : undefined;
}

/** 会话被删/被关掉时清掉，否则这张表随对话数量无限长。 */
function forgetSilence(sid: string): void {
  lastSoundAt.delete(sid);
  localWorkAt.delete(sid);
}

/**
 * 每个会话「CLI 自己在干活」的状态（上下文压缩中 / hook 在跑）。
 *
 * 与 `lastSoundAt` 同一套存法（模块级 Map，不进 zustand state）：它只在
 * `TurnTimer` 每秒 tick 时被读一次，为它多开一轮渲染不值得。
 *
 * 为什么要单独记：`TurnTimer` 那句「上游 Ns 没有响应」的前提是「这段时间本该有
 * 上游字节」。压缩与 hook 压根不等上游——手动 `/compact` 实测 25 秒一个字节都不回，
 * 而 CLI 自己的压缩心跳是 30 秒一次，15 秒阈值必然误报。判据只认 CLI 自己报的帧，
 * 见 lib/localWork。
 */
const localWorkAt = new Map<string, LocalWork>();

/** 读某个会话「本地在干什么」；没记过返回空状态。 */
export function localWork(sid: string | null): LocalWork {
  return (sid ? localWorkAt.get(sid) : undefined) ?? NO_LOCAL_WORK;
}

/**
 * 已经发出 `sync`、还没收到 `session.replay` 的会话。
 *
 * 这段时间里到达的实时事件**不能立即应用**：它可能比补发的那一段还晚，先落地就会
 * 让消息流的顺序颠倒（例如 result 抢在它对应的助手正文前面）。所以先压进
 * `pendingLive`，等补发帧到了再把两边按序号合起来统一应用。
 */
const awaitingReplay = new Set<string>();
/** 对齐窗口里暂存的实时事件（见 awaitingReplay）。 */
const pendingLive = new Map<string, WireEvent[]>();
/** sync 发出后的兜底计时器：后端没回补发帧时也不能让消息流一直卡着。 */
const syncTimers = new Map<string, number>();

/** 结束一次对齐窗口：清掉缓冲与计时器。 */
function endSyncWindow(sid: string): void {
  awaitingReplay.delete(sid);
  const timer = syncTimers.get(sid);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    syncTimers.delete(sid);
  }
}

/** 把缓冲住的实时事件按序号顺序应用掉（兜底路径 / 补发帧之后的余量）。 */
function flushLive(sid: string): void {
  const buffered = pendingLive.get(sid) ?? [];
  pendingLive.delete(sid);
  // 按 seq 排序再应用：缓冲里是到达顺序，不是产生顺序（补发帧之后还可能追进来）。
  buffered.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  for (const ev of buffered) useAppStore.getState().applyEvent(sid, ev);
}

const resumePromises = new Map<string, Promise<boolean>>();
/** 等这一轮结束后要按新档位重开的会话（`--effort` 只在进程启动时固定）。 */
const effortRestarts = new Set<string>();
/** 正在发待发送队首的会话：结果事件与 ready 事件可能挨着到，不加锁会连发两条。 */
const flushing = new Set<string>();
/** 正在编辑的那条待发送（只可能有一条：输入框上方的面板同一时刻只展开一个编辑框）。 */
let editingQueuedId: string | null = null;
/** 因为「正在编辑」被跳过的那次自动发送，编辑结束后补上。 */
const flushPending = new Set<string>();
/** toast 的停留时间：够看完一句「先取消归档」，又不至于挡着下面接着点。 */
export const TOAST_MS = 4000;
let toastSeq = 0;
let toastTimer: number | null = null;

// openSeq 记录「用户最近一次想打开/切换对话」的序号。openConversation 里有多段 await，
// 迟到的旧请求不能在结束时把 activeId 改回它自己 —— 用户看到的是他最后点的那条。
//
// **新建 / 归档 / 删除也要递增它**：它们同样改 `activeId`。不参与这套序号的后果是
// 「冷启动 --resume 期间点新对话，几秒后旧对话的回包又把用户抢回去」，甚至把刚归档
// 的对话重新拉起来（那条 open 的 connect 不在 seq 保护里）。
let openSeq = 0;

// startingCount 是 `starting` 的来源：新建与打开可能同时进行（用户在启动期间点了别的
// 对话），布尔值会互相覆盖——一方结束就把另一方的「启动中」也关掉，或者反过来永久
// 卡在 true（输入框与「新对话」按钮一起禁用，只能靠再开一条对话自愈）。
let startingCount = 0;

/**
 * 每条正在打开的对话「历史已经铺好」的那个 promise。
 *
 * 同一个 id 被并发打开时，第二次走的是「已经在起」的分支：它以前要等**整个握手**
 * 才回调 `onHistory`，于是历史记录页会一直转圈等子进程——而这条 commit 的目的正是
 * 不让用户等子进程。有这张表，第二个调用方可以只等转录那一步。
 */
const historyPromises = new Map<string, Promise<void>>();

/**
 * 把一个「按会话 id 分桶」的 map 里 from 那条搬到 to 下。
 *
 * `/clear` 之后 CLI 换了会话 id，描述「同一个进程」的那几项状态（状态机、init、
 * 权限模式、待发送队列…）必须跟着换：不换的话后续事件写进新桶、而界面读的是旧桶。
 *
 * **to 已有值时以它为准、不覆盖**：那说明新 id 上已经有内容（另一台设备先迁过、
 * 或用户重开过那条对话）。覆盖等于把对方正在用的那份整个抹掉。
 */
function moveKey<T>(map: Record<string, T>, from: string, to: string): Record<string, T> {
  if (from === to || !(from in map)) return map;
  const next = { ...map };
  if (!(to in next)) next[to] = next[from];
  delete next[from];
  return next;
}

/** 删掉一个按会话 id 分桶的键（`/clear` 之后「被清掉的那段」的状态不该跟过去）。 */
function dropKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** purgeSession 清掉某个会话在 store 里的全部按 id 存的桶。
 *  删除/关闭对话后不清，这些数组（含整份 tool 结果）会一直常驻内存。 */
function purgeSession(state: {
  items: Record<string, unknown>;
  subagentItems: Record<string, unknown>;
  subagentTokens: Record<string, unknown>;
  perms: Record<string, unknown>;
  states: Record<string, string>;
  inits: Record<string, unknown>;
  conns: Record<string, unknown>;
  usage: Record<string, unknown>;
  doneIds: Record<string, boolean>;
  modes: Record<string, string>;
  queued: Record<string, unknown>;
  liveTasks: Record<string, unknown>;
}, id: string) {
  delete state.items[id];
  delete state.subagentItems[id];
  delete state.subagentTokens[id];
  delete state.perms[id];
  delete state.states[id];
  delete state.inits[id];
  delete state.conns[id];
  delete state.usage[id];
  delete state.doneIds[id];
  delete state.modes[id];
  delete state.queued[id];
  delete state.liveTasks[id];
  forgetSilence(id);
  eventSeq.delete(id);
  eventEpoch.delete(id);
  appliedSeq.delete(id);
  pendingLive.delete(id);
  endSyncWindow(id);
}

/**
 * 模型提问卡片的草稿跟着请求走：请求有结论（本机提交 / 别的设备答掉 / CLI 自己收尾 /
 * 进程结束 / 中断）就把它清掉，否则下次同 id 的卡片会带着一份过期答案回填。
 */
function dropAskDrafts(perms: readonly { request_id: string }[] | undefined) {
  for (const p of perms ?? []) clearAskProgress(p.request_id);
}

/** 正在创建的新对话；此时发送必须等它落定，不能发到上一个 active。 */
let createTask: Promise<SessionInfo | null> | null = null;
const recovering = new Set<string>();
const ACTIVE_KEY = "ccweb-active-session";
let bootstrapPromise: Promise<void> | null = null;
/** 安装进度轮询句柄；同一时刻只允许一条轮询链。 */
let claudePollTimer: number | null = null;

function token(): string {
  try {
    return localStorage.getItem("ccweb-token") ?? "";
  } catch {
    return "";
  }
}

/** 正在盯 Git 的面板（按仓库 cwd 计数）。
 *
 *  分栏之后两栏可以各开一个 Git 面板、各看一个仓库：订阅是一个**集合**，
 *  一个面板切走只退掉它自己那个仓库，不能把另一栏还在看的仓库一起取消。 */
const gitWatchHolders = new Map<string, number>();

/** 这批连接已经发给服务端的订阅集合（重连后要整份补发）。 */
let sentGitWatch = new Set<string>();

/** 把「当前想要的订阅集合」同步给服务端：新增的发 watch，消失的发 unwatch。
 *
 *  页面在后台（手机锁屏、切到别的 App）时**不订阅**：后端是每 3 秒 spawn 一次 git，
 *  没人看的屏幕上不该让 NAS 一直跑。恢复可见时由 handleVisibility 重新订阅并补刷一次。 */
function sendGitWatch(force = false): void {
  if (!systemClient) {
    sentGitWatch = new Set();
    return;
  }
  const want = document.hidden ? new Set<string>() : new Set(gitWatchHolders.keys());
  for (const cwd of want) {
    if (force || !sentGitWatch.has(cwd)) systemClient.send({ kind: "git.watch", cwd });
  }
  for (const cwd of sentGitWatch) {
    if (!want.has(cwd)) systemClient.send({ kind: "git.unwatch", cwd });
  }
  sentGitWatch = want;
}

/** 申请盯一个仓库，返回释放函数（必须成对调用：面板卸载 / 切走时释放）。
 *  可重入：多个面板看同一个仓库只订阅一次。 */
export function acquireGitWatch(cwd: string | null): () => void {
  const key = (cwd ?? "").trim();
  if (!key) return () => {};
  gitWatchHolders.set(key, (gitWatchHolders.get(key) ?? 0) + 1);
  sendGitWatch();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (gitWatchHolders.get(key) ?? 1) - 1;
    if (left > 0) gitWatchHolders.set(key, left);
    else gitWatchHolders.delete(key);
    sendGitWatch();
  };
}

/** `git.changed` 的订阅者：每个 Git 面板只处理自己那个仓库的推送。 */
const gitChangedListeners = new Set<(cwd: string) => void>();

export function subscribeGitChanged(listener: (cwd: string) => void): () => void {
  gitChangedListeners.add(listener);
  return () => {
    gitChangedListeners.delete(listener);
  };
}

/** 转达一次「仓库变了」。空 cwd 表示「不知道是哪个」（旧后端 / 重连补刷），
 *  每个面板都刷新一次自己的仓库。 */
export function notifyGitChanged(cwd: string): void {
  for (const listener of gitChangedListeners) listener(cwd);
}

/** 切回前台时补订阅 + 补刷：后台期间的变化不会补推，订阅也是跟着可见性断开的。 */
function handleVisibility(): void {
  if (gitWatchHolders.size === 0) return;
  sendGitWatch();
  if (document.hidden) return;
  for (const cwd of gitWatchHolders.keys()) notifyGitChanged(cwd);
}

/** 打开系统通道（幂等）。系统通道只收应用级事件（claude 更新、对话列表变化），事件交给 applyEvent 统一处理。 */
function openSystemChannel(): void {
  if (systemClient) return;
  let firstOpen = true;
  const client = new ClaudeClient("", token(), {
    // 只放行应用级事件：别的 kind 落到 applyEvent 会带着空 sid 写进各会话的桶里。
    onEvent: (ev) => {
      // 自动化任务可能在没人看屏幕时新建对话，这里收到就刷新列表。
      if (ev.kind === "claude.update" || ev.kind === "conversations.changed" || ev.kind === "git.changed") {
        useAppStore.getState().applyEvent("", ev);
      }
    },
    onStatus: (status) => {
      if (status !== "open") return;
      // 服务端的订阅跟着连接走，旧连接一断就没了：每次连上都要补发一次，
      // 哪怕订阅值没变（watchGitRepo 里的去重只在本地生效）。
      sendGitWatch(true);
      // 首次连接后的状态由 bootstrap 自己拉；重连成功后补一次——断线期间可能有新版，
      // 也可能有自动化任务新建/跑完了一条对话（不补拉的话侧栏停在「新对话 + 转圈」）。
      if (firstOpen) {
        firstOpen = false;
        return;
      }
      void useAppStore.getState().loadClaudeStatus();
      void useAppStore.getState().refreshConversations();
      // 断线期间的仓库变化不会有推送补上，重新连上时主动把每个订阅的仓库刷一次。
      for (const cwd of gitWatchHolders.keys()) notifyGitChanged(cwd);
    },
  });
  systemClient = client;
  client.connect();
  // 可见性只在系统通道打开后才有意义（订阅本身挂在它上面）：挂一次，进程内常驻。
  document.addEventListener("visibilitychange", handleVisibility);
}

function readActiveId(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeActiveId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // 隐私模式忽略
  }
}

/**
 * 把用量快照写进对话元数据（conversations.json）。
 *
 * 失败不打扰用户：这只是底部统计的缓存，实时数据仍然在 store 里。
 * 内容没变就不发请求（同一回合的多次 result 不该重复落盘）。
 */
const persistedUsage = new Map<string, string>();
async function persistUsage(id: string, usage: UsageSnapshot): Promise<void> {
  const encoded = JSON.stringify(usage);
  if (persistedUsage.get(id) === encoded) return;
  persistedUsage.set(id, encoded);
  try {
    await apiFetch("/api/conversations", { method: "PATCH", body: JSON.stringify({ id, usage }) });
  } catch {
    persistedUsage.delete(id);
  }
}

/** 等 WS 真正 open；新建会话后立刻发送消息时不能只看 HTTP 返回。 */
function waitForOpen(id: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (clients.get(id)?.ready) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      window.setTimeout(tick, 60);
    };
    tick();
  });
}

/** 把草稿提供商转成 /api/settings/models 需要的入参。 */
function providerRef(form: ProviderForm) {
  return {
    provider_id: form.isNew ? "" : form.id,
    base_url: form.baseUrl,
    api_key: form.apiKey,
    auth: form.auth,
    models_path: form.modelsPath,
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 把 `/api/history/transcript` 的原始事件行折成渲染用的消息列表。 */
function itemsFromTranscript(tr: TranscriptPayload): Item[] {
  let next: Item[] = [];
  for (const line of tr.lines ?? []) {
    const rec = line as { timestamp?: unknown };
    const at = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    // replay=true：关掉「CLI 回显去重」。那套去重是给实时流用的（本地已经乐观插过
    // 一条气泡），转录里每条 user 行都是真的发过的，而且转录没有 result 行、按 result
    // 划的轮边界永远触发不到——开着它会把用户重复发送的同一句话吞掉。
    next = applyCLI(next, line, Number.isFinite(at) ? at : Date.now(), undefined, { replay: true });
  }
  // 转录里没有 result 行（claude 只把 result 写 stdout），所以「本轮耗时 ·
  // 输出 tok」必须从 assistant / api-request 行自己推，否则刷新后全丢。
  next = attachTurnUsage(next, turnsFromTranscript(tr.lines ?? []));
  // 子代理的收尾状态只在 `subagents/*.meta.json` 里：主转录没有 `system/task_*`，
  // 被中断（TaskStop）的那些连 `<task-notification>` 都不写——不在这里结算，
  // 重开对话后页头会一直给它们转圈。
  next = settleSubagents(next, tr.subagents);
  // 后端只回放最近 20k 行 / 16MB；被截断时必须说出来，否则用户会以为
  // 这段对话本来就这么短。
  if (tr.truncated) next = prependSystem(next, "更早的消息已被省略（只保留最近一段转录）");
  return next;
}

/**
 * 重连补不齐时整份重放转录（`session.resync` 的响应）。
 *
 * 与 `openConversation` 里的回放**不是同一份**：那里还负责起会话、切工作区、
 * 处理失败；这里只做「把磁盘上的历史读回来，跟本地合并」，不碰进程。
 * 也不能复用那里的短路（本地已有 items 就直接返回）——正是因为它有一份残缺的
 * 本地列表才需要重建。
 */
async function replayTranscript(id: string, get: () => AppState): Promise<void> {
  const conv = get().conversations.find((c) => c.id === id);
  try {
    const tr = await apiFetch<TranscriptPayload>(`/api/history/transcript?id=${encodeURIComponent(id)}`);
    const next = itemsFromTranscript(tr);
    const base = mergeUsage(conv?.usage, usageFromTranscript(tr.lines ?? []));
    // 断线重连的 resync 不能用磁盘那份整份覆盖内存里的速度样本：这一轮刚量到的
    // 那几次请求磁盘上还没有（transcript 里没有 genMs），覆盖后速度计会退回上一轮。
    const live = get().usage[id];
    const snap =
      base && live?.speedSamples?.length
        ? { ...base, speedSamples: mergeSpeedSamples(base.speedSamples, live.speedSamples) }
        : base;
    useAppStore.setState((s) => ({
      items: { ...s.items, [id]: mergeReplayed(next, s.items[id] ?? [], true) },
      ...(snap ? { usage: { ...s.usage, [id]: snap } } : {}),
    }));
  } catch {
    // 转录还没落盘（刚新建的对话）：本地那份就是全部，保持不动。
  }
}

/**
 * 收到 `session.snapshot` 之后决定要不要补拉断线期间漏掉的事件。
 *
 * 分三种情况：
 *   ① 本地没记过身份（第一次连这条会话 / 刚换进程）：把水位对齐到快照里的序号，
 *      不补——消息流刚由转录回放铺好，再补一遍会叠成两份。
 *   ② 身份变了（进程被回收/重启后用同一 UUID 又起来了，序号从头开始）：光比序号
 *      会把新进程的前几条当成老进程的续集拼上去，直接整份重放转录。
 *   ③ 身份一致、序号有缺口：发 sync 把那段补回来。
 */
function syncMissedEvents(sid: string, epoch: string | undefined, seq: number | undefined): void {
  if (!epoch || typeof seq !== "number") return;
  const knownEpoch = eventEpoch.get(sid);
  const knownSeq = eventSeq.get(sid);
  if (knownEpoch !== undefined && knownEpoch !== epoch) {
    // 会话对象换过了（进程被回收/重启后用同一个 UUID 又起来了）：旧 epoch 的序号
    // 没有可比性。水位对齐到新值，**去重集合也要清掉**——新进程的序号从 1 重新
    // 开始，而旧集合里全是 1..N，不清的话新进程的前 N 条事件会被当成「已经处理过」
    // 直接丢掉，界面上就是「重启之后那一轮只有后半截」。
    resetSyncWatermark(sid, seq, epoch);
    // 补不齐就整份重放转录：本地那份消息流属于上一个进程，接不上。
    void replayTranscript(sid, () => useAppStore.getState());
    return;
  }
  eventEpoch.set(sid, epoch);
  if (knownEpoch === undefined || knownSeq === undefined) {
    eventSeq.set(sid, seq);
    return;
  }
  if (seq <= knownSeq) return;
  // 对齐窗口：补发帧到达前，实时事件先压着（见 awaitingReplay 的注释）。
  // 上一次窗口的计时器要先撤掉：它会看到 awaitingReplay 里还有这个 sid
  // （新窗口的），提前把缓冲冲掉。
  const stale = syncTimers.get(sid);
  if (stale !== undefined) window.clearTimeout(stale);
  awaitingReplay.add(sid);
  // 兜底：后端没回补发帧（连接又断了 / 版本不匹配）时，1 秒后自己把缓冲的实时事件
  // 应用掉，别让界面一直卡在「已经连上但消息不动」。
  const timer = window.setTimeout(() => {
    if (!awaitingReplay.has(sid)) return;
    endSyncWindow(sid);
    flushLive(sid);
  }, 1000);
  syncTimers.set(sid, timer);
  clients.get(sid)?.send({ kind: "sync", since: knownSeq, epoch });
}

/**
 * 服务端重启后旧会话 id 已消失：WebSocket 会一直重连到 404。
 * 重试若干次后核对一次会话列表，旧 id 不在就切到当前工作区的 ensure 会话。
 */
async function recoverSession(id: string, get: () => AppState): Promise<void> {
  if (recovering.has(id)) return;
  recovering.add(id);
  try {
    const r = await apiFetch<{ sessions: SessionInfo[] }>("/api/sessions");
    if ((r.sessions ?? []).some((s) => s.id === id)) return;

    const conv = get().conversations.find((c) => c.id === id);
    const cwd = conv?.cwd || get().sessions.find((s) => s.id === id)?.cwd || get().currentWorkspace;
    get().disconnect(id);
    useAppStore.setState({ sessions: r.sessions ?? [] });
    if (get().activeId !== id) return;

    // 后端重启后进程没了，但对话 id 是稳定的：先用同一个 id 恢复。
    if (conv) {
      const ok = await get().openConversation(id, true);
      if (ok) return;
    }
    get().setActive(null);
    writeActiveId(null);
    if (!cwd) return;
    // 恢复失败（转录被删/目录不可用）：退到同工作区下一条，再不行新建。
    const root = conv ? workspaceFor(conv.cwd, get().workspaces) || conv.cwd : cwd;
    const next = get()
      .conversations.filter((c) => c.id !== id && !c.archived && belongs(c.cwd, root))
      .sort((a, b) => timeValue(b.last_active) - timeValue(a.last_active))[0];
    if (next) {
      if (await get().openConversation(next.id, true)) return;
    }
    await get().createSession(cwd);
  } catch {
    // 网络还没恢复：留给下一轮重试
  } finally {
    recovering.delete(id);
  }
}

/**
 * 「查看子代理对话」请求的序号，跨请求单调递增。
 *
 * 放在模块级而不是 state 里：请求消费后 `subagentView` 会清空，若从 state 里
 * 读上一次的 nonce 就会归零，重复点同一个子代理时 nonce 又回到 1。
 */
let subagentViewSeq = 0;

/**
 * 「引用到对话」的请求序号：只存路径的话，同一个文件点第二次值没变，
 * Composer 的 effect 不会重跑（与右侧栏 `openRequest` 同一个坑）。
 */
let mentionRequestSeq = 0;

/** 轨迹面板「跳到某一步」的序号：同一步点第二次值没变，只有 seq 能触发重放。 */
let scrollRequestSeq = 0;

/**
 * 对话列表请求的序号：`refreshConversations` 只认最后一次发出去的结果。
 *
 * 它被系统通道、`conversations.changed` 推送、WS 重连一起调用，并发很常见——
 * 先发的那次（比如删除前）晚回来，会把已经删掉的对话又摆回侧栏。
 */
let conversationsSeq = 0;

/** 单模型验证的序号：只认最后一次发出去的结果（先点 A 再点 B 时 A 的迟到响应作废）。 */
let verifySeq = 0;

/**
 * 「获取可用模型」的序号：与 `verifySeq` 同一条规矩。
 *
 * 目录是全局单份（`modelsFor` + `gatewayModels`），两张卡片先后点「获取」时，
 * 先发的那次晚回来就会顶掉后一次的目录——弹窗里摆着 A 的模型，确认后却写进 B，
 * 用户看到的是「加了几个不存在的模型」。
 */
let modelsSeq = 0;

export const useAppStore = create<AppState>()((set, get) => ({
  info: null,
  settings: null,
  settingsSaving: false,
  claude: null,
  claudeError: null,
  workspaces: [],
  workspaceRoot: "",
  currentWorkspace: "",
  workspaceBusy: false,
  starting: false,
  projects: [],
  sessions: [],
  conversations: [],
  activeId: null,
  items: {},
  subagentItems: {},
  subagentTokens: {},
  subagentView: null,
  perms: {},
  inits: {},
  states: {},
  liveTasks: {},
  conns: {},
  queued: {},
  doneIds: {},
  modes: {},
  usage: {},
  modelsFor: "",
  modelsLoading: false,
  gatewayModels: [],
  modelsError: null,
  modelsRaw: "",
  modelsAttempts: [],
  modelsAuthSwitchedTo: "",
  verify: null,
  loading: false,
  error: null,
  toast: null,

  clearError: () => set({ error: null }),

  showToast: (text) => {
    const seq = ++toastSeq;
    set({ toast: { seq, text } });
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastTimer = null;
      // 期间又弹了一条就不收：那条有自己的计时器。
      if (get().toast?.seq === seq) set({ toast: null });
    }, TOAST_MS);
  },

  clearToast: () => {
    if (toastTimer !== null) {
      window.clearTimeout(toastTimer);
      toastTimer = null;
    }
    set({ toast: null });
  },

  bootstrap: async () => {
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      set({ loading: true, error: null });
      try {
        const info = await apiFetch<InfoResponse>("/api/info");
        const [settings, ws, sessions, conversations] = await Promise.all([
          apiFetch<PublicSettings>("/api/settings").catch(() => null),
          apiFetch<WorkspacesPayload>("/api/workspaces").catch(() => null),
          apiFetch<{ sessions: SessionInfo[] }>("/api/sessions").catch(() => ({ sessions: [] })),
          apiFetch<{ conversations: ConversationInfo[] }>("/api/conversations").catch(() => ({ conversations: [] })),
        ]);
        const workspacePayload: WorkspacesPayload = ws ?? {
          workspaces: [],
          current: info.current_workspace ?? "",
          root: info.projects_root ?? "",
        };
        const conversationList = conversations.conversations ?? [];
        set({
          info,
          settings: normalizeSettings(settings),
          workspaces: workspacePayload.workspaces ?? [],
          workspaceRoot: workspacePayload.root ?? info.projects_root ?? "",
          currentWorkspace: workspacePayload.current ?? "",
          sessions: sessions.sessions ?? [],
          conversations: conversationList,
          loading: false,
        });

        // 部署状态独立拉取：失败不影响主流程（离线时只是拿不到「有更新」提示）。
        void get().loadClaudeStatus();
        // 后端每小时查一次新版本，有更新就通过系统通道推过来。
        openSystemChannel();

        // 没有可用的 claude 时不要自动建会话：后端必然失败，只会弹一条红条，
        // 而首屏的安装引导已经把话说清楚了。
        if (info.claude_installed === false) return;

        // 优先恢复上次打开且未归档的对话；否则当前工作区最近的一条；
        // 都没有（或已被归档/删除）才开一条新对话。
        const saved = readActiveId();
        const savedConv = conversationList.find((c) => c.id === saved && !c.archived);
        const pick = savedConv ?? latestConversation(workspacePayload.current, conversationList);
        if (pick) {
          await get().openConversation(pick.id);
          return;
        }
        if (workspacePayload.current) {
          await get().createSession(workspacePayload.current);
        }
      } catch (e) {
        set({ loading: false, error: errText(e) });
      } finally {
        bootstrapPromise = null;
      }
    })();
    return bootstrapPromise;
  },

  loadSettings: async () => {
    try {
      const s = normalizeSettings(await apiFetch<PublicSettings>("/api/settings"));
      set({ settings: s });
    } catch (e) {
      set({ error: errText(e) });
    }
  },

  loadInfo: async () => {
    try {
      set({ info: await apiFetch<InfoResponse>("/api/info") });
    } catch (e) {
      set({ error: errText(e) });
    }
  },

  logout: async () => {
    // 后端不可达也要退出：本地凭据必须清掉，否则用户以为已经注销。
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* 忽略：本地照样清 */
    }
    setToken("");
    // 整页重载最干净：顺带断掉所有 WS、清空内存里的会话状态，回到鉴权页。
    window.location.reload();
  },

  saveSettings: async (patch) => {
    set({ settingsSaving: true, error: null });
    try {
      const s = await apiFetch<PublicSettings>("/api/settings", {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      set({ settings: normalizeSettings(s), settingsSaving: false });
      return true;
    } catch (e) {
      set({ settingsSaving: false, error: errText(e) });
      return false;
    }
  },

  // 选中模型 = 动态指定 CLI 的默认模型。
  // 同一提供商下可以热切换（发 set_model）；跨提供商必须新建会话，
  // 因为地址与密钥在进程启动时就固定了。
  selectModel: async (provider, model, effort) => {
    const ok = await get().saveSettings({ selected: { provider, model, effort } });
    if (!ok) return;

    const id = get().activeId;
    if (!id) return; // 没有活动会话：新会话会用新选择，不必做什么

    const sess = get().sessions.find((s) => s.id === id);
    if (!sess) return;

    // 同一提供商：模型只是请求参数，热切换即可。
    if (sess.provider === provider) {
      clients.get(id)?.send({ kind: "model", model });
      await get().refreshSessions();
      await get().applyEffortChange(id, effort ?? "");
      return;
    }

    // 提供商不同（含「会话创建时还没选模型」这种 provider 为空的情况）：
    // 地址与密钥在进程启动时就已经固定，改不了。必须重建会话。
    if ((get().states[id] ?? sess.state) === "busy") {
      set({ error: "本轮还在运行，无法切换提供商；等这一轮结束再切，或先点中断" });
      return;
    }
    const cwd = sess.cwd;
    await get().closeSession(id);
    await get().createSession(cwd);
  },

  fetchModelsFor: async (form) => {
    // key 用表单 uid：弹窗靠它的变化判断「结果到了」，而未保存的草稿 id 是空串，
    // 用 id 时上一家的目录会看起来像这一家的。
    const key = form.uid || form.id;
    const seq = ++modelsSeq;
    set({ modelsFor: key, modelsLoading: true, gatewayModels: [], modelsError: null, modelsRaw: "", modelsAttempts: [], modelsAuthSwitchedTo: "", error: null });
    try {
      const r = await apiFetch<ModelsResult>("/api/settings/models", {
        method: "POST",
        body: JSON.stringify(providerRef(form)),
      });
      // 只认最后一次发出去的请求：先点 A 再点 B 时，A 的迟到响应不能把 B 的
      // 目录（连同它自己的 `modelsFor`）顶掉。
      if (seq !== modelsSeq) return;
      if (r.models && r.models.length > 0) {
        set({
          modelsLoading: false,
          gatewayModels: r.models,
          modelsAttempts: r.attempts ?? [],
          modelsAuthSwitchedTo: r.auth?.switched_to ?? "",
        });
      } else {
        set({
          modelsLoading: false,
          gatewayModels: [],
          modelsError: r.detail || "未获取到模型",
          modelsRaw: r.raw ?? "",
          modelsAttempts: r.attempts ?? [],
        });
      }
    } catch (e) {
      if (seq !== modelsSeq) return;
      set({ modelsLoading: false, gatewayModels: [], modelsError: errText(e), modelsRaw: "" });
    }
  },

  verifyModelFor: async (form, model) => {
    if (!model.trim()) return;
    // key 用 uid：草稿的 id 是空串，两张草稿的同名模型会共用一个 key。
    const key = `${form.uid || form.id}/${model}`;
    const seq = ++verifySeq;
    set({ verify: { key, pending: true, result: null } });
    try {
      const r = await apiFetch<ProbeResult>("/api/settings/verify", {
        method: "POST",
        body: JSON.stringify({ ...providerRef(form), model }),
      });
      if (seq !== verifySeq) return;
      set({ verify: { key, pending: false, result: r } });
    } catch (e) {
      if (seq !== verifySeq) return;
      set({
        verify: {
          key,
          pending: false,
          result: { ok: false, endpoint: "", method: "", status: 0, latency_ms: 0, detail: errText(e) },
        },
      });
    }
  },

  applyProxy: async (url) => {
    set({ settingsSaving: true, error: null });
    const oldActive = get().activeId;
    const oldCwd =
      get().conversations.find((c) => c.id === oldActive)?.cwd ||
      get().sessions.find((s) => s.id === oldActive)?.cwd ||
      get().currentWorkspace;
    try {
      const res = await apiFetch<{ settings: PublicSettings; sessions: SessionInfo[]; warning?: string }>("/api/settings/proxy", {
        method: "POST",
        body: JSON.stringify({ proxy_url: url }),
      });
      set({
        settings: normalizeSettings(res.settings),
        sessions: res.sessions ?? [],
        settingsSaving: false,
        error: res.warning || null,
      });
      if (oldActive) {
        clients.get(oldActive)?.close();
        clients.delete(oldActive);
      }
      const list = res.sessions ?? [];
      const next =
        list.find((s) => s.id === oldActive) ??
        list.find((s) => s.cwd === oldCwd) ??
        list[0] ??
        null;
      get().setActive(next?.id ?? null);
      if (next) get().connect(next.id);
      await get().refreshConversations();
      return { ok: !res.warning, warning: res.warning };
    } catch (e) {
      set({ settingsSaving: false, error: errText(e) });
      return { ok: false, warning: errText(e) };
    }
  },

  loadClaudeStatus: async () => {
    try {
      const st = await apiFetch<ClaudeStatus>("/api/claude/status");
      set({ claude: st, claudeError: null });
      // /api/info 里的安装状态是启动时算的：装完/切版本后要同步，
      // 否则「未安装」弹窗和侧栏更新标记会一直停在旧值。
      const cur = get().info;
      const usable = st.installed.length > 0;
      if (cur && (cur.claude_installed !== usable || cur.claude_active !== st.active)) {
        set({
          info: {
            ...cur,
            claude_installed: usable,
            claude_active: st.active,
            claude_version: st.active || cur.claude_version,
          },
        });
      }
    } catch (e) {
      set({ claudeError: errText(e) });
    }
  },

  checkClaudeUpdate: async () => {
    set({ claudeError: null });
    try {
      const res = await apiFetch<ClaudeCheck>("/api/claude/check", { method: "POST" });
      await get().loadClaudeStatus();
      return res;
    } catch (e) {
      set({ claudeError: errText(e) });
      return null;
    }
  },

  installClaude: async (version, source) => {
    set({ claudeError: null });
    try {
      const st = await apiFetch<ClaudeStatus>("/api/claude/install", {
        method: "POST",
        body: JSON.stringify({ version, source: source ?? "" }),
      });
      set({ claude: st });
    } catch (e) {
      set({ claudeError: errText(e) });
      return false;
    }
    // 后台安装：轮询到终态为止。失败也停在 claude.job.error 上，由部署页展示。
    return new Promise<boolean>((resolve) => {
      if (claudePollTimer !== null) window.clearTimeout(claudePollTimer);
      const tick = async () => {
        claudePollTimer = null;
        try {
          const st = await apiFetch<ClaudeStatus>("/api/claude/status");
          set({ claude: st });
          const phase = st.job?.phase;
          if (phase === "done" || phase === "error" || phase === "cancelled") {
            await get().loadClaudeStatus();
            if (phase === "error") set({ claudeError: st.job?.error ?? "安装失败" });
            resolve(phase === "done");
            return;
          }
        } catch {
          // 轮询期间的网络抖动不当作失败，继续下一轮
        }
        claudePollTimer = window.setTimeout(() => void tick(), 800);
      };
      claudePollTimer = window.setTimeout(() => void tick(), 400);
    });
  },

  cancelClaudeInstall: async () => {
    set({ claudeError: null });
    try {
      const st = await apiFetch<ClaudeStatus>("/api/claude/cancel", { method: "POST" });
      set({ claude: st });
      return true;
    } catch (e) {
      set({ claudeError: errText(e) });
      return false;
    }
  },

  deleteClaudeVersion: async (version) => {
    set({ claudeError: null });
    try {
      const st = await apiFetch<ClaudeStatus>(`/api/claude/version?version=${encodeURIComponent(version)}`, {
        method: "DELETE",
      });
      set({ claude: st });
      return true;
    } catch (e) {
      set({ claudeError: errText(e) });
      return false;
    }
  },

  setClaudeActive: async (version) => {
    set({ claudeError: null });
    try {
      const st = await apiFetch<ClaudeStatus>("/api/claude/active", {
        method: "POST",
        body: JSON.stringify({ version }),
      });
      set({ claude: st });
      await get().loadClaudeStatus();
      return true;
    } catch (e) {
      set({ claudeError: errText(e) });
      return false;
    }
  },

  setClaudeSource: async (source) => {
    set({ claudeError: null });
    try {
      const st = await apiFetch<ClaudeStatus>("/api/claude/source", {
        method: "POST",
        body: JSON.stringify({ source }),
      });
      set({ claude: st });
      return true;
    } catch (e) {
      set({ claudeError: errText(e) });
      return false;
    }
  },

  refreshSessions: async () => {
    try {
      const r = await apiFetch<{ sessions: SessionInfo[] }>("/api/sessions");
      set({ sessions: r.sessions ?? [] });
    } catch (e) {
      set({ error: errText(e) });
    }
  },

  refreshConversations: async () => {
    // 每次请求带一个单调序号，只认最后一次发出去的结果。
    // 这个函数现在被系统通道、`conversations.changed`、WS 重连一起调用，很容易并发：
    // 先发的那次（比如删除前）晚回来，就会把已经删掉的对话又摆回侧栏。
    const seq = ++conversationsSeq;
    try {
      const r = await apiFetch<{ conversations: ConversationInfo[] }>("/api/conversations");
      if (seq !== conversationsSeq) return;
      set({ conversations: r.conversations ?? [] });
    } catch (e) {
      if (seq !== conversationsSeq) return;
      set({ error: errText(e) });
    }
  },

  refreshWorkspaces: async () => {
    try {
      const r = await apiFetch<WorkspacesPayload>("/api/workspaces");
      set({
        workspaces: r.workspaces ?? [],
        currentWorkspace: r.current ?? "",
        workspaceRoot: r.root ?? get().workspaceRoot,
      });
    } catch (e) {
      set({ error: errText(e) });
    }
  },

  addWorkspace: async (path, open = true) => {
    set({ workspaceBusy: true, error: null });
    try {
      const r = await apiFetch<WorkspacesPayload>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ path }),
      });
      set({
        workspaces: r.workspaces ?? [],
        currentWorkspace: r.current ?? "",
        workspaceRoot: r.root ?? get().workspaceRoot,
      });
      if (open) await get().ensureSession(r.current, false);
      else await get().refreshConversations();
      return true;
    } catch (e) {
      set({ error: errText(e) });
      return false;
    } finally {
      set({ workspaceBusy: false });
    }
  },

  removeWorkspace: async (path) => {
    set({ workspaceBusy: true, error: null });
    const previous = get().currentWorkspace;
    try {
      const r = await apiFetch<WorkspacesPayload>(`/api/workspaces?path=${encodeURIComponent(path)}`, {
        method: "DELETE",
      });
      set({
        workspaces: r.workspaces ?? [],
        currentWorkspace: r.current ?? "",
        workspaceRoot: r.root ?? get().workspaceRoot,
      });
      // 只有移除的正好是当前工作区时才自动拉起下一个；移除别的目录
      // 不应打断用户当前会话。
      if (r.current && r.current !== previous) {
        await get().ensureSession(r.current, false);
      } else if (!r.current && previous) {
        const active = get().activeId;
        if (active) get().disconnect(active);
        get().setActive(null);
        writeActiveId(null);
      }
      return true;
    } catch (e) {
      set({ error: errText(e) });
      return false;
    } finally {
      set({ workspaceBusy: false });
    }
  },

  renameWorkspace: async (path, name) => {
    set({ workspaceBusy: true, error: null });
    try {
      const r = await apiFetch<WorkspacesPayload>("/api/workspaces/rename", {
        method: "POST",
        body: JSON.stringify({ path, name }),
      });
      set({
        workspaces: r.workspaces ?? [],
        currentWorkspace: r.current ?? get().currentWorkspace,
        workspaceRoot: r.root ?? get().workspaceRoot,
      });
      return true;
    } catch (e) {
      set({ error: errText(e) });
      return false;
    } finally {
      set({ workspaceBusy: false });
    }
  },

  startConversationIn: async (path) => {
    const target = path || get().currentWorkspace;
    if (!target) {
      set({ error: "请先添加并选择一个授权目录" });
      return;
    }
    // 先切当前工作区，否则侧栏高亮和会话归属会跟新对话错位。
    if (target !== get().currentWorkspace) {
      set({ workspaceBusy: true, error: null });
      try {
        const r = await apiFetch<WorkspacesPayload>("/api/workspaces/current", {
          method: "POST",
          body: JSON.stringify({ path: target }),
        });
        set({
          workspaces: r.workspaces ?? [],
          currentWorkspace: r.current ?? target,
          workspaceRoot: r.root ?? get().workspaceRoot,
        });
      } catch (e) {
        set({ error: errText(e) });
        return;
      } finally {
        set({ workspaceBusy: false });
      }
    }
    await get().createSession(target);
  },

  openWorkspaceInFiles: async (path) => {
    const r = await openFnosFileManager(path);
    if (r.ok) return;
    set({
      error:
        r.reason === "standalone"
          ? "当前不在飞牛宿主中，无法打开文件管理器"
          : r.reason === "bridge"
            ? "飞牛宿主连接不可用，无法打开文件管理器"
            : `打开目录失败：${r.reason ?? "未知错误"}`,
    });
  },

  probeDir: async (path) => {
    return apiFetch<FsAccess>("/api/fs/access", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  },

  readHostFile: async (path) => {
    return apiFetch<HostFile>("/api/fs/host-file", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  },

  completePaths: async (cwd, query, signal) => {
    const params = new URLSearchParams({ cwd, q: query });
    return apiFetch<FsListing>(`/api/fs/complete?${params.toString()}`, { signal });
  },

  mentionRequest: null,

  requestMention: (path, kind) => {
    mentionRequestSeq += 1;
    set({ mentionRequest: { seq: mentionRequestSeq, path, kind } });
  },

  consumeMentionRequest: () => set({ mentionRequest: null }),

  scrollRequest: null,

  requestScrollToItem: (itemId) => {
    if (!itemId) return;
    scrollRequestSeq += 1;
    set({ scrollRequest: { seq: scrollRequestSeq, itemId } });
  },

  mkdirDir: async (parent, name) => {
    const r = await apiFetch<{ path: string }>("/api/fs/mkdir", {
      method: "POST",
      body: JSON.stringify({ path: parent, name }),
    });
    return r.path;
  },

  browseDirs: async (path, hidden) => {
    const q = new URLSearchParams();
    if (path) q.set("path", path);
    if (hidden) q.set("hidden", "1");
    return apiFetch<FsPickListing>(`/api/fs/list?${q.toString()}`);
  },

  ensureSession: async (cwd, createIfEmpty = true) => {
    const dir = cwd || get().currentWorkspace;
    if (!dir) {
      set({ error: "请先添加并选择一个授权目录" });
      return null;
    }
    let latest = latestConversation(dir, get().conversations);
    if (!latest) {
      // 新添加/切换到的目录可能已有历史对话，但本地列表还没拉过。
      await get().refreshConversations();
      latest = latestConversation(dir, get().conversations);
    }
    if (latest) {
      const ok = await get().openConversation(latest.id);
      if (!ok) return null;
      const id = get().activeId;
      if (!id) return null;
      return get().sessions.find((s) => s.id === id) ?? { id, cwd: latest.cwd, state: "starting" };
    }
    if (!createIfEmpty) {
      // 切到一个还没有对话的工作区：保持空态，由用户点「+」或直接输入消息再创建。
      get().setActive(null);
      writeActiveId(null);
      return null;
    }
    await get().createSession(dir);
    const id = get().activeId;
    if (!id) return null;
    return get().sessions.find((s) => s.id === id) ?? { id, cwd: dir, state: "starting" };
  },

  createSession: async (cwd) => {
    // 连点「新对话」时复用同一个创建任务，避免一次点击起两个 claude。
    if (createTask) {
      const created = await createTask.catch(() => null);
      const dir = cwd || get().currentWorkspace;
      // 等待期间用户可能切了工作区：把旧目录的会话当结果返回，会让界面高亮的
      // 工作区与实际打开的对话对不上。这种情况按新目录再建一次（此时已无人占用）。
      if (created && (!dir || created.cwd === dir)) return;
      return get().createSession(dir);
    }
    const dir = cwd || get().currentWorkspace;
    if (!dir) {
      set({ error: "请先添加并选择一个授权目录" });
      return;
    }
    const previousId = get().activeId;
    const previous = previousId ? get().conversations.find((c) => c.id === previousId) : null;
    // 已经在一个空的新对话里：再点「新对话」不应新建进程，否则会先起一个
    // 新会话、再把旧的空壳关掉，界面会闪一下。
    if (previousId) {
      const live = get().sessions.find((s) => s.id === previousId);
      const cwd = previous?.cwd || live?.cwd || "";
      const empty = (get().items[previousId] ?? []).length === 0 && (!previous || (previous.messages === 0 && !previous.title));
      if (empty && cwd === dir && (previous || live)) return;
    }
    // 用户的意图变成「新建」：正在进行的 open 不能再改 activeId / 建连接。
    openSeq += 1;
    startingCount += 1;
    set({ starting: true, error: null });
    // **先把「新对话页」摆出来**：`POST /api/session` 要 spawn 子进程再等
    // `initialize` 握手（冷启动几秒），这期间如果还停在旧对话上，用户会以为点击
    // 没生效——而旧对话的内容并不是他要的。对话 id 由后端生成，这里先让 activeId
    // 为空：那正是「还没开始的新对话」这个状态，居中布局 + 工作区选择器与 id 到手
    // 之后的空对话完全一样，所以 id 到达时不会有任何重排/闪动。
    // 草稿、`@` 补全的根都跟着变（`draftKeyFor(null, dir)` → 拿到 id 之后由
    // 下面的 `moveDraft` 迁过去），不会把旧对话的草稿串到新对话里。
    if (previousId) get().setActive(null);
    const task = (async (): Promise<SessionInfo | null> => {
      try {
        const info = await apiFetch<SessionInfo>("/api/session", {
          method: "POST",
          body: JSON.stringify({ cwd: dir }),
        });
        await Promise.all([get().refreshSessions(), get().refreshConversations()]);
        // 「新对话页」的草稿是按工作区存的（那时还没有 id）：会话一建好就把它
        // 迁到新 id 下，否则键一换、输入框里的字就被新 id 的空草稿顶掉了。
        moveDraft(draftKeyFor(null, dir), info.id);
        get().setActive(info.id);
        get().connect(info.id);
        // 上一个对话还是空白壳（没发过消息）时顺手结束它，避免点几次「新对话」
        // 就堆出几条空的「新对话」。有内容的对话永远不自动关闭。
        if (
          previousId &&
          previousId !== info.id &&
          previous &&
          previous.messages === 0 &&
          !previous.title &&
          (get().items[previousId] ?? []).length === 0
        ) {
          void get().closeSession(previousId);
        }
        return info;
      } catch (e) {
        // 起不来就回到点「新对话」之前那条：上面已经先把新对话页摆出来了，
        // 留在那儿等于把原来那段对话藏起来（错误条能看见，但对话不见了）。
        // 用户中途自己切走（activeId 已经不是空）时不抢回来。
        if (previousId && get().activeId === null) get().setActive(previousId);
        set({ error: errText(e) });
        return null;
      } finally {
        startingCount = Math.max(0, startingCount - 1);
        if (startingCount === 0) set({ starting: false });
      }
    })();
    createTask = task;
    await task;
    if (createTask === task) createTask = null;
  },

  openConversation: async (id, force = false, onHistory) => {
    const seq = ++openSeq;
    // 新对话还在创建时先等它落定，避免创建完成后的 setActive 覆盖用户新选的对话。
    if (createTask) await createTask.catch(() => null);
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv) {
      set({ error: "对话不存在或已被删除" });
      return false;
    }
    // 已归档的对话不能进入：它已经从当前视图收起了，打开等于把用户刚收起的那条
    // 又拉回来（还会起一个进程）。判断放在这里而不是各个入口，是因为入口不止两个
    // ——侧栏、历史记录页、定时任务页、断线重试都能走到这条路上。
    if (conv.archived) {
      const locale = get().settings?.locale;
      get().showToast(tr(locale, ARCHIVED_NOTICE_ZH, ARCHIVED_NOTICE_EN));
      return false;
    }

    // 对话可能属于另一个授权工作区：先把「当前工作区」切过去。
    const wsPath = workspaceFor(conv.cwd, get().workspaces);
    if (wsPath && wsPath !== get().currentWorkspace) {
      try {
        const r = await apiFetch<WorkspacesPayload>("/api/workspaces/current", {
          method: "POST",
          body: JSON.stringify({ path: wsPath }),
        });
        set({
          workspaces: r.workspaces ?? get().workspaces,
          currentWorkspace: r.current ?? wsPath,
          workspaceRoot: r.root ?? get().workspaceRoot,
        });
      } catch (e) {
        set({ error: errText(e) });
        return false;
      }
    }

    get().setActive(id);
    // 打开 = 一次最近活跃；空的新对话等首条消息再落元数据，避免重启后
    // 出现「有列表项但没有转录、--resume 必然失败」的幽灵对话。
    if (conv.messages > 0 || conv.title || (get().items[id] ?? []).length > 0) {
      void apiFetch("/api/conversations", { method: "PATCH", body: JSON.stringify({ id, touch: true }) })
        .then(() => get().refreshConversations())
        .catch(() => undefined);
    }

    // 「历史已经铺好」只报一次：本地已有 items、转录落定、转录读不到（新对话 / 404）
    // 都算这个时刻——调用方（历史记录页）据此收起自己，剩下的最多是进程还没握手。
    let historyNotified = false;
    const notifyHistory = () => {
      if (historyNotified) return;
      historyNotified = true;
      onHistory?.();
    };

    const loadTranscript = async () => {
      try {
        if ((get().items[id] ?? []).length > 0) return;
        // 全新空对话没有转录文件；直接跳过，避免制造一次预期的 404。
        if (conv.messages === 0 && !conv.title) return;
        try {
          const tr = await apiFetch<TranscriptPayload>(`/api/history/transcript?id=${encodeURIComponent(id)}`);
          if ((get().items[id] ?? []).length > 0) return;
          const next = itemsFromTranscript(tr);
          // 转录里带着 usage（assistant 行），重开对话时据此还原底部统计；
          // 转录算不出的 API 耗时 / 窗口，用上次持久化的快照补。实时快照不覆盖。
          const snap = mergeUsage(conv.usage, usageFromTranscript(tr.lines ?? []));
          if (next.length > 0) {
            set((s) => ({
              items: { ...s.items, [id]: next },
              ...(snap && !s.usage[id] ? { usage: { ...s.usage, [id]: snap } } : {}),
            }));
          }
        } catch {
          // 新对话还没有转录；实时 WS 会补上后续消息。
        }
      } finally {
        notifyHistory();
      }
    };

    if (!force && clients.get(id)?.ready) {
      await loadTranscript();
      get().connect(id);
      return true;
    }

    const pending = resumePromises.get(id);
    if (pending) {
      // 同一条对话正在起：历史由那次负责回放。这里只等**转录落定**就回调，不等
      // 整个握手——否则历史记录页会一直停在列表上等子进程（正是 191d4df 要消除的等待）。
      const history = historyPromises.get(id);
      if (history) await history.catch(() => undefined);
      notifyHistory();
      return pending;
    }
    const promise = (async () => {
      startingCount += 1;
      set({ starting: true, error: null });
      // 转录是磁盘上的 jsonl，跟子进程无关：**与起会话并行**拉，先把历史铺出来，
      // 别让用户盯着「正在启动 Claude…」等 `--resume` 的 initialize 握手（冷启动
      // 要等 spawn + 握手，几秒钟里消息区是空的）。两边都完成才继续——WS 连接、
      // activeId 复位仍然排在后面，实时事件不会插进回放中间。
      const transcript = loadTranscript();
      historyPromises.set(id, transcript);
      try {
        const info = await apiFetch<SessionInfo>("/api/session", {
          method: "POST",
          body: JSON.stringify({ cwd: conv.cwd, resume: id }),
        });
        await Promise.all([get().refreshSessions(), get().refreshConversations(), transcript]);
        // 只有这仍是用户最后一次意图时才改 activeId / 建连接：用户可能已经点了别的
        // 对话、新建了一条、或者把这条归档了。这时再 connect 会留下一条对已归档对话
        // 的重连循环，`recoverSession` 还会按 `--resume` 把进程重新拉起来。
        if (seq === openSeq) {
          get().setActive(info.id);
          get().connect(info.id);
        }
        return true;
      } catch (e) {
        // 会话起不来（claude 未安装 / 版本被删 / 并发冲突返回 409）不等于历史读不到：
        // 转录是磁盘上的 jsonl，跟进程无关。先回放历史再报错——否则用户看到的是
        // 「开始新的对话」，像是整个对话被弄丢了。并行那次已经发出去过（不回放）
        // 就不再补一次请求，等它落定即可。
        await transcript;
        // 迟到的失败不要盖在当前对话上：用户可能已经切到别的对话，
        // 那条红条会显得是「正在看的这条起不来」。
        if (seq === openSeq) set({ error: errText(e) });
        return false;
      } finally {
        resumePromises.delete(id);
        historyPromises.delete(id);
        startingCount = Math.max(0, startingCount - 1);
        if (startingCount === 0) set({ starting: false });
      }
    })();
    resumePromises.set(id, promise);
    return promise;
  },

  renameConversation: async (id, title) => {
    try {
      await apiFetch("/api/conversations", {
        method: "PATCH",
        body: JSON.stringify({ id, title }),
      });
      await get().refreshConversations();
      return true;
    } catch (e) {
      set({ error: errText(e) });
      return false;
    }
  },

  /** 置顶/取消置顶：纯列表偏好，不动进程、不动归档状态。 */
  pinConversation: async (id, pinned) => {
    try {
      await apiFetch("/api/conversations", {
        method: "PATCH",
        body: JSON.stringify({ id, pinned }),
      });
      await get().refreshConversations();
      return true;
    } catch (e) {
      set({ error: errText(e) });
      return false;
    }
  },

  /**
   * 分叉会话（对齐 DSH）：后端用 `--resume 旧 --fork-session --session-id 新` 复制历史，
   * 新 id 由后端生成并落元数据，回来后直接打开新对话。
   *
   * 新会话要「继承」的是上下文，不是权限：fork 是独立进程，会话级授权要重新审批。
   */
  forkConversation: async (id, title) => {
    try {
      const res = await apiFetch<{ id?: string }>("/api/conversations/fork", {
        method: "POST",
        body: JSON.stringify({ id, title }),
      });
      await get().refreshConversations();
      // 没有新 id 等于分叉没成（正常情况下后端一定给）：别让调用方以为开了一条新对话。
      if (!res?.id) {
        set({ error: "分叉失败：后端没有返回新会话 id" });
        return false;
      }
      // 用 openConversation 的结果：它可能因为 cwd 未授权 / 会话起不来而失败，
      // 那时它自己已经写了 error，这里再返回 true 就和界面不一致了。
      return await get().openConversation(res.id);
    } catch (e) {
      set({ error: errText(e) });
      return false;
    }
  },

  archiveConversation: async (id, archived) => {
    // **乐观更新**：先把这一行改掉（「隐藏已归档」的筛选、行上的归档态跟着立刻变），
    // 请求发出去之后不等回包——回包后面那次 `refreshConversations()` 会把
    // `~/.claude/projects` 下每一份转录重扫一遍（NAS 上可到秒级），等它等于让一次
    // 勾选动作卡住一屏。失败再把这一行改回来。
    const target = get().conversations.find((c) => c.id === id);
    const wasArchived = target?.archived ?? !archived;
    const wasLive = target?.live ?? false;
    const wasActive = get().activeId === id;
    // 作废在途的列表刷新：归档请求发出前发出、之后才回来的那一份会把
    // `archived:false` 又写回来（「隐藏已归档」下那一行重新冒出来）。
    conversationsSeq += 1;
    set((s) => ({
      // 归档时后端会顺手结束进程：`live` 一起改掉，否则「显示已归档」的行仍按
      // conversationStatus 画「进行中」绿点，一直到后台那次刷新回来。
      conversations: s.conversations.map((c) => (c.id === id ? { ...c, archived, ...(archived ? { live: false } : {}) } : c)),
    }));
    // 归档当前对话后回「新对话」页，不替用户挑下一条打开：那个「下一条」是按最近活跃
    // 猜的，用户归档完想停下时却会被拉进另一个对话、又起一个 claude 进程。
    // 同时作废在途的 open：慢 `--resume` 回来时会把这条刚归档的对话又设成 active
    // 并 `connect` 上去（`recoverSession` 据此把进程重新拉起来）。
    if (archived && wasActive) {
      openSeq += 1;
      get().setActive(null);
    }
    try {
      await apiFetch("/api/conversations", {
        method: "PATCH",
        body: JSON.stringify({ id, archived }),
      });
      // 归档时后端顺手结束了进程，本机这条连接跟着断。
      get().disconnect(id);
      // 列表重建（live/state、最近活跃）放到后台：它只是对齐状态，不挡这一刻的交互。
      void get().refreshConversations();
      return true;
    } catch (e) {
      conversationsSeq += 1; // 回滚同样要压住在途的那份列表
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === id ? { ...c, archived: wasArchived, live: wasLive } : c)),
      }));
      // 归档失败时把用户放回原来那条对话（只在没人抢先切走时）：让他停在一个
      // 空的「新对话」页上、原来那段对话不见了，比报个错更让人困惑。
      if (archived && wasActive && get().activeId === null) get().setActive(id);
      set({ error: errText(e) });
      return false;
    }
  },

  deleteConversation: async (id) => {
    const conv = get().conversations.find((c) => c.id === id);
    try {
      await apiFetch(`/api/conversations?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      get().disconnect(id);
      // 对话没了，草稿也别留在 localStorage 里（它按会话 id 存）。
      dropDraft(id);
      set((s) => {
        const buckets = {
          items: { ...s.items },
          subagentItems: { ...s.subagentItems },
          subagentTokens: { ...s.subagentTokens },
          perms: { ...s.perms },
          states: { ...s.states },
          inits: { ...s.inits },
          conns: { ...s.conns },
          usage: { ...s.usage },
          doneIds: { ...s.doneIds },
          modes: { ...s.modes },
          queued: { ...s.queued },
          liveTasks: { ...s.liveTasks },
        };
        purgeSession(buckets, id);
        return buckets;
      });
      await get().refreshConversations();
      if (get().activeId === id) {
        openSeq += 1; // 同归档：作废在途的 open
        const root = conv ? workspaceFor(conv.cwd, get().workspaces) || conv.cwd : get().currentWorkspace;
        const next = get()
          .conversations.filter((c) => c.id !== id && !c.archived && belongs(c.cwd, root))
          .sort((a, b) => timeValue(b.last_active) - timeValue(a.last_active))[0];
        if (next) await get().openConversation(next.id);
        else {
          get().setActive(null);
          writeActiveId(null);
        }
      }
      return true;
    } catch (e) {
      set({ error: errText(e) });
      return false;
    }
  },

  closeSession: async (id) => {
    try {
      await apiFetch(`/api/session?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (e) {
      set({ error: errText(e) });
    }
    get().disconnect(id);
    // 进程已经结束：审批、状态、用量快照都作废；消息历史保留（下次打开会重新回放）。
    dropAskDrafts(get().perms[id]);
    set((s) => ({
      perms: { ...s.perms, [id]: [] },
      states: { ...s.states, [id]: "closed" },
      conns: { ...s.conns, [id]: { state: "closed" } },
    }));
    await Promise.all([get().refreshSessions(), get().refreshConversations()]);
  },

  // 切档位之后让它在**当前**会话生效：claude 的控制协议里没有 set_effort，
  // `--effort` 只在进程启动时固定，所以按同一 id 关掉进程再 --resume 拉起来
  // （上下文在转录里，对话 id 不变）。进行中不杀进程，等这一轮 result 再重开。
  applyEffortChange: async (id, effort) => {
    const sess = get().sessions.find((s) => s.id === id);
    if (!sess) return;
    const state = get().states[id] ?? sess.state;
    const plan = effortApply(state, sess.effort, effort);
    if (plan === "none") {
      effortRestarts.delete(id);
      return;
    }
    if (plan === "afterTurn") {
      effortRestarts.add(id);
      return;
    }
    effortRestarts.delete(id);
    await get().restartSession(id);
  },

  restartSession: async (id) => {
    const sess = get().sessions.find((s) => s.id === id);
    const conv = get().conversations.find((c) => c.id === id);
    const cwd = sess?.cwd || conv?.cwd;
    if (!cwd) return false;
    // 还没发过消息的对话没有转录，`--resume` 会找不到会话：关掉后按新设置新建一个
    // （它本来就没有上下文可丢）。这里不走 createSession：它的「已经在空对话里就
    // 不新建」守卫是给「新对话」按钮用的，正好会把这次重开挡掉。
    if (isNewChat(conv, (get().items[id] ?? []).length)) {
      get().disconnect(id);
      try {
        await apiFetch(`/api/session?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        const info = await apiFetch<SessionInfo>("/api/session", {
          method: "POST",
          body: JSON.stringify({ cwd }),
        });
        await Promise.all([get().refreshSessions(), get().refreshConversations()]);
        // 换 id 但对话还是同一条（本来就没有上下文）：输入框里的草稿跟着过去。
        moveDraft(id, info.id);
        // 只有本来就是当前对话才把界面切到新 id：侧栏的「重启进程」也能对**后台**的
        // 空对话下手，那时用户还在看别的对话，不该被顶到一条新的空对话上。
        if (get().activeId === id) {
          get().setActive(info.id);
          get().connect(info.id);
        }
        return true;
      } catch (e) {
        set({ error: errText(e) });
        return false;
      }
    }
    // 先断开自己的 WS：重开前旧进程会广播 closed，收下它等于把界面标成已结束。
    // 同时把连接标成 connecting：重开期间发送按钮必须禁用，否则消息会写进旧管道。
    get().disconnect(id);
    set((s) => ({ conns: { ...s.conns, [id]: { state: "connecting" } }, states: { ...s.states, [id]: "starting" } }));
    try {
      await apiFetch(`/api/session?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const info = await apiFetch<SessionInfo>("/api/session", {
        method: "POST",
        body: JSON.stringify({ cwd, resume: id }),
      });
      await get().refreshSessions();
      get().connect(info.id);
      return true;
    } catch (e) {
      set({ error: errText(e) });
      return false;
    }
  },

  setActive: (id) => {
    set((s) => {
      if (!id || !s.doneIds[id]) return { activeId: id };
      const next = { ...s.doneIds };
      delete next[id];
      return { activeId: id, doneIds: next };
    });
    writeActiveId(id);
  },

  connect: (id) => {
    if (clients.has(id)) return;
    set((s) => ({ conns: { ...s.conns, [id]: { state: "connecting" } } }));
    const client = new ClaudeClient(id, token(), {
      onEvent: (ev) => get().applyEvent(id, ev),
      onStatus: (status, detail) => {
        set((s) => ({ conns: { ...s.conns, [id]: { state: status, ...detail } } }));
        if (status === "open") {
          // 重连后服务端可能已经重启并换了会话 id：核对一次。
          //
          // 断线期间漏掉的事件不在这里补：要等 session.snapshot 给出「会话对象身份 +
          // 当前序号」之后才知道能不能补（见 applyEvent 的 session.snapshot 分支）。
          // 提前按本地水位发 sync 会有两个问题：新页面第一次连上时水位是空的，
          // 补回来的事件会和刚回放的转录叠成两份。
          void get()
            .refreshSessions()
            .then(() => {
              if (!get().sessions.some((s) => s.id === id)) {
                void recoverSession(id, get);
              }
            })
            .catch(() => {
              /* refreshSessions 已把错误放进 state */
            });
        }
        if (status === "reconnecting") {
          // 第一次重连就核对会话是否还在：服务端重启后旧 id 已不存在，
          // 早一点发现就能早一点 ensure 新会话，而不是等退避到 10s。
          void recoverSession(id, get);
        }
      },
    });
    clients.set(id, client);
    client.connect();
  },

  disconnect: (id) => {
    clients.get(id)?.close();
    clients.delete(id);
  },

  retryConnection: (id) => {
    const client = clients.get(id);
    if (client) {
      client.retryNow();
      return;
    }
    // 进程已被回收/关闭时没有 client，直接按对话 id 重新 resume。
    if (get().conversations.some((c) => c.id === id)) void get().openConversation(id, true);
  },

  // 返回「这条消息是否真的发出去了」：输入框据此决定要不要清空草稿。
  // 之前是 void，发送失败（WS 重连中）也照样清空，用户的提示词与附件就没了。
  sendPrompt: async (text, attachments = [], attachmentLabel = "附件：", opts) => {
    if (!text.trim() && attachments.length === 0) return false;
    // 刚点「新对话」时 active 还没切过去：等创建完成，避免把消息发给上一个对话。
    if (createTask) {
      const created = await createTask.catch(() => null);
      if (!created) return false;
    }
    let id = get().activeId;
    if (!id) {
      const info = await get().ensureSession();
      id = info?.id ?? null;
    }
    if (!id) return false;
    if (!clients.get(id)) {
      // 进程被空闲回收后 active 仍在：发送前先按对话 id 恢复。
      const ok = await get().openConversation(id, true);
      if (!ok) return false;
    }
    if (!clients.get(id)?.ready) {
      // 刚 resume / 新建的会话，HTTP 已经返回但 WS 还在握手；等它真正 open 再发。
      const ok = await waitForOpen(id);
      if (!ok) {
        set({ error: "连接尚未就绪，正在自动重连；稍后再发送即可" });
        return false;
      }
    }
    const client = clients.get(id);
    const frame = {
      kind: "prompt" as const,
      text,
      attachments: attachments.length > 0 ? attachments : undefined,
      priority: opts?.priority,
    };
    if (!client?.send(frame)) {
      set({ error: "发送失败：连接已断开" });
      return false;
    }
    // 图片进气泡本体（可点开预览），其余附件仍以「附件：名字」的正文出现。
    const bubble = userBubblePayload(text, attachments, attachmentLabel);
    const now = new Date().toISOString();
    // `priority=now` 是插话：它并入当前回合，**不切轮**（切了会把这一轮的思考与工具
    // 劈成两半，前半截被当成「已完成」收起来）。
    const interjected = opts?.priority === "now";
    notePrompt(id);
    set((s) => ({
      items: { ...s.items, [id!]: appendUser(s.items[id!] ?? [], bubble.text, bubble.images, interjected) },
      conversations: s.conversations.map((c) => (c.id === id ? { ...c, last_active: now } : c)),
    }));
    window.setTimeout(() => void get().refreshConversations(), 600);
    return true;
  },

  enqueuePrompt: (text, attachments = [], attachmentLabel = "附件：") => {
    const id = get().activeId;
    if (!id) return false;
    const next = pushQueued(get().queued[id] ?? [], text, attachments, attachmentLabel);
    if (!next) {
      set({ error: `待发送最多 ${MAX_QUEUED} 条，先发掉或删掉一条` });
      return false;
    }
    set((s) => ({ queued: { ...s.queued, [id]: next } }));
    // 空闲时 Enter 本来就是「发送」：入队后立刻发队首，语义与原来一致。
    // 回合进行中 flushQueued 会自己按掉，留给回合结束事件触发。
    if ((get().states[id] ?? "") !== "busy") void get().flushQueued(id);
    return true;
  },

  dropQueued: (qid) => {
    const id = get().activeId;
    if (!id) return;
    set((s) => ({ queued: { ...s.queued, [id]: removePrompt(s.queued[id] ?? [], qid) } }));
  },

  editQueued: (qid, text, attachments) => {
    const id = get().activeId;
    if (!id) return;
    set((s) => ({ queued: { ...s.queued, [id]: updatePrompt(s.queued[id] ?? [], qid, text, attachments) } }));
  },

  setEditingQueued: (qid) => {
    editingQueuedId = qid;
    if (qid) return;
    // 编辑结束：把刚才因为编辑而跳过的那一次自动发送补上。
    const sid = get().activeId;
    if (sid && flushPending.delete(sid)) void get().flushQueued(sid);
  },

  steerQueued: async (qid) => {
    const id = get().activeId;
    if (!id) return false;
    const item = (get().queued[id] ?? []).find((q) => q.id === qid);
    if (!item) return false;
    // 先摘出队列再发：发送期间又点一次「立即插话」不该把同一条发两遍。
    set((s) => ({ queued: { ...s.queued, [id]: removePrompt(s.queued[id] ?? [], qid) } }));
    // priority=now：这是「插话」，不是「排队」——要不要让它进本轮是 CLI 的裁决，
    // 但我们必须把意图标出来，否则它只能按默认的 next 等本轮收尾（看起来像没生效）。
    const ok = await get().sendPrompt(item.text, item.attachments, item.label, { priority: "now" });
    if (!ok) set((s) => ({ queued: { ...s.queued, [id]: [item, ...(s.queued[id] ?? [])] } }));
    return ok;
  },

  flushQueued: async (sid) => {
    if (!sid || flushing.has(sid)) return false;
    // 队列跟着对话走：用户切到别的对话时不替他发，切回来再说（面板上仍然可以手动发）。
    if (get().activeId !== sid) return false;
    const state = get().states[sid] ?? "";
    if (state === "busy" || state === "starting") return false;
    const head = headPrompt(get().queued[sid] ?? []);
    if (!head) return false;
    // 队首正在被编辑：先按住，等编辑结束再发，别把改到一半的旧文本发出去。
    if (head.id === editingQueuedId) {
      flushPending.add(sid);
      return false;
    }
    flushing.add(sid);
    set((s) => ({ queued: { ...s.queued, [sid]: removePrompt(s.queued[sid] ?? [], head.id) } }));
    try {
      const ok = await get().sendPrompt(head.text, head.attachments, head.label);
      // 发失败（连接断开等）：放回队首，消息不能凭空消失。
      if (!ok) set((s) => ({ queued: { ...s.queued, [sid]: [head, ...(s.queued[sid] ?? [])] } }));
      return ok;
    } finally {
      flushing.delete(sid);
    }
  },

  interrupt: () => {
    const id = get().activeId;
    if (!id) return;
    clients.get(id)?.send({ kind: "interrupt" });
    // 中断之后这轮的审批请求就作废了：不清掉的话卡片会一直挂在输入框上方，
    // 点「允许」只会把一条 request_id 早已失效的 control_response 写进 CLI。
    dropAskDrafts(get().perms[id]);
    set((s) => ({ perms: { ...s.perms, [id]: [] } }));
  },

  setPermissionMode: (mode) => {
    if (!mode) return;
    const id = get().activeId;
    const client = id ? clients.get(id) : undefined;
    if (id && client) {
      // 先乐观更新：控制请求的回包在几百毫秒内就到，CLI 的 system/status 会再校正一次。
      set((s) => ({ modes: { ...s.modes, [id]: mode } }));
      client.send({ kind: "permission_mode", mode });
      return;
    }
    // 还没有活着的进程（新对话 / 会话已结束 / 正在启动）：写进「默认权限」，
    // 下一次建会话时按它启动。不这么做的话，在新对话里选模式等于什么都没发生。
    void get().saveSettings({ permission_mode: mode });
  },

  showSubagent: (agentId, label) => {
    if (!agentId) return;
    // 序号走模块级计数器：请求被消费后 subagentView 会置空，从 0 重新数的话
    // 同一个子代理点第二次会拿到和上次相同的 nonce，被右侧栏当成重复请求丢掉。
    subagentViewSeq += 1;
    set({ subagentView: { agentId, label: label || "subagent", nonce: subagentViewSeq } });
  },

  clearSubagentView: () => set({ subagentView: null }),

  stopTask: async (taskId) => {
    const id = get().activeId;
    if (!id || !taskId) return;
    try {
      await apiFetch("/api/session/task", {
        method: "POST",
        body: JSON.stringify({ id, action: "stop", task_id: taskId }),
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "停止任务失败" });
    }
  },

  replyPermission: (req, allow, updatedInput, updatedPermissions, message) => {
    const id = get().activeId;
    if (!id) return;
    const sent = clients.get(id)?.send({
      kind: "permission",
      request_id: req.request_id,
      allow,
      updated_input: updatedInput,
      updated_permissions: updatedPermissions,
      message,
    });
    if (!sent) {
      // 连接已经断了（自动重连中）：帧根本没发出去。保留卡片，否则用户以为批准了，
      // 而 CLI 仍挂在 can_use_tool 上，界面上再也点不到。
      set({ error: "连接已断开，正在自动重连；稍后再批准一次" });
      return;
    }
    clearAskProgress(req.request_id);
    set((s) => ({
      perms: { ...s.perms, [id]: (s.perms[id] ?? []).filter((p) => p.request_id !== req.request_id) },
    }));
  },

  applyEvent: (sid, ev) => {
    // 对齐窗口里到达的实时事件先压着：它可能比正在补发的那一段还晚，先落地就会
    // 让消息流顺序颠倒（result 抢在它对应的正文前面）。补发帧到达后一并按序号应用。
    // 补发帧 / resync 自己不受这条限制（它们是这个窗口的收尾者）。
    if (
      sid &&
      awaitingReplay.has(sid) &&
      ev.kind !== "session.replay" &&
      ev.kind !== "session.resync" &&
      typeof ev.seq === "number"
    ) {
      const buffered = pendingLive.get(sid) ?? [];
      buffered.push(ev);
      pendingLive.set(sid, buffered);
      return;
    }
    // 序号是**会话内**单调的：先记水位（下次重连补这之后的部分），再按序号去重
    // （同一条事件可能既在补发帧里、又在实时广播里）。网关自己发的事件
    // （pong / 本地回错）没有 seq，直接放行。
    if (sid && typeof ev.seq === "number") {
      if (!markApplied(sid, ev.seq)) return;
      const prev = eventSeq.get(sid) ?? 0;
      if (ev.seq > prev) eventSeq.set(sid, ev.seq);
    }
    // 任何一条会话帧都算「上游出声了」：正文 / 思考 / 工具 / 结果 / 审批 / 状态流转
    // 都说明这条链路是活的。放在去重之后、switch 之前，是因为下面每个分支都会
    // `return`，而这一条对所有分支都成立。
    // 后端已经把 `keep_alive` 单独丢掉了（AGENTS 4.2.3），到这里就说明确实有内容。
    if (sid) noteFrame(sid);
    switch (ev.kind) {
      case "claude.update": {
        // 系统通道推来的「有新版」信号。推送只带版本号，完整状态照旧走
        // /api/claude/status（已安装列表、生效版本、安装进度都在那里），
        // 免得两处各维护一份解析。
        void get().loadClaudeStatus();
        return;
      }
      case "conversations.changed": {
        // 定时任务在后台新建/改动了对话：拉一次列表，别让侧栏停在旧状态。
        void get().refreshConversations();
        return;
      }
      case "git.changed": {
        // 后端盯着的仓库变了（agent 改了源码、终端里 commit/pull 都在内）。
        // 状态/分支/历史由右侧栏 store 自己刷新，这里只转达 cwd 供它比对。
        const data = ev.data as { cwd?: string } | undefined;
        notifyGitChanged(data?.cwd ?? "");
        return;
      }
      case "session.snapshot": {
        const data = ev.data as
          | {
              init?: InitPayload;
              info?: { state?: string; mode?: string };
              permissions?: PermissionPayload[];
              tasks?: LiveTask[];
              // 「CLI 在自己进程里干活」的状态（压缩中 / hook 在跑）。压缩途中刷新页面
              // 拿不到那条 `status: compacting`（只发一次、不进转录），靠它补上。
              // hook 的每一项是 `{id, name}`：id 只用来配对结束，显示的是 name。
              busy?: { compacting?: boolean; hooks?: { id?: string; name?: string }[] };
              seq?: number;
              epoch?: string;
            }
          | undefined;
        // 快照是**这一刻**的权威状态，与上面那张后台任务表同一条规矩：`busy` 缺席
        // 也按「没有本地活」处理——本地那份是过程态（压缩中的心跳、hook 的起止），
        // 跨连接之后本来就该以后端为准，留着旧值只会让「正在压缩」永远挂着。
        localWorkAt.set(sid, {
          compacting: data?.busy?.compacting === true,
          // 快照里没有这个数（后端不记它，它只是「摘要正在写」的进度提示），
          // 刷新之后从 0 重新开始，下一次 `status: compacting` 会补上真实的数。
          compactChars: 0,
          hooks: Array.isArray(data?.busy?.hooks)
            ? data!.busy!.hooks!
                .filter((h) => h && typeof h.id === "string" && h.id !== "")
                .map((h) => ({ id: h.id!, name: typeof h.name === "string" && h.name !== "" ? h.name : h.id! }))
            : [],
        });
        if (data?.init) set((s) => ({ inits: { ...s.inits, [sid]: data.init! } }));
        // info.mode 是会话**此刻**的模式（后端记录 CLI 最近一次上报的值）；
        // init 里那份只是启动时的快照，重连后不能拿它顶替。
        const mode = data?.info?.mode || data?.init?.current_permission_mode;
        if (mode) set((s) => ({ modes: { ...s.modes, [sid]: mode } }));
        // 后端会把「还没决定」的审批一起发过来：重连/刷新后必须能继续点，
        // 否则 CLI 一直挂着等回包，而界面上找不到入口。
        if (data?.permissions) {
          const pending = data.permissions.filter((p) => p?.request_id);
          set((s) => ({ perms: { ...s.perms, [sid]: pending } }));
        }
        // 还没结束的后台任务：补 task_id（只在实时 task_started 里出现，转录回放没有）。
        // 空数组也要覆盖——那条路径代表「确实一个都没在跑」，留着旧值会让中止入口
        // 指向早就不存在的任务。
        set((s) => ({ liveTasks: { ...s.liveTasks, [sid]: data?.tasks ?? [] } }));
        if (data?.info?.state) {
          const state = data.info.state;
          set((s) => ({
            states: { ...s.states, [sid]: state },
            conversations: s.conversations.map((c) => (c.id === sid ? { ...c, live: true, state } : c)),
          }));
        }
        syncMissedEvents(sid, data?.epoch, data?.seq);
        return;
      }
      case "session.replay": {
        // 断线期间漏掉的事件：按原顺序逐条喂回同一条 apply 路径（补发的那几条里可能
        // 就有本轮结束的 result，它的 duration/usage 只能从这条路径落到 items 上）。
        // 逐条的 seq 去重在 applyEvent 头部，与这段时间里已经抢到的实时广播重叠时跳过。
        endSyncWindow(sid);
        const data = ev.data as { events?: { kind?: string; seq?: number; data?: unknown }[] } | undefined;
        for (const e of data?.events ?? []) {
          if (!e?.kind) continue;
          get().applyEvent(sid, { kind: e.kind, data: e.data, seq: e.seq });
        }
        // 补发段之后的实时事件（窗口期间压住的那些）再接上。
        flushLive(sid);
        return;
      }
      case "session.resync": {
        // 补不齐了（缓冲淘汰 / 进程重开过）：本地那份消息流中间有缺口，只能整份重放
        // 转录。水位对齐到后端当前序号——不对齐的话下次重连还拿同一个过时的 since
        // 去问，又被判为补不齐，来回 resync。
        //
        // `epoch` 变了（后端换过会话对象）时去重集合也要清：新进程的序号从 1 重新
        // 开始，旧集合里的 1..N 会把它们全判成重复。缓冲里压着的实时事件同属旧序号
        // 空间，一并丢掉——它们要么会从转录里回来，要么本来就对不上。
        endSyncWindow(sid);
        // 窗口里压着的实时事件直接丢掉：它们的内容已经在刚重放的转录里（转录是磁盘上
        // 的权威版本，断线期间产生的都写了进去），再应用一遍就是同一段正文出现两三遍。
        // 不丢的话它们还会留在 `pendingLive` 里，等下一次补发帧到达时一起被冲出去。
        pendingLive.delete(sid);
        const data = ev.data as { seq?: number; epoch?: string } | undefined;
        if (typeof data?.seq === "number") {
          if (data.epoch && data.epoch !== eventEpoch.get(sid)) {
            resetSyncWatermark(sid, data.seq, data.epoch);
          } else {
            eventSeq.set(sid, data.seq);
          }
        }
        if (data?.epoch) eventEpoch.set(sid, data.epoch);
        // **不 flushLive**：窗口里压着的那些实时事件，内容已经在刚重放的转录里了
        // （转录是磁盘上的权威版本，断线期间产生的都写了进去）。再应用一遍就是同一段
        // 正文出现两三遍。缓冲本身也在上面 `endSyncWindow` 之后被丢弃了——
        // 它们属于「补不齐」的那段序号空间，留着只会叠。
        void replayTranscript(sid, get);
        return;
      }
      case "session.replaced": {
        // CLI 换了会话 id（`/clear` 之后它会新开一份转录）。后端已经把
        // conversations.json 的记录迁过去了，这里把本机状态跟着换。
        //
        // **哪些搬、哪些不搬是分开判断的**，因为 /clear 的语义是「上下文从头开始」：
        //   - 搬：状态机、init（命令/模型）、权限模式、待发送队列、后台任务、未读标记。
        //     它们描述的是**同一个正在跑的进程**，与上下文无关。
        //   - 不搬：消息流、子代理消息、用量快照。它们描述的是**被清掉的那段对话**；
        //     搬过去的话，界面上新会话会显示「清空前的历史 + 满格的上下文占用」，
        //     而 claude 那边的上下文是空的——两边对不上，这正是 /clear 要避免的。
        //     旧转录仍在磁盘上（历史记录里还能翻到），不丢任何东西。
        //   - 丢：挂起的审批。旧会话的挂起表在 clear 之后已经作废。
        const data = ev.data as { from?: string; to?: string } | undefined;
        const to = data?.to;
        if (!to || to === sid) return;
        const old = sid;
        // 浏览器里存的那份 active id 也要跟着换：不换的话刷新页面会按旧 id 恢复，
        // 后端那边对话已经在新 id 上，界面就落回一条「用户以为已经清空」的旧转录。
        if (readActiveId() === old) writeActiveId(to);
        // 旧 id 的连接必须断开：它订阅的是旧 topic，继续留着只会在恢复时
        // 又去 resume 一份用户已经清空的转录。
        clients.get(old)?.close();
        clients.delete(old);
        // 沉默计时按旧 id 记的那条也要清：不清的话每 /clear 一次就留一条永远不用的
        // 记录（这张表只在 purgeSession 里删），而且新 id 第一次等待会去读它。
        forgetSilence(old);
        set((s) => ({
          states: moveKey(s.states, old, to),
          inits: moveKey(s.inits, old, to),
          modes: moveKey(s.modes, old, to),
          queued: moveKey(s.queued, old, to),
          liveTasks: moveKey(s.liveTasks, old, to),
          doneIds: moveKey(s.doneIds, old, to),
          perms: { ...s.perms, [old]: [] },
          // 新会话从空的消息流与空的上下文占用开始（见上面那段取舍）。
          // 旧桶直接丢掉：它描述的是被清掉的那段对话，留着只会在切回旧 id
          // （比如从历史记录点进来）时把清空前的消息重新铺出来。真正的历史
          // 在旧转录里，重新打开时由 `/api/history/transcript` 回放。
          items: { ...dropKey(s.items, old), [to]: [] },
          usage: dropKey(s.usage, old),
          subagentItems: dropKey(s.subagentItems, old),
          subagentTokens: dropKey(s.subagentTokens, old),
          activeId: s.activeId === old ? to : s.activeId,
          sessions: s.sessions.map((x) => (x.id === old ? { ...x, id: to } : x)),
        }));
        // 新 id 要连上自己的 WS 才能收后续事件。
        void get().connect(to);
        // 侧栏列表里那条对话的 id 已经变了，重拉一次拿到新 id 与标题。
        void get().refreshConversations();
        return;
      }
      case "session.ready": {
        const data = ev.data as { init?: InitPayload } | undefined;
        if (data?.init) {
          const mode = data.init.current_permission_mode;
          set((s) => ({
            inits: { ...s.inits, [sid]: data.init! },
            ...(mode ? { modes: { ...s.modes, [sid]: mode } } : {}),
          }));
        }
        set((s) => ({
          states: { ...s.states, [sid]: "ready" },
          conversations: s.conversations.map((c) => (c.id === sid ? { ...c, live: true, state: "ready" } : c)),
        }));
        return;
      }
      case "session.title": {
        // 别处改了会话名（终端 /rename、IDE 插件、--name）：后端已经把名字并进
        // conversations.json，这里只把本机列表与页头对齐，别等下一次全量刷新——
        // 用户很可能正看着这条对话。
        //
        // 不整份重拉列表：改名只改一行，`GET /api/conversations` 要重扫全部转录。
        const data = ev.data as { title?: string; session_id?: string } | undefined;
        const title = data?.title?.trim();
        if (!title) return;
        const target = data?.session_id || sid;
        set((s) => ({
          conversations: s.conversations.map((c) => (c.id === target ? { ...c, title } : c)),
        }));
        return;
      }
      case "session.state": {
        // 同一个事件既承载状态机流转，也承载 CLI 报上来的权限模式（system/status）。
        const data = ev.data as { state?: string; mode?: string } | undefined;
        if (data?.mode) set((s) => ({ modes: { ...s.modes, [sid]: data.mode! } }));
        if (data?.state) {
          const state = data.state;
          set((s) => ({
            states: { ...s.states, [sid]: state },
            conversations: s.conversations.map((c) => (c.id === sid ? { ...c, live: state !== "closed", state } : c)),
          }));
        }
        return;
      }
      case "permission": {
        const p = ev.data as PermissionPayload | undefined;
        if (p?.request_id) {
          // 按 request_id 去重：重连快照与实时事件可能把同一条审批送两遍。
          set((s) => ({
            perms: {
              ...s.perms,
              [sid]: [...(s.perms[sid] ?? []).filter((x) => x.request_id !== p.request_id), p],
            },
          }));
        }
        return;
      }
      case "permission.resolved": {
        // 这条审批已经有结论了（很可能是别的设备/标签做掉的）。审批是会话级状态，
        // 后端在回包之后会广播一次；不处理的话本机卡片会一直挂着、一轮里越攒越多。
        const data = ev.data as { request_id?: string } | undefined;
        const rid = data?.request_id;
        if (!rid) return;
        clearAskProgress(rid);
        set((s) => ({
          perms: { ...s.perms, [sid]: (s.perms[sid] ?? []).filter((p) => p.request_id !== rid) },
        }));
        return;
      }
      case "error": {
        const data = ev.data as { message?: string } | undefined;
        set((s) => ({
          items: { ...s.items, [sid]: appendError(s.items[sid] ?? [], data?.message ?? "未知错误") },
        }));
        return;
      }
      case "prompt.echo": {
        // 别的设备/标签发出的提示词：CLI 不回显 stdin，本机又没做这次乐观插入，
        // 不补这条气泡的话界面上就只剩模型突然开始思考。
        const data = ev.data as
          | {
              text?: string;
              files?: string[];
              images?: { name: string; media_type: string; data: string }[];
              interjected?: boolean;
            }
          | undefined;
        if (!data) return;
        const echo = {
          text: data.text,
          files: data.files,
          // 插话标记要跟着走：少了它这条会被当成新的一轮，把发送方那一轮的思考劈成两半。
          interjected: data.interjected,
          images: (data.images ?? []).map((img) => ({
            name: img.name,
            mediaType: img.media_type,
            data: img.data,
          })),
        };
        set((s) => ({
          items: { ...s.items, [sid]: appendPromptEcho(s.items[sid] ?? [], echo, s.settings?.locale === "en" ? "File: " : "附件：") },
        }));
        return;
      }
      case "closed": {
        dropAskDrafts(get().perms[sid]);
        // 进程没了，「本地在干什么」的旧状态必须一起清掉：压缩中被杀 / hook 挂着被杀时
        // 不清的话，重连之后界面会一直以为还在压缩，沉默提示也跟着永久失效。
        localWorkAt.delete(sid);
        set((s) => {
          const cur = s.items[sid];
          return {
            // 进程没了，这一轮不会再有 result：悬着的流式气泡必须收尾，
            // 否则界面会一直显示「还在写」的光标。
            ...(cur ? { items: { ...s.items, [sid]: settleStreaming(cur) } } : {}),
            states: { ...s.states, [sid]: "closed" },
            conns: { ...s.conns, [sid]: { state: "closed" } },
            // 进程已退出，挂起的审批永远不可能被批准：留着只会让人点到一条失效回包。
            perms: { ...s.perms, [sid]: [] },
            // 这一轮不会再有 result：本回合的生成合计作废，别带进下一轮
            // （否则「本回合速度」会把上一轮那半截也算进去）。
            ...(s.usage[sid] ? { usage: { ...s.usage, [sid]: settleTurnUsage(s.usage[sid])! } } : {}),
            conversations: s.conversations.map((c) => (c.id === sid ? { ...c, live: false, state: "closed" } : c)),
          };
        });
        // 会话进程已退出，WS 再留着只会让界面显示「已连接」却发不出消息。
        clients.get(sid)?.close();
        clients.delete(sid);
        return;
      }
      case "cli": {
        // 子代理内部的帧（parent_tool_use_id 非空）单独归桶：它们既不能进主消息流，
        // 也不能污染主会话的用量统计。
        const sub = subagentFrame(ev.data);
        if (sub) {
          // **子代理的帧不改写「本地在干活」的状态**：`localWorkFrom` 把 `assistant`
          // 当成「上游出声了，压缩早已结束」，而子代理的正文恰恰也是 assistant 帧。
          // 压缩发生在主链上，子代理跑着的时候主会话仍在压缩——按子代理的帧清掉，
          // 计时行就会在压缩途中退回「上游 Ns 没有响应」。
          const tokens = messageTokens(ev.data);
          set((s) => {
            const byAgent = s.subagentItems[sid] ?? {};
            const prev = byAgent[sub.agentId] ?? [];
            return {
              subagentItems: {
                ...s.subagentItems,
                [sid]: { ...byAgent, [sub.agentId]: applyCLI(prev, ev.data) },
              },
              // 同一条帧顺手记实时用量：子代理的进度事件要等它调用过工具才来，
              // 只靠它的话列表上的 token 会一直空到任务结束。
              ...(tokens !== undefined
                ? {
                    subagentTokens: {
                      ...s.subagentTokens,
                      [sid]: { ...(s.subagentTokens[sid] ?? {}), [sub.agentId]: tokens },
                    },
                  }
                : {}),
            };
          });
          return;
        }
        // 「CLI 在自己干活」的状态要跟着每条帧更新（压缩中 / hook 在跑），
        // 它决定 TurnTimer 要不要说「上游 Ns 没有响应」——压缩与 hook 压根不等上游。
        // 必须放在子代理分流**之后**（见上一条：子代理的 assistant 帧会误清压缩态）。
        const work = localWorkFrom(localWork(sid), ev.data);
        if (work !== localWork(sid)) localWorkAt.set(sid, work);
        // 斜杠命令列表的中途变更（会话里发现新技能、加载了插件）：
        // CLI 的语义是「用这份**替换**你缓存的整份列表」。不接的话，会话中途装的
        // 技能永远不会出现在 `/` 菜单里，用户只能重开会话。
        const cmds = commandsChanged(ev.data);
        if (cmds) {
          set((s) => {
            const prev = s.inits[sid];
            if (!prev) return {};
            return { inits: { ...s.inits, [sid]: { ...prev, commands: cmds } } };
          });
          return;
        }
        // 一轮结束时给「没在看的对话」打上完成标记：正在看的对话结果就在眼前，
        // 再挂一个绿点只会让人以为自己漏了什么。
        const finished = get().activeId !== sid && isTurnResult(ev.data);
        // usage 只在 CLI 真的给出数字时更新（stream_event 的 message_start/delta、
        // 以及 result）；不认识的形状保持原样。
        const usage = applyUsageMessage(get().usage[sid], ev.data);
        // 把这一路攒下的用量快照带进 applyCLI：result 的整轮口径里没有生成耗时，
        // 回答下面那行 tok/s（本回合的 Σ输出 ÷ Σ生成耗时）只能从流式阶段借
        // （否则实时回合永远少这一段）。
        const hint = get().usage[sid];
        set((s) => ({
          items: { ...s.items, [sid]: applyCLI(s.items[sid] ?? [], ev.data, Date.now(), hint) },
          ...(finished ? { doneIds: { ...s.doneIds, [sid]: true } } : {}),
          ...(usage ? { usage: { ...s.usage, [sid]: usage } } : {}),
        }));
        // 一回合结束就把用量写进对话元数据：页面重开 / 换设备打开时底部统计不丢。
        if (usage && isTurnResult(ev.data)) void persistUsage(sid, usage);
        // 本轮开始前切过的档位：等 result 到了再重开，别把正在跑的回合丢掉。
        if (isTurnResult(ev.data) && effortRestarts.delete(sid)) {
          const next = get().settings?.selected?.effort ?? "";
          const cur = get().sessions.find((x) => x.id === sid);
          if (cur && (cur.effort ?? "") !== next) void get().restartSession(sid);
        }
        // 这一轮正常结束：把待发送的队首发出去。被中断 / 出错时留在队列里
        // （shouldFlushAfter 的判定与理由见 lib/queue.ts）。
        if (shouldFlushAfter(ev.data)) void get().flushQueued(sid);
        return;
      }
      default:
        return;
    }
  },
}));

/** 供 UI 读取当前会话连接状态。 */
export function connState(s: AppState, id: string | null): ConnInfo {
  if (!id) return { state: "idle" };
  return s.conns[id] ?? { state: "idle" };
}

/**
 * 仅用于测试：清掉模块级的事件水位与补发窗口。
 *
 * 它们按会话 id 存在模块作用域里（不进 state：组件不会因为水位变化重渲染）。
 * 同一个测试文件里多个用例复用同一个 id 时，前一个用例的水位会漏到下一个，
 * 让「首次快照只对齐不补发」这类断言失效。
 */
export function __resetSyncState(): void {
  for (const id of [...eventSeq.keys()]) endSyncWindow(id);
  eventSeq.clear();
  eventEpoch.clear();
  appliedSeq.clear();
  pendingLive.clear();
  syncTimers.clear();
  awaitingReplay.clear();
  lastSoundAt.clear();
  localWorkAt.clear();
}
