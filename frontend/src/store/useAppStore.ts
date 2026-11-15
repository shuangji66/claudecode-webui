// 全局状态：会话列表、消息流、权限队列、连接状态、第三方模型配置。
//
// 设计取舍：
//   - 每个会话的消息列表独立存在 items[sid] 里，切换会话不重新拉取；
//   - WebSocket 实例放在模块级 Map 里（不进 state，避免被当成可序列化数据）；
//   - 所有协议归一化逻辑放 lib/normalize.ts，这里只做状态搬运；
//   - 「当前选中模型」是全局唯一值，它就是 claude CLI 的默认模型。

import { create } from "zustand";
import { apiFetch } from "../lib/runtime";
import { appendError, appendUser, applyCLI } from "../lib/normalize";
import type { Item } from "../lib/model";
import { ClaudeClient } from "../transport/client";
import type {
  GatewayModel,
  InitPayload,
  ModelsResult,
  PermissionPayload,
  ProbeResult,
  PublicSettings,
  Selection,
  WireEvent,
} from "../transport/types";
import { normalizeSettings, type ProviderForm } from "../lib/providerForm";

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
  auth_required: boolean;
  frontend: boolean;
  max_sessions: number;
  started_at: string;
}

export interface SessionInfo {
  id: string;
  cwd: string;
  state: string;
  /** 创建该会话时选中的提供商；跨提供商切换模型需要新建会话。 */
  provider?: string;
  model?: string;
  created_at?: string;
  last_active?: string;
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

type ConnState = "idle" | "open" | "closed";

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

  projects: ProjectEntry[];
  history: HistorySession[];
  sessions: SessionInfo[];
  activeId: string | null;

  items: Record<string, Item[]>;
  perms: Record<string, PermissionPayload[]>;
  inits: Record<string, InitPayload>;
  states: Record<string, string>;
  conns: Record<string, ConnState>;

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
  createSession: (cwd: string) => Promise<void>;
  closeSession: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
  connect: (id: string) => void;
  disconnect: (id: string) => void;

  sendPrompt: (text: string) => void;
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

function token(): string {
  try {
    return localStorage.getItem("ccweb-token") ?? "";
  } catch {
    return "";
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

export const useAppStore = create<AppState>()((set, get) => ({
  info: null,
  settings: null,
  settingsSaving: false,
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
    set({ loading: true, error: null });
    try {
      const info = await apiFetch<InfoResponse>("/api/info");
      const [projects, sessions, history] = await Promise.all([
        apiFetch<{ projects: ProjectEntry[] }>("/api/projects").catch(() => ({ projects: [] })),
        apiFetch<{ sessions: SessionInfo[] }>("/api/sessions").catch(() => ({ sessions: [] })),
        apiFetch<{ history: HistorySession[] }>("/api/history").catch(() => ({ history: [] })),
      ]);
      const settings = normalizeSettings(await apiFetch<PublicSettings>("/api/settings").catch(() => null));
      set({
        info,
        settings,
        projects: projects.projects,
        sessions: sessions.sessions,
        history: history.history,
        loading: false,
      });
      const first = sessions.sessions[0];
      if (first && !get().activeId) {
        get().setActive(first.id);
        get().connect(first.id);
      }
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  loadSettings: async () => {
    try {
      const s = normalizeSettings(await apiFetch<PublicSettings>("/api/settings"));
      set({ settings: s });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
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
      set({ settingsSaving: false, error: e instanceof Error ? e.message : String(e) });
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
    if (!id) return;
    const sess = get().sessions.find((s) => s.id === id);
    if (sess?.provider && sess.provider !== provider) {
      set({ error: "已切换提供商：该会话仍连在旧提供商上，请新建会话后生效" });
      return;
    }
    clients.get(id)?.send({ kind: "model", model });
    await get().refreshSessions();
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
      set({ gatewayModels: [], modelsError: e instanceof Error ? e.message : String(e), modelsRaw: "" });
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
        verify: { key, result: { ok: false, endpoint: "", method: "", status: 0, latency_ms: 0, detail: e instanceof Error ? e.message : String(e) } },
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
        probe: { key, result: { ok: false, endpoint: "", method: "", status: 0, latency_ms: 0, detail: e instanceof Error ? e.message : String(e) } },
      });
    }
  },

  refreshSessions: async () => {
    try {
      const r = await apiFetch<{ sessions: SessionInfo[] }>("/api/sessions");
      set({ sessions: r.sessions ?? [] });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
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

  createSession: async (cwd) => {
    set({ error: null });
    try {
      const info = await apiFetch<SessionInfo>("/api/session", {
        method: "POST",
        body: JSON.stringify({ cwd }),
      });
      await get().refreshSessions();
      get().setActive(info.id);
      get().connect(info.id);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  closeSession: async (id) => {
    try {
      await apiFetch(`/api/session?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
    get().disconnect(id);
    const sessions = get().sessions.filter((s) => s.id !== id);
    set({ sessions });
    if (get().activeId === id) {
      const next = sessions[0]?.id ?? null;
      set({ activeId: next });
      if (next) get().connect(next);
    }
    await get().refreshSessions();
  },

  setActive: (id) => {
    set({ activeId: id });
    if (id && !clients.has(id)) get().connect(id);
  },

  connect: (id) => {
    if (clients.has(id)) return;
    const client = new ClaudeClient(id, token(), {
      onEvent: (ev) => get().applyEvent(id, ev),
      onOpen: () => set((s) => ({ conns: { ...s.conns, [id]: "open" } })),
      onClose: (reason) => {
        clients.delete(id);
        set((s) => ({
          conns: { ...s.conns, [id]: "closed" },
          items: { ...s.items, [id]: appendError(s.items[id] ?? [], reason) },
        }));
      },
    });
    clients.set(id, client);
    client.connect();
    set((s) => ({ conns: { ...s.conns, [id]: "idle" } }));
  },

  disconnect: (id) => {
    clients.get(id)?.close();
    clients.delete(id);
  },

  sendPrompt: (text) => {
    const id = get().activeId;
    if (!id) return;
    const client = clients.get(id);
    if (!client) {
      set({ error: "会话未连接" });
      return;
    }
    set((s) => ({ items: { ...s.items, [id]: appendUser(s.items[id] ?? [], text) } }));
    client.send({ kind: "prompt", text });
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
        set((s) => ({ states: { ...s.states, [sid]: "closed" } }));
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
