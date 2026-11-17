// 「设置 → 插件」的数据层：/api/plugins* 的读写收敛在这里。
//
// 三个特殊之处：
//   1. 变更操作（安装/更新/卸载/marketplace）在后端是**后台任务**——CLI 的克隆最长
//      120s，同步接口会被网关超时掐断。所以这里发完请求就轮询 /api/plugins 看 job.phase，
//      任务结束再刷新一次列表。
//   2. 「可安装目录」有 3743 条（官方市场实测）、全量 JSON 1.27 MB，所以**列表、过滤、
//      分页都在服务端**：这里只保留当前页 + 命中数。搜索用 250ms 防抖，别每敲一个字发一次。
//   3. 目录缓存由后端落盘（CCWEB_DATA_DIR/plugins-available.json），重进设置页先读缓存，
//      不必再等一次 CLI（首次抓目录可能要十几秒）。

import { create } from "zustand";
import { apiFetch } from "../lib/runtime";
import { AVAILABLE_PAGE_SIZE, availableQuery, EMPTY_PLUGINS, normalizePlugins } from "../lib/plugins";
import type { PluginAvailable, PluginAvailablePage, PluginDetailsPayload, PluginJob, PluginsPayload } from "../transport/types";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 任务轮询间隔：变更操作最长几十秒，1.2s 够用又不至于刷屏。 */
const POLL_MS = 1200;
/** 搜索防抖：本地后端过滤 3743 条是微秒级，250ms 只是别让每次按键都发请求。 */
const QUERY_DEBOUNCE_MS = 250;

/** 「可安装」当前这一页的视图状态。 */
interface AvailableView {
  items: PluginAvailable[];
  /** 当前过滤条件下的命中数。 */
  matched: number;
  /** 目录总条数（0 表示还没读过，或目录为空）。 */
  total: number;
  loading: boolean;
  query: string;
  market: string;
  hideInstalled: boolean;
  fetchedAt?: string;
  note?: string;
}

const EMPTY_AVAILABLE: AvailableView = {
  items: [],
  matched: 0,
  total: 0,
  loading: false,
  query: "",
  market: "",
  hideInstalled: false,
};

interface PluginsState {
  cwd: string;
  data: PluginsPayload;
  details: PluginDetailsPayload | null;
  loadingDetails: boolean;
  avail: AvailableView;
  error: string | null;
  busy: boolean;
  /** 是否已经完成过一次读取：用来区分「还没读到」与「读到不支持」。 */
  loaded: boolean;
  /** 正在跑的任务（后端返回的 job）；轮询期间用来判断何时停。 */
  job: PluginJob | null;

  load: (cwd: string) => Promise<void>;
  refreshAvailable: () => Promise<void>;
  /** 重新读第一页（换过滤条件时用）。 */
  loadAvailable: (opts?: { keepScroll?: boolean }) => Promise<void>;
  /** 「显示更多」：把下一页追加到当前列表。 */
  showMoreAvailable: () => Promise<void>;
  setAvailQuery: (q: string) => void;
  setAvailMarket: (market: string) => void;
  setAvailHideInstalled: (hide: boolean) => void;
  install: (id: string, marketplace: string, scope: string) => Promise<void>;
  setEnabled: (id: string, scope: string, enabled: boolean) => Promise<void>;
  update: (id: string, scope: string) => Promise<void>;
  uninstall: (id: string, scope: string, keepData: boolean) => Promise<void>;
  marketplace: (action: "add" | "update" | "remove", args: { source?: string; name?: string }) => Promise<void>;
  openDetails: (id: string) => Promise<void>;
  clearDetails: () => void;
  setError: (msg: string | null) => void;
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let queryTimer: ReturnType<typeof setTimeout> | null = null;
/** 目录请求序号：快速改搜索词时，只认最后一次的结果。 */
let availSeq = 0;

export const usePluginStore = create<PluginsState>((set, get) => {
  const settle = async () => {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    set({ busy: false });
    // load 内部会把「可安装」当前页也重读一遍（装/卸之后命中数会变）。
    await get().load(get().cwd);
  };

  const watch = async () => {
    const poll = async () => {
      try {
        const payload = normalizePlugins(await apiFetch<PluginsPayload>(`/api/plugins?cwd=${encodeURIComponent(get().cwd)}`));
        const job = payload.job;
        set({ data: payload, job, loaded: true });
        if (job && job.phase === "running") {
          pollTimer = setTimeout(() => void poll(), POLL_MS);
          return;
        }
        if (job && job.phase === "error") {
          set({ error: job.error ?? "操作失败" });
        }
        await settle();
      } catch (e) {
        set({ error: errText(e), busy: false });
      }
    };
    await poll();
  };

  const startJob = async (path: string, body: unknown) => {
    set({ busy: true, error: null });
    try {
      const res = await apiFetch<{ job: PluginJob }>(path, { method: "POST", body: JSON.stringify(body) });
      set({ job: res.job ?? null });
      await watch();
    } catch (e) {
      set({ error: errText(e), busy: false });
    }
  };

  /** 读一页可安装插件（append=true 时追加，用于「显示更多」）。 */
  const fetchAvailable = async (append: boolean) => {
    const avail = get().avail;
    const offset = append ? avail.items.length : 0;
    const seq = ++availSeq;
    set({ avail: { ...avail, loading: true } });
    try {
      const qs = availableQuery({
        q: avail.query,
        market: avail.market,
        hideInstalled: avail.hideInstalled,
        offset,
        limit: AVAILABLE_PAGE_SIZE,
      });
      const page = await apiFetch<PluginAvailablePage>(`/api/plugins/available?${qs}`);
      if (seq !== availSeq) return; // 已有更新的请求，丢弃这次结果
      const items = Array.isArray(page.items) ? page.items : [];
      set({
        avail: {
          ...get().avail,
          items: append ? [...get().avail.items, ...items] : items,
          matched: page.matched ?? 0,
          total: page.total ?? 0,
          loading: false,
          fetchedAt: page.fetched_at,
          note: page.note,
        },
      });
    } catch (e) {
      if (seq !== availSeq) return;
      set({ avail: { ...get().avail, loading: false }, error: errText(e) });
    }
  };

  return {
    cwd: "",
    data: EMPTY_PLUGINS,
    details: null,
    loadingDetails: false,
    avail: EMPTY_AVAILABLE,
    error: null,
    busy: false,
    loaded: false,
    job: null,

    load: async (cwd) => {
      set({ cwd });
      try {
        const payload = normalizePlugins(await apiFetch<PluginsPayload>(`/api/plugins?cwd=${encodeURIComponent(cwd)}`));
        set({ data: payload, job: payload.job, loaded: true });
        // 有目录（落盘缓存或刚刷完）就把当前页读出来：重进设置页不该看到空白。
        if (payload.available_total > 0) {
          await fetchAvailable(false);
        }
        // 页面打开时若已有任务在跑（自动刷新 / 另一个标签页发起的），接着轮询它。
        if (payload.job && payload.job.phase === "running" && !pollTimer) {
          set({ busy: true });
          pollTimer = setTimeout(() => void watch(), POLL_MS);
        }
      } catch (e) {
        set({ error: errText(e), data: EMPTY_PLUGINS, loaded: true });
      }
    },

    refreshAvailable: async () => {
      await startJob("/api/plugins/refresh", {});
    },

    loadAvailable: async () => {
      await fetchAvailable(false);
    },

    showMoreAvailable: async () => {
      await fetchAvailable(true);
    },

    setAvailQuery: (q) => {
      set({ avail: { ...get().avail, query: q } });
      if (queryTimer) clearTimeout(queryTimer);
      queryTimer = setTimeout(() => void fetchAvailable(false), QUERY_DEBOUNCE_MS);
    },

    setAvailMarket: (market) => {
      set({ avail: { ...get().avail, market } });
      void fetchAvailable(false);
    },

    setAvailHideInstalled: (hide) => {
      set({ avail: { ...get().avail, hideInstalled: hide } });
      void fetchAvailable(false);
    },

    install: async (id, marketplace, scope) => {
      const cwd = scope === "project" ? get().cwd : "";
      // id 里已经带 `@市场`：再传 marketplace 会把「市场名」当来源发给 CLI（它只认
      // owner/repo|https|路径）。只有调用方明确给的是一个来源时才带上。
      const fromSource = marketplace !== "" && /[/:]/.test(marketplace) ? marketplace : "";
      await startJob("/api/plugins/install", { id, marketplace: fromSource, scope, cwd });
    },

    setEnabled: async (id, scope, enabled) => {
      const cwd = scope === "project" ? get().cwd : "";
      await startJob("/api/plugins/enabled", { id, scope, cwd, enabled });
    },

    update: async (id, scope) => {
      const cwd = scope === "project" ? get().cwd : "";
      await startJob("/api/plugins/update", { id, scope, cwd });
    },

    uninstall: async (id, scope, keepData) => {
      const cwd = scope === "project" ? get().cwd : "";
      await startJob("/api/plugins/uninstall", { id, scope, cwd, keep_data: keepData });
    },

    marketplace: async (action, args) => {
      await startJob("/api/plugins/marketplace", { action, ...args });
    },

    openDetails: async (id) => {
      set({ loadingDetails: true, error: null });
      try {
        const payload = await apiFetch<PluginDetailsPayload>(`/api/plugins/details?id=${encodeURIComponent(id)}`);
        set({ details: payload, loadingDetails: false });
      } catch (e) {
        set({ error: errText(e), loadingDetails: false });
      }
    },

    clearDetails: () => set({ details: null }),
    setError: (msg) => set({ error: msg }),
  };
});

/** 测试与登出时清掉挂在模块上的定时器。 */
export function stopPluginPolling(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (queryTimer) {
    clearTimeout(queryTimer);
    queryTimer = null;
  }
}
