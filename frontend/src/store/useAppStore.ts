// 全局状态：会话列表、消息流、权限队列、连接状态。
//
// 设计取舍：
//   - 每个会话的消息列表独立存在 items[sid] 里，切换会话不重新拉取；
//   - WebSocket 实例放在模块级 Map 里（不进 state，避免被当成可序列化数据）；
//   - 所有协议归一化逻辑放 lib/normalize.ts，这里只做状态搬运。

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
  WireEvent,
} from "../transport/types";
import type { SettingsPatch } from "../lib/settingsForm";

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

interface AppState {
  info: InfoResponse | null;
  settings: PublicSettings | null;
  settingsSaving: boolean;
  probe: ProbeResult | null;
  gatewayModels: GatewayModel[];
  modelsError: string | null;
  modelsRaw: string;
  modelsTried: string[];
  modelsAttempts: { path: string; status: number; note: string }[];
  verify: { model: string; result: ProbeResult } | null;
  projects: ProjectEntry[];
  history: HistorySession[];
  sessions: SessionInfo[];
  activeId: string | null;

  items: Record<string, Item[]>;
  perms: Record<string, PermissionPayload[]>;
  inits: Record<string, InitPayload>;
  states: Record<string, string>;
  conns: Record<string, ConnState>;

  loading: boolean;
  error: string | null;

  bootstrap: () => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (patch: SettingsPatch) => Promise<boolean>;
  testConnection: () => Promise<void>;
  fetchGatewayModels: (
    baseUrl: string,
    apiKey: string,
    modelsPath?: string,
    apiProtocol?: string,
  ) => Promise<void>;
  verifyModel: (model: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  createSession: (cwd: string, model?: string) => Promise<void>;
  closeSession: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
  connect: (id: string) => void;
  disconnect: (id: string) => void;

  sendPrompt: (text: string) => void;
  interrupt: () => void;
  setModel: (model: string) => void;
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

export const useAppStore = create<AppState>()((set, get) => ({
  info: null,
  settings: null,
  settingsSaving: false,
  probe: null,
  gatewayModels: [],
  modelsError: null,
  modelsRaw: "",
  modelsTried: [],
  modelsAttempts: [],
  verify: null,
  projects: [],
  history: [],
  sessions: [],
  activeId: null,
  items: {},
  perms: {},
  inits: {},
  states: {},
  conns: {},
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
      const settings = await apiFetch<PublicSettings>("/api/settings").catch(() => null);
      set({
        info,
        settings,
        projects: projects.projects,
        sessions: sessions.sessions,
        history: history.history,
        loading: false,
      });
      // 有运行中的会话就自动接上第一个，省一次点击。
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
      const s = await apiFetch<PublicSettings>("/api/settings");
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
      set({ settings: s, settingsSaving: false });
      return true;
    } catch (e) {
      set({ settingsSaving: false, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  testConnection: async () => {
    set({ probe: null, error: null });
    try {
      const r = await apiFetch<ProbeResult>("/api/settings/test", { method: "POST" });
      set({ probe: r });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  fetchGatewayModels: async (baseUrl, apiKey, modelsPath = "", apiProtocol = "") => {
    set({ modelsError: null, error: null, modelsAttempts: [] });
    try {
      const r = await apiFetch<ModelsResult>("/api/settings/models", {
        method: "POST",
        body: JSON.stringify({
          base_url: baseUrl,
          api_key: apiKey,
          models_path: modelsPath,
          api_protocol: apiProtocol,
        }),
      });
      if (r.models && r.models.length > 0) {
        set({
          gatewayModels: r.models,
          modelsRaw: "",
          modelsTried: r.tried ?? [],
          modelsAttempts: r.attempts ?? [],
        });
      } else {
        set({
          gatewayModels: [],
          modelsError: r.detail || "未获取到模型",
          modelsRaw: r.raw ?? "",
          modelsTried: r.tried ?? [],
          modelsAttempts: r.attempts ?? [],
        });
      }
    } catch (e) {
      set({
        gatewayModels: [],
        modelsError: e instanceof Error ? e.message : String(e),
        modelsRaw: "",
        modelsAttempts: [],
      });
    }
  },

  verifyModel: async (model) => {
    if (!model.trim()) return;
    set({ verify: { model, result: { ok: false, endpoint: "", method: "", status: 0, latency_ms: 0, detail: "验证中…" } } });
    try {
      const r = await apiFetch<ProbeResult>("/api/settings/verify", {
        method: "POST",
        body: JSON.stringify({ model }),
      });
      set({ verify: { model, result: r } });
    } catch (e) {
      set({
        verify: {
          model,
          result: { ok: false, endpoint: "", method: "", status: 0, latency_ms: 0, detail: e instanceof Error ? e.message : String(e) },
        },
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

  createSession: async (cwd, model) => {
    set({ error: null });
    try {
      const info = await apiFetch<SessionInfo>("/api/session", {
        method: "POST",
        body: JSON.stringify({ cwd, model }),
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

  setModel: (model) => {
    const id = get().activeId;
    if (!id) return;
    clients.get(id)?.send({ kind: "model", model });
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
