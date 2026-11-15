// 全局状态：会话列表、消息流、权限队列、连接状态、工作区与第三方模型配置。
//
// 设计取舍：
//   - 每个会话的消息列表独立存在 items[sid] 里，切换会话不重新拉取；
//   - WebSocket 实例放在模块级 Map 里（不进 state，避免被当成可序列化数据）；
//   - 所有协议归一化逻辑放 lib/normalize.ts，这里只做状态搬运；
//   - 「当前选中模型」是全局唯一值，它就是 claude CLI 的默认模型；
//   - 工作区 = 已授权目录；切换工作区会 ensure 一个 claude 会话。

import { create } from "zustand";
import { apiFetch } from "../lib/runtime";
import { appendError, appendUser, applyCLI } from "../lib/normalize";
import type { Item } from "../lib/model";
import { ClaudeClient, type ConnStatus, type StatusDetail } from "../transport/client";
import type {
  FsListing,
  GatewayModel,
  InitPayload,
  ModelsResult,
  PermissionPayload,
  ProbeResult,
  PublicSettings,
  Selection,
  SessionInfo,
  WireEvent,
  WorkspaceEntry,
  WorkspacesPayload,
} from "../transport/types";
import { normalizeSettings, type ProviderForm } from "../lib/providerForm";

export type { SessionInfo } from "../transport/types";

export interface InfoResponse {
  version: string;
  base_url: string;
  socket: string;
  claude_bin: string;
  claude_version: string;
  projects_root: string;
  data_dir: string;
  claude_home: string;
  settings_file: string;
  workspaces_file: string;
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

export interface HistorySession {
  id: string;
  cwd: string;
  title: string;
  updated_at: string;
  messages: number;
  project: string;
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
}

interface AppState {
  info: InfoResponse | null;
  settings: PublicSettings | null;
  settingsSaving: boolean;

  workspaces: WorkspaceEntry[];
  workspaceRoot: string;
  currentWorkspace: string;
  workspaceBusy: boolean;
  starting: boolean;

  projects: ProjectEntry[];
  history: HistorySession[];
  sessions: SessionInfo[];
  activeId: string | null;

  items: Record<string, Item[]>;
  perms: Record<string, PermissionPayload[]>;
  inits: Record<string, InitPayload>;
  states: Record<string, string>;
  conns: Record<string, ConnInfo>;

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
  selectModel: (provider: string, model: string) => Promise<void>;
  fetchModelsFor: (form: ProviderForm) => Promise<void>;
  verifyModelFor: (form: ProviderForm, model: string) => Promise<void>;
  probeProvider: (form: ProviderForm) => Promise<void>;

  refreshSessions: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  addWorkspace: (path: string) => Promise<boolean>;
  removeWorkspace: (path: string) => Promise<boolean>;
  switchWorkspace: (path: string) => Promise<void>;
  browseDirs: (path: string, hidden: boolean) => Promise<FsListing>;
  ensureSession: (cwd?: string) => Promise<SessionInfo | null>;
  createSession: (cwd?: string) => Promise<void>;
  closeSession: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
  connect: (id: string) => void;
  disconnect: (id: string) => void;
  retryConnection: (id: string) => void;

  sendPrompt: (text: string) => Promise<void>;
  interrupt: () => void;
  setPermissionMode: (mode: string) => void;
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
const ensurePromises = new Map<string, Promise<SessionInfo | null>>();
const recovering = new Set<string>();
const ACTIVE_KEY = "ccweb-active-session";
let bootstrapPromise: Promise<void> | null = null;

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
    const sessions = r.sessions ?? [];
    if (sessions.some((s) => s.id === id)) return;

    const wasActive = get().activeId === id;
    const cwd = get().sessions.find((s) => s.id === id)?.cwd || get().currentWorkspace;
    get().disconnect(id);
    useAppStore.setState({ sessions });
    if (!wasActive) return;
    get().setActive(null);
    writeActiveId(null);
    if (cwd) {
      const info = await get().ensureSession(cwd);
      if (info && !get().activeId) get().setActive(info.id);
    }
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
  workspaces: [],
  workspaceRoot: "",
  currentWorkspace: "",
  workspaceBusy: false,
  starting: false,
  projects: [],
  history: [],
  sessions: [],
  activeId: null,
  items: {},
  perms: {},
  inits: {},
  states: {},
  conns: {},
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
        const [settings, ws, sessions, history] = await Promise.all([
          apiFetch<PublicSettings>("/api/settings").catch(() => null),
          apiFetch<WorkspacesPayload>("/api/workspaces").catch(() => null),
          apiFetch<{ sessions: SessionInfo[] }>("/api/sessions").catch(() => ({ sessions: [] })),
          apiFetch<{ history: HistorySession[] }>("/api/history").catch(() => ({ history: [] })),
        ]);
        const workspacePayload: WorkspacesPayload = ws ?? {
          workspaces: [],
          current: info.current_workspace ?? "",
          root: info.projects_root ?? "",
        };
        const list = sessions.sessions ?? [];
        set({
          info,
          settings: normalizeSettings(settings),
          workspaces: workspacePayload.workspaces ?? [],
          workspaceRoot: workspacePayload.root ?? info.projects_root ?? "",
          currentWorkspace: workspacePayload.current ?? "",
          sessions: list,
          history: history.history ?? [],
          loading: false,
        });

        // 优先恢复上次打开的会话；否则选当前工作区里最新的一条；再否则第一条。
        const saved = readActiveId();
        const pick =
          list.find((s) => s.id === saved)?.id ??
          list.find((s) => s.cwd === workspacePayload.current)?.id ??
          list[0]?.id ??
          null;
        if (pick) {
          get().setActive(pick);
          get().connect(pick);
          return;
        }

        // APP 启动自动拉起 claude：后端通常已经开始拉；这里再 ensure 一次去重。
        if (info.auto_start && workspacePayload.current) {
          void get().ensureSession(workspacePayload.current);
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
  selectModel: async (provider, model) => {
    const ok = await get().saveSettings({ selected: { provider, model } });
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
    set({ modelsFor: form.id, modelsError: null, modelsRaw: "", modelsAttempts: [], error: null });
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

  refreshHistory: async () => {
    try {
      const r = await apiFetch<{ history: HistorySession[] }>("/api/history");
      set({ history: r.history ?? [] });
    } catch {
      // 历史读取失败不影响主流程
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

  addWorkspace: async (path) => {
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
      await get().ensureSession(r.current);
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
      if (r.current && r.current !== previous) await get().ensureSession(r.current);
      return true;
    } catch (e) {
      set({ error: errText(e) });
      return false;
    } finally {
      set({ workspaceBusy: false });
    }
  },

  switchWorkspace: async (path) => {
    if (!path || path === get().currentWorkspace) {
      await get().ensureSession(path || get().currentWorkspace);
      return;
    }
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
      await get().ensureSession(r.current || path);
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

  ensureSession: async (cwd) => {
    const dir = cwd || get().currentWorkspace;
    if (!dir) {
      set({ error: "请先添加并选择一个授权目录" });
      return null;
    }
    const pending = ensurePromises.get(dir);
    if (pending) return pending;

    set({ starting: true, error: null });
    const promise = (async () => {
      try {
        const info = await apiFetch<SessionInfo>("/api/session/ensure", {
          method: "POST",
          body: JSON.stringify({ cwd: dir }),
        });
        await get().refreshSessions();
        get().setActive(info.id);
        get().connect(info.id);
        return info;
      } catch (e) {
        set({ error: errText(e) });
        return null;
      } finally {
        ensurePromises.delete(dir);
        set({ starting: false });
      }
    })();
    ensurePromises.set(dir, promise);
    return promise;
  },

  createSession: async (cwd) => {
    const dir = cwd || get().currentWorkspace;
    if (!dir) {
      set({ error: "请先添加并选择一个授权目录" });
      return;
    }
    set({ starting: true, error: null });
    try {
      const info = await apiFetch<SessionInfo>("/api/session", {
        method: "POST",
        body: JSON.stringify({ cwd: dir }),
      });
      await get().refreshSessions();
      get().setActive(info.id);
      get().connect(info.id);
    } catch (e) {
      set({ error: errText(e) });
    } finally {
      set({ starting: false });
    }
  },

  closeSession: async (id) => {
    try {
      await apiFetch(`/api/session?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (e) {
      set({ error: errText(e) });
    }
    get().disconnect(id);
    const sessions = get().sessions.filter((s) => s.id !== id);
    set({ sessions });
    if (get().activeId === id) {
      const next = sessions.find((s) => s.cwd === get().currentWorkspace)?.id ?? sessions[0]?.id ?? null;
      get().setActive(next);
      if (next) get().connect(next);
    }
    await get().refreshSessions();
  },

  setActive: (id) => {
    set({ activeId: id });
    writeActiveId(id);
    if (id && !clients.has(id)) get().connect(id);
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
    clients.get(id)?.retryNow();
  },

  sendPrompt: async (text) => {
    let id = get().activeId;
    if (!id) {
      const info = await get().ensureSession();
      id = info?.id ?? null;
    }
    if (!id) return;
    const client = clients.get(id);
    if (!client?.ready) {
      set({ error: "连接尚未就绪，正在自动重连；稍后再发送即可" });
      return;
    }
    if (!client.send({ kind: "prompt", text })) {
      set({ error: "发送失败：连接已断开" });
      return;
    }
    set((s) => ({ items: { ...s.items, [id!]: appendUser(s.items[id!] ?? [], text) } }));
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
        if (data?.info?.state) set((s) => ({ states: { ...s.states, [sid]: data.info!.state! } }));
        return;
      }
      case "session.ready": {
        const data = ev.data as { init?: InitPayload } | undefined;
        if (data?.init) set((s) => ({ inits: { ...s.inits, [sid]: data.init! } }));
        set((s) => ({ states: { ...s.states, [sid]: "ready" } }));
        return;
      }
      case "session.state": {
        const data = ev.data as { state?: string } | undefined;
        if (data?.state) set((s) => ({ states: { ...s.states, [sid]: data.state! } }));
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
        }));
        // 会话进程已退出，WS 再留着只会让界面显示「已连接」却发不出消息。
        clients.get(sid)?.close();
        clients.delete(sid);
        return;
      }
      case "cli": {
        set((s) => ({ items: { ...s.items, [sid]: applyCLI(s.items[sid] ?? [], ev.data) } }));
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
