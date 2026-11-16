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
import { apiFetch } from "../lib/runtime";
import { appendError, appendUser, applyCLI, isTurnResult, prependSystem, subagentFrame } from "../lib/normalize";
import { applyUsageMessage, mergeUsage, usageFromTranscript, type UsageSnapshot } from "../lib/usage";
import { openFnosFileManager } from "../lib/fnos";
import type { Item } from "../lib/model";
import { ClaudeClient, type ConnStatus, type StatusDetail } from "../transport/client";
import type {
  ClaudeCheck,
  HistoryPreview,
  ClaudeStatus,
  ConversationInfo,
  FsAccess,
  FsListing,
  HostFile,
  GatewayModel,
  InitPayload,
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
import { belongs, latestConversation, workspaceFor } from "../lib/conversations";

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
  data_dir: string;
  claude_home: string;
  settings_file: string;
  workspaces_file: string;
  conversations_file?: string;
  auto_start: boolean;
  current_workspace: string;
  auth_required: boolean;
  frontend: boolean;
  max_sessions: number;
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
   * 要在右侧栏打开的子代理对话。右侧栏的标签是它自己管的，这里只放一个「请求」，
   * nonce 让重复点同一张卡片也能把标签切回来。
   */
  subagentView: { agentId: string; label: string; nonce: number } | null;
  perms: Record<string, PermissionPayload[]>;
  inits: Record<string, InitPayload>;
  states: Record<string, string>;
  conns: Record<string, ConnInfo>;
  /**
   * 一轮跑完、但用户还没打开看过的对话。侧栏用它显示绿点；
   * 打开对话（setActive）即清除，否则绿点会一直挂着。
   */
  doneIds: Record<string, boolean>;
  /**
   * 每个会话的实时用量（上下文 / 缓存命中 / 输出速度）。
   * 只从 CLI 真实给出的 usage 派生，见 lib/usage 的说明。
   */
  usage: Record<string, UsageSnapshot>;

  // 「获取可用模型」的临时结果（按提供商分别保存会太啰嗦，这里只留最近一次）
  modelsFor: string;
  gatewayModels: GatewayModel[];
  modelsError: string | null;
  modelsRaw: string;
  modelsAttempts: { path: string; status: number; note: string }[];
  verify: { key: string; result: ProbeResult } | null;
  probe: { key: string; result: ProbeResult } | null;

  loading: boolean;
  error: string | null;

  bootstrap: () => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (patch: SettingsPatch) => Promise<boolean>;
  selectModel: (provider: string, model: string, effort?: string) => Promise<void>;
  fetchModelsFor: (form: ProviderForm) => Promise<void>;
  verifyModelFor: (form: ProviderForm, model: string) => Promise<void>;
  probeProvider: (form: ProviderForm) => Promise<void>;
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
  switchWorkspace: (path: string) => Promise<void>;
  /** 在指定工作区里新建一条对话（先切当前工作区，再创建；不打开旧对话）。 */
  startConversationIn: (path: string) => Promise<void>;
  /** 在飞牛文件管理器里显示目录；失败走全局错误条。 */
  openWorkspaceInFiles: (path: string) => Promise<void>;
  browseDirs: (path: string, hidden: boolean) => Promise<FsListing>;
  /**
   * 探测应用用户能否直接读写该目录。能读写就不必再申请飞牛授权，
   * 只有 writable=false（ACL 还没授予）时才走 authorizeUserFile。
   */
  probeDir: (path: string) => Promise<FsAccess>;
  /** 在目录选择器里新建一层文件夹，返回新目录绝对路径；失败直接抛错给弹窗展示。 */
  mkdirDir: (parent: string, name: string) => Promise<string>;
  /** 读取飞牛里挑中的图片/PDF（后端只放行这两类），用于转成对话附件。 */
  readHostFile: (path: string) => Promise<HostFile>;
  /** 打开目录下最近一条对话；createIfEmpty=false 时没有对话就保持空态，不新建。 */
  ensureSession: (cwd?: string, createIfEmpty?: boolean) => Promise<SessionInfo | null>;
  createSession: (cwd?: string) => Promise<void>;
  openConversation: (id: string, force?: boolean) => Promise<boolean>;
  renameConversation: (id: string, title: string) => Promise<boolean>;
  archiveConversation: (id: string, archived: boolean) => Promise<boolean>;
  deleteConversation: (id: string) => Promise<boolean>;
  closeSession: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
  connect: (id: string) => void;
  disconnect: (id: string) => void;
  retryConnection: (id: string) => void;

  sendPrompt: (text: string, attachments?: WireAttachment[], attachmentLabel?: string) => Promise<void>;
  interrupt: () => void;
  setPermissionMode: (mode: string) => void;
  /** 在右侧栏打开某个子代理的对话。 */
  showSubagent: (agentId: string, label: string) => void;
  /** 停止一个后台任务（子代理 / 后台命令）。 */
  stopTask: (taskId: string) => Promise<void>;
  /** 会话的最近几句（侧栏悬浮预览），按 id 缓存。 */
  loadPreview: (id: string) => Promise<HistoryPreview | null>;
  replyPermission: (
    req: PermissionPayload,
    allow: boolean,
    updatedInput?: unknown,
    updatedPermissions?: unknown,
    message?: string,
  ) => void;

  applyEvent: (sid: string, ev: WireEvent) => void;
  clearError: () => void;
}

const clients = new Map<string, ClaudeClient>();
/** 会话悬浮预览的缓存：一轮结束后清掉，下次 hover 会重新读盘。 */
const previewCache = new Map<string, HistoryPreview | null>();
const resumePromises = new Map<string, Promise<boolean>>();
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
    protocol: form.protocol,
    base_url: form.baseUrl,
    api_key: form.apiKey,
    auth_token: form.authToken,
    models_path: form.modelsPath,
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
      .sort((a, b) => (b.last_active ?? "").localeCompare(a.last_active ?? ""))[0];
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
  subagentView: null,
  perms: {},
  inits: {},
  states: {},
  conns: {},
  doneIds: {},
  usage: {},
  modelsFor: "",
  gatewayModels: [],
  modelsError: null,
  modelsRaw: "",
  modelsAttempts: [],
  verify: null,
  probe: null,
  loading: false,
  error: null,

  clearError: () => set({ error: null }),

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
    set({ modelsFor: form.id, gatewayModels: [], modelsError: null, modelsRaw: "", modelsAttempts: [], error: null });
    try {
      const r = await apiFetch<ModelsResult>("/api/settings/models", {
        method: "POST",
        body: JSON.stringify(providerRef(form)),
      });
      if (r.models && r.models.length > 0) {
        set({ gatewayModels: r.models, modelsAttempts: r.attempts ?? [] });
      } else {
        set({
          gatewayModels: [],
          modelsError: r.detail || "未获取到模型",
          modelsRaw: r.raw ?? "",
          modelsAttempts: r.attempts ?? [],
        });
      }
    } catch (e) {
      set({ gatewayModels: [], modelsError: errText(e), modelsRaw: "" });
    }
  },

  verifyModelFor: async (form, model) => {
    if (!model.trim()) return;
    const key = `${form.id}/${model}`;
    set({ verify: { key, result: { ok: false, endpoint: "", method: "", status: 0, latency_ms: 0, detail: "验证中…" } } });
    try {
      const r = await apiFetch<ProbeResult>("/api/settings/verify", {
        method: "POST",
        body: JSON.stringify({ ...providerRef(form), model }),
      });
      set({ verify: { key, result: r } });
    } catch (e) {
      set({
        verify: {
          key,
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

  probeProvider: async (form) => {
    const key = form.id;
    set({ probe: { key, result: { ok: false, endpoint: "", method: "", status: 0, latency_ms: 0, detail: "探测中…" } } });
    try {
      const r = await apiFetch<ProbeResult>("/api/settings/test", {
        method: "POST",
        body: JSON.stringify(providerRef(form)),
      });
      set({ probe: { key, result: r } });
    } catch (e) {
      set({
        probe: {
          key,
          result: { ok: false, endpoint: "", method: "", status: 0, latency_ms: 0, detail: errText(e) },
        },
      });
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
    try {
      const r = await apiFetch<{ conversations: ConversationInfo[] }>("/api/conversations");
      set({ conversations: r.conversations ?? [] });
    } catch (e) {
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

  mkdirDir: async (parent, name) => {
    const r = await apiFetch<{ path: string }>("/api/fs/mkdir", {
      method: "POST",
      body: JSON.stringify({ path: parent, name }),
    });
    return r.path;
  },

  switchWorkspace: async (path) => {
    // 点击当前工作区只负责折叠/展开，不再顺手打开或新建对话。
    if (!path || path === get().currentWorkspace) return;
    set({ workspaceBusy: true, error: null });
    try {
      const r = await apiFetch<WorkspacesPayload>("/api/workspaces/current", {
        method: "POST",
        body: JSON.stringify({ path }),
      });
      set({
        workspaces: r.workspaces ?? [],
        currentWorkspace: r.current ?? path,
        workspaceRoot: r.root ?? get().workspaceRoot,
      });
      await get().ensureSession(r.current || path, false);
    } catch (e) {
      set({ error: errText(e) });
    } finally {
      set({ workspaceBusy: false });
    }
  },

  browseDirs: async (path, hidden) => {
    const q = new URLSearchParams();
    if (path) q.set("path", path);
    if (hidden) q.set("hidden", "1");
    return apiFetch<FsListing>(`/api/fs/list?${q.toString()}`);
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
      await createTask;
      return;
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
    set({ starting: true, error: null });
    const task = (async (): Promise<SessionInfo | null> => {
      try {
        const info = await apiFetch<SessionInfo>("/api/session", {
          method: "POST",
          body: JSON.stringify({ cwd: dir }),
        });
        await Promise.all([get().refreshSessions(), get().refreshConversations()]);
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
        set({ error: errText(e) });
        return null;
      } finally {
        set({ starting: false });
      }
    })();
    createTask = task;
    await task;
    if (createTask === task) createTask = null;
  },

  openConversation: async (id, force = false) => {
    // 新对话还在创建时先等它落定，避免创建完成后的 setActive 覆盖用户新选的对话。
    if (createTask) await createTask.catch(() => null);
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv) {
      set({ error: "对话不存在或已被删除" });
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

    const loadTranscript = async () => {
      if ((get().items[id] ?? []).length > 0) return;
      // 全新空对话没有转录文件；直接跳过，避免制造一次预期的 404。
      if (conv.messages === 0 && !conv.title) return;
      try {
        const tr = await apiFetch<TranscriptPayload>(`/api/history/transcript?id=${encodeURIComponent(id)}`);
        if ((get().items[id] ?? []).length > 0) return;
        let next: Item[] = [];
        for (const line of tr.lines ?? []) {
          const rec = line as { timestamp?: unknown };
          const at = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
          next = applyCLI(next, line, Number.isFinite(at) ? at : Date.now());
        }
        // 后端只回放最近 20k 行 / 16MB；被截断时必须说出来，否则用户会以为
        // 这段对话本来就这么短。
        if (tr.truncated) next = prependSystem(next, "更早的消息已被省略（只保留最近一段转录）");
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
    };

    if (!force && clients.get(id)?.ready) {
      await loadTranscript();
      get().connect(id);
      return true;
    }

    const pending = resumePromises.get(id);
    if (pending) return pending;
    const promise = (async () => {
      set({ starting: true, error: null });
      try {
        const info = await apiFetch<SessionInfo>("/api/session", {
          method: "POST",
          body: JSON.stringify({ cwd: conv.cwd, resume: id }),
        });
        await Promise.all([get().refreshSessions(), get().refreshConversations()]);
        await loadTranscript();
        get().setActive(info.id);
        get().connect(info.id);
        return true;
      } catch (e) {
        set({ error: errText(e) });
        return false;
      } finally {
        resumePromises.delete(id);
        set({ starting: false });
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

  archiveConversation: async (id, archived) => {
    const conv = get().conversations.find((c) => c.id === id);
    try {
      await apiFetch("/api/conversations", {
        method: "PATCH",
        body: JSON.stringify({ id, archived }),
      });
      get().disconnect(id);
      await get().refreshConversations();
      if (archived && get().activeId === id) {
        const root = conv ? workspaceFor(conv.cwd, get().workspaces) || conv.cwd : get().currentWorkspace;
        const next = get()
          .conversations.filter((c) => c.id !== id && !c.archived && belongs(c.cwd, root))
          .sort((a, b) => (b.last_active ?? "").localeCompare(a.last_active ?? ""))[0];
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

  deleteConversation: async (id) => {
    const conv = get().conversations.find((c) => c.id === id);
    try {
      await apiFetch(`/api/conversations?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      get().disconnect(id);
      await get().refreshConversations();
      if (get().activeId === id) {
        const root = conv ? workspaceFor(conv.cwd, get().workspaces) || conv.cwd : get().currentWorkspace;
        const next = get()
          .conversations.filter((c) => c.id !== id && !c.archived && belongs(c.cwd, root))
          .sort((a, b) => (b.last_active ?? "").localeCompare(a.last_active ?? ""))[0];
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
    await Promise.all([get().refreshSessions(), get().refreshConversations()]);
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

  sendPrompt: async (text, attachments = [], attachmentLabel = "附件：") => {
    if (!text.trim() && attachments.length === 0) return;
    // 刚点「新对话」时 active 还没切过去：等创建完成，避免把消息发给上一个对话。
    if (createTask) {
      const created = await createTask.catch(() => null);
      if (!created) return;
    }
    let id = get().activeId;
    if (!id) {
      const info = await get().ensureSession();
      id = info?.id ?? null;
    }
    if (!id) return;
    if (!clients.get(id)) {
      // 进程被空闲回收后 active 仍在：发送前先按对话 id 恢复。
      const ok = await get().openConversation(id, true);
      if (!ok) return;
    }
    if (!clients.get(id)?.ready) {
      // 刚 resume / 新建的会话，HTTP 已经返回但 WS 还在握手；等它真正 open 再发。
      const ok = await waitForOpen(id);
      if (!ok) {
        set({ error: "连接尚未就绪，正在自动重连；稍后再发送即可" });
        return;
      }
    }
    const client = clients.get(id);
    if (!client?.send({ kind: "prompt", text, attachments: attachments.length > 0 ? attachments : undefined })) {
      set({ error: "发送失败：连接已断开" });
      return;
    }
    const display = [text.trim(), ...attachments.map((a) => `${attachmentLabel}${a.name}`)].filter(Boolean).join("\n");
    const now = new Date().toISOString();
    set((s) => ({
      items: { ...s.items, [id!]: appendUser(s.items[id!] ?? [], display) },
      conversations: s.conversations.map((c) => (c.id === id ? { ...c, last_active: now } : c)),
    }));
    window.setTimeout(() => void get().refreshConversations(), 600);
  },

  interrupt: () => {
    const id = get().activeId;
    if (!id) return;
    clients.get(id)?.send({ kind: "interrupt" });
  },

  setPermissionMode: (mode) => {
    const id = get().activeId;
    if (!id) return;
    clients.get(id)?.send({ kind: "permission_mode", mode });
  },

  loadPreview: async (id) => {
    if (previewCache.has(id)) return previewCache.get(id) ?? null;
    try {
      const p = await apiFetch<HistoryPreview>(`/api/history/preview?id=${encodeURIComponent(id)}`);
      previewCache.set(id, p);
      return p;
    } catch {
      previewCache.set(id, null);
      return null;
    }
  },

  showSubagent: (agentId, label) => {
    if (!agentId) return;
    set((s) => ({
      subagentView: { agentId, label: label || "subagent", nonce: (s.subagentView?.nonce ?? 0) + 1 },
    }));
  },

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
    clients.get(id)?.send({
      kind: "permission",
      request_id: req.request_id,
      allow,
      updated_input: updatedInput,
      updated_permissions: updatedPermissions,
      message,
    });
    set((s) => ({
      perms: { ...s.perms, [id]: (s.perms[id] ?? []).filter((p) => p.request_id !== req.request_id) },
    }));
  },

  applyEvent: (sid, ev) => {
    switch (ev.kind) {
      case "session.snapshot": {
        const data = ev.data as { init?: InitPayload; info?: { state?: string } } | undefined;
        if (data?.init) set((s) => ({ inits: { ...s.inits, [sid]: data.init! } }));
        if (data?.info?.state) {
          const state = data.info.state;
          set((s) => ({
            states: { ...s.states, [sid]: state },
            conversations: s.conversations.map((c) => (c.id === sid ? { ...c, live: true, state } : c)),
          }));
        }
        return;
      }
      case "session.ready": {
        const data = ev.data as { init?: InitPayload } | undefined;
        if (data?.init) set((s) => ({ inits: { ...s.inits, [sid]: data.init! } }));
        set((s) => ({
          states: { ...s.states, [sid]: "ready" },
          conversations: s.conversations.map((c) => (c.id === sid ? { ...c, live: true, state: "ready" } : c)),
        }));
        return;
      }
      case "session.state": {
        const data = ev.data as { state?: string } | undefined;
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
          set((s) => ({ perms: { ...s.perms, [sid]: [...(s.perms[sid] ?? []), p] } }));
        }
        return;
      }
      case "error": {
        const data = ev.data as { message?: string } | undefined;
        set((s) => ({
          items: { ...s.items, [sid]: appendError(s.items[sid] ?? [], data?.message ?? "未知错误") },
        }));
        return;
      }
      case "closed": {
        set((s) => ({
          states: { ...s.states, [sid]: "closed" },
          conns: { ...s.conns, [sid]: { state: "closed" } },
          conversations: s.conversations.map((c) => (c.id === sid ? { ...c, live: false, state: "closed" } : c)),
        }));
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
          set((s) => {
            const byAgent = s.subagentItems[sid] ?? {};
            const prev = byAgent[sub.agentId] ?? [];
            return {
              subagentItems: {
                ...s.subagentItems,
                [sid]: { ...byAgent, [sub.agentId]: applyCLI(prev, ev.data) },
              },
            };
          });
          return;
        }
        // 一轮结束时给「没在看的对话」打上完成标记：正在看的对话结果就在眼前，
        // 再挂一个绿点只会让人以为自己漏了什么。
        const finished = get().activeId !== sid && isTurnResult(ev.data);
        // usage 只在 CLI 真的给出数字时更新（stream_event 的 message_start/delta、
        // 以及 result）；不认识的形状保持原样。
        const usage = applyUsageMessage(get().usage[sid], ev.data);
        set((s) => ({
          items: { ...s.items, [sid]: applyCLI(s.items[sid] ?? [], ev.data) },
          ...(finished ? { doneIds: { ...s.doneIds, [sid]: true } } : {}),
          ...(usage ? { usage: { ...s.usage, [sid]: usage } } : {}),
        }));
        // 一回合结束就把用量写进对话元数据：页面重开 / 换设备打开时底部统计不丢。
        if (usage && isTurnResult(ev.data)) void persistUsage(sid, usage);
        // 新回合的回复变了，悬浮预览要重新读。
        if (isTurnResult(ev.data)) previewCache.delete(sid);
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
