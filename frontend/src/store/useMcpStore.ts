// 「设置 → MCP」的数据层：/api/mcp 的读写都收敛在这里。
//
// 与 useSkillsStore 同样的理由单独开一个 store：它只在设置弹窗里用，
// 数据跟着弹窗生命周期走；组件不直接 fetch。
//
// 语义提醒（界面上也要说）：改完配置不会热加载，MCP server 是 claude 会话
// 启动时连接的，要重开会话才生效。
import { create } from "zustand";
import { apiFetch } from "../lib/runtime";
import type { McpPayload, McpProbe, McpScope, McpServer } from "../transport/types";

const EMPTY: McpPayload = { user: [], project: [], project_root: "", user_path: "", project_path: "" };

/** 后端保证返回数组，异常响应也不能把界面打白。 */
export function normalizeMcp(p: McpPayload | null): McpPayload {
  if (!p) return EMPTY;
  return {
    user: Array.isArray(p.user) ? p.user : [],
    project: Array.isArray(p.project) ? p.project : [],
    project_root: p.project_root ?? "",
    user_path: p.user_path ?? "",
    project_path: p.project_path ?? "",
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 探测结果按 `${scope}:${name}` 记住：刷新列表不清空，用户能看到刚才那次结果。 */
export type ProbeMap = Record<string, McpProbe>;

interface McpState {
  cwd: string;
  data: McpPayload;
  probes: ProbeMap;
  error: string | null;
  busy: boolean;
  /** 正在探测的服务 key（`scope:name`），用来只转那一个按钮。 */
  probing: string | null;

  load: (cwd: string) => Promise<void>;
  save: (server: McpServer) => Promise<boolean>;
  remove: (scope: McpScope, name: string) => Promise<boolean>;
  setEnabled: (scope: McpScope, name: string, enabled: boolean) => Promise<boolean>;
  probe: (scope: McpScope, name: string) => Promise<void>;
  setError: (msg: string | null) => void;
}

/** 项目级请求要带 cwd；用户级不带（后端也不看）。 */
function withCwd(state: McpState, scope: McpScope): string {
  return scope === "project" ? state.cwd : "";
}

function query(state: McpState, scope: McpScope, name: string): string {
  const qs = new URLSearchParams({ scope, name });
  const cwd = withCwd(state, scope);
  if (cwd) qs.set("cwd", cwd);
  return qs.toString();
}

export const useMcpStore = create<McpState>((set, get) => ({
  cwd: "",
  data: EMPTY,
  probes: {},
  error: null,
  busy: false,
  probing: null,

  load: async (cwd) => {
    set({ busy: true, error: null, cwd });
    try {
      const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      const data = normalizeMcp(await apiFetch<McpPayload>(`/api/mcp${q}`));
      set({ data, busy: false });
    } catch (e) {
      set({ error: errText(e), busy: false });
    }
  },

  save: async (server) => {
    set({ busy: true, error: null });
    try {
      await apiFetch<McpServer>("/api/mcp", {
        method: "POST",
        body: JSON.stringify({ cwd: withCwd(get(), server.scope), server }),
      });
      // 名字/作用域都是标识，改过就重新拉一遍，别在本地拼状态。
      await get().load(get().cwd);
      return true;
    } catch (e) {
      set({ error: errText(e), busy: false });
      return false;
    }
  },

  remove: async (scope, name) => {
    set({ busy: true, error: null });
    try {
      await apiFetch(`/api/mcp?${query(get(), scope, name)}`, { method: "DELETE" });
      set((s) => {
        const probes = { ...s.probes };
        delete probes[`${scope}:${name}`];
        return { probes, busy: false };
      });
      await get().load(get().cwd);
      return true;
    } catch (e) {
      set({ error: errText(e), busy: false });
      return false;
    }
  },

  setEnabled: async (scope, name, enabled) => {
    set({ busy: true, error: null });
    try {
      await apiFetch("/api/mcp/enabled", {
        method: "POST",
        body: JSON.stringify({ cwd: withCwd(get(), scope), scope, name, enabled }),
      });
      // 启用/停用会改变配置文件内容，旧的探测结果不再可信。
      set((s) => {
        const probes = { ...s.probes };
        delete probes[`${scope}:${name}`];
        return { probes, busy: false };
      });
      await get().load(get().cwd);
      return true;
    } catch (e) {
      set({ error: errText(e), busy: false });
      return false;
    }
  },

  probe: async (scope, name) => {
    const key = `${scope}:${name}`;
    set({ probing: key, error: null });
    try {
      const res = await apiFetch<McpProbe>("/api/mcp/probe", {
        method: "POST",
        body: JSON.stringify({ cwd: withCwd(get(), scope), scope, name }),
      });
      set((s) => ({ probes: { ...s.probes, [key]: res }, probing: null }));
    } catch (e) {
      set((s) => ({
        probes: { ...s.probes, [key]: { ok: false, latency_ms: 0, error: errText(e) } },
        probing: null,
      }));
    }
  },

  setError: (msg) => set({ error: msg }),
}));
