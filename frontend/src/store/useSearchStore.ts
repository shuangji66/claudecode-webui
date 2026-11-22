// 「设置 → MCP → 内置搜索」的数据层。
//
// 内置搜索 = DeepSeek 的 Search / Fetch API，通过本二进制的 `mcp-web` 子命令
// 暴露成 MCP 工具。这里只管两件事：读状态、存配置（注册状态由后端 Maintain，
// 保存配置时会一并同步，界面只显示「已注册 / 未注册」）。
// 密钥不在前端落盘也不回显明文，只回脱敏值；空输入 = 沿用旧值。
import { create } from "zustand";
import { apiFetch } from "../lib/runtime";
import type { SearchStatus, SearchTestResult } from "../transport/types";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface SearchPatch {
  base_url?: string;
  api_key?: string;
  clear_key?: boolean;
  count?: number;
  enabled?: boolean;
}

interface SearchState {
  status: SearchStatus | null;
  error: string | null;
  busy: boolean;
  testing: boolean;
  test: SearchTestResult | null;

  load: () => Promise<void>;
  save: (patch: SearchPatch) => Promise<boolean>;
  runTest: () => Promise<void>;
  setError: (msg: string | null) => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  status: null,
  error: null,
  busy: false,
  testing: false,
  test: null,

  load: async () => {
    set({ busy: true, error: null });
    try {
      set({ status: await apiFetch<SearchStatus>("/api/search"), busy: false });
    } catch (e) {
      set({ error: errText(e), busy: false });
    }
  },

  save: async (patch) => {
    set({ busy: true, error: null });
    try {
      const status = await apiFetch<SearchStatus>("/api/search/config", {
        method: "POST",
        body: JSON.stringify(patch),
      });
      // 配置变了，上一次的测试结果不再代表现状。
      set({ status, busy: false, test: null });
      return true;
    } catch (e) {
      set({ error: errText(e), busy: false });
      return false;
    }
  },

  runTest: async () => {
    set({ testing: true, error: null, test: null });
    try {
      set({ test: await apiFetch<SearchTestResult>("/api/search/test", { method: "POST", body: "{}" }), testing: false });
    } catch (e) {
      set({ error: errText(e), testing: false });
    }
  },

  setError: (msg) => set({ error: msg }),
}));

/** 测试用：把 store 复位到「什么都没加载」。 */
export function resetSearchStore(): void {
  useSearchStore.setState({ status: null, error: null, busy: false, testing: false, test: null });
}

export { errText as searchErrText };
