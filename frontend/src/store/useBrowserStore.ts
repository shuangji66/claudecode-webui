// 「设置 → MCP → 内置浏览器」的数据层。
//
// 内置浏览器 = 本二进制的 `mcp-browser` 子命令（MCP 工具）+ 托管下载的
// playwright 运行时与 Chromium/Firefox 内核。这里只管三件事：读状态、触发安装、卸载。
// 安装是后台任务：接口立即返回，进度靠轮询 status（和 claude 版本下载同一套形态）。
import { create } from "zustand";
import { apiFetch } from "../lib/runtime";
import type { BrowserStatus } from "../transport/types";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface BrowserState {
  status: BrowserStatus | null;
  error: string | null;
  busy: boolean;

  load: () => Promise<void>;
  install: (source?: string) => Promise<void>;
  cancel: () => Promise<void>;
  remove: () => Promise<void>;
  setError: (msg: string | null) => void;
}

export const useBrowserStore = create<BrowserState>((set) => ({
  status: null,
  error: null,
  busy: false,

  load: async () => {
    try {
      // 轮询路径：不要把 busy 拉起来（那会让「安装」按钮在每一轮闪烁）。
      set({ status: await apiFetch<BrowserStatus>("/api/browser") });
    } catch (e) {
      set({ error: errText(e) });
    }
  },

  install: async (source) => {
    set({ busy: true, error: null });
    try {
      const status = await apiFetch<BrowserStatus>("/api/browser/install", {
        method: "POST",
        body: JSON.stringify(source ? { source } : {}),
      });
      set({ status, busy: false });
    } catch (e) {
      set({ error: errText(e), busy: false });
    }
  },

  cancel: async () => {
    set({ busy: true });
    try {
      set({ status: await apiFetch<BrowserStatus>("/api/browser/cancel", { method: "POST" }), busy: false });
    } catch (e) {
      set({ error: errText(e), busy: false });
    }
  },

  remove: async () => {
    set({ busy: true, error: null });
    try {
      set({ status: await apiFetch<BrowserStatus>("/api/browser", { method: "DELETE" }), busy: false });
    } catch (e) {
      set({ error: errText(e), busy: false });
    }
  },

  setError: (msg) => set({ error: msg }),
}));
