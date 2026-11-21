// 右侧栏的数据层：文件树（按目录懒加载）、Git 面板与只读预览。
//
// 组件不直接 fetch；所有请求都收敛在这里。切工作区时用一个 epoch 丢弃
// 旧请求的迟到响应，避免 A 目录的树覆盖 B 目录。

import { create } from "zustand";
import { apiFetch, apiFetchBytes } from "../lib/runtime";
import type { FsEntry, FsFile, FsListing, GitRepo } from "../transport/types";

interface SidebarState {
  cwd: string;
  /** 相对目录路径 → 直接子项；"" 是根。 */
  levels: Record<string, FsEntry[]>;
  loading: Record<string, boolean>;
  truncated: Record<string, boolean>;
  /** 按目录记录读取失败；不要让同一个失败目录在 effect 里无限重试。 */
  errors: Record<string, string>;
  hidden: boolean;

  /** 工作区里扫到的 Git 仓库（含工作区根本身）。共享只读列表，选中哪一个由各
   *  Git 面板自己记（`useGitRepo`）——分栏后两栏要能各看一个仓库。 */
  repos: GitRepo[];
  /** `/api/git/repos` 算出的「cwd 所在仓库」；可能不在 `repos` 里（工作区只授权了
   *  仓库下面一层时），面板据此避免乱选另一个仓库。 */
  cwdRepo: string;

  setCwd: (cwd: string) => Promise<void>;
  setHidden: (hidden: boolean) => Promise<void>;
  loadDir: (path: string, force?: boolean) => Promise<void>;
  reloadTree: () => Promise<void>;
  readFile: (path: string) => Promise<FsFile>;
  /**
   * 文件页顶部的搜索：按名字 / 相对路径子串在整个工作区里找。
   *
   * `cwd` 由面板显式给（与 `readBytes` 同一条理由：切工作区的一瞬间 store 与
   * 面板可能不是同一个目录）；`signal` 让防抖后的新查询能取消上一次遍历。
   */
  searchFiles: (
    query: string,
    opts?: { signal?: AbortSignal; cwd?: string; hidden?: boolean; limit?: number },
  ) => Promise<FsListing>;
  /**
   * 读 Office 文件的原始字节（docx / xlsx / pptx 由前端解析）。
   *
   * 与 readFile 是两条路：那条回的是文本 JSON（二进制文件只给元数据），
   * 这条拿 ArrayBuffer 交给预览器；后端只放行 Office 扩展名，不能让这里变成
   * 「读工作区任意文件」的通用入口。
   *
   * `cwd` 由调用方显式给（侧栏面板的 cwd prop）：切工作区的那一瞬间 store 里的
   * 当前工作区可能已经换了，而面板还挂着上一个目录的选中路径。
   */
  readBytes: (path: string, opts?: { signal?: AbortSignal; cwd?: string }) => Promise<ArrayBuffer>;

  /**
   * 正文里点「在右侧栏打开」的请求。
   *
   * `seq` 单调递增而不是直接存路径：同一个文件被点第二次时值没变化，
   * 消费方（RightSidebar）的 effect 就不会再跑一次。
   */
  openRequest: { path: string; seq: number } | null;
  requestOpenFile: (path: string) => void;
  /**
   * 标记这条请求已经处理过（清空 `openRequest`）。
   *
   * 请求是一次性的，必须由消费方显式消费掉：留着它的话，右侧栏被关掉再打开、
   * 或者「文件」标签关掉再打开（组件重新挂载、消费用的 ref 归零）会把上一次的
   * 请求重放一遍——用户只是关了侧栏，却又被送进一张早就看完的图。
   */
  consumeOpenFile: () => void;

  loadRepos: () => Promise<void>;
}

/** 切 cwd 时递增；迟到的响应发现 epoch 变了就直接丢弃。 */
let epoch = 0;
/** 刷新/隐藏开关时递增；只用于丢弃过期的目录树响应。 */
let treeEpoch = 0;
function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export const useSidebarStore = create<SidebarState>((set, get) => ({
  cwd: "",
  levels: {},
  loading: {},
  truncated: {},
  errors: {},
  hidden: false,

  repos: [],
  cwdRepo: "",
  openRequest: null,

  setCwd: async (cwd) => {
    if (!cwd) {
      epoch += 1;
      treeEpoch += 1;
      set({ cwd: "", levels: {}, loading: {}, truncated: {}, errors: {}, repos: [], cwdRepo: "", openRequest: null });
      return;
    }
    if (cwd === get().cwd) {
      // 重新打开侧栏时刷新，而不是把上次的旧树一直挂在那里。
      await get().reloadTree();
      await get().loadRepos();
      return;
    }
    epoch += 1;
    treeEpoch += 1;
    set({ cwd, levels: {}, loading: {}, truncated: {}, errors: {}, repos: [], cwdRepo: "", openRequest: null });
    // 先扫仓库：Git 面板要按「cwd 属于哪个仓库」初始化选中项。
    await get().loadDir("");
    await get().loadRepos();
  },

  loadRepos: async () => {
    const cwd = get().cwd;
    if (!cwd) return;
    const at = epoch;
    try {
      const query = new URLSearchParams({ cwd });
      const payload = await apiFetch<{ repos: GitRepo[]; cwd_repo?: string }>(
        `/api/git/repos?${query.toString()}`,
      );
      if (at !== epoch || get().cwd !== cwd) return;
      set({ repos: payload.repos ?? [], cwdRepo: payload.cwd_repo ?? "" });
    } catch {
      if (at !== epoch || get().cwd !== cwd) return;
      // 扫仓库失败不该让整块面板报错：状态接口会给出真实原因，面板按 cwd 兜底。
      set({ repos: [], cwdRepo: "" });
    }
  },

  setHidden: async (hidden) => {
    treeEpoch += 1;
    set({ hidden, levels: {}, loading: {}, truncated: {}, errors: {} });
    if (get().cwd) await get().loadDir("");
  },

  loadDir: async (path, force = false) => {
    const { cwd, levels, loading } = get();
    if (!cwd) return;
    if (!force && levels[path] !== undefined) return;
    if (loading[path]) return;
    const at = epoch;
    const treeAt = treeEpoch;
    set((s) => ({ loading: { ...s.loading, [path]: true } }));
    try {
      const query = new URLSearchParams({ cwd, path, hidden: get().hidden ? "1" : "0" });
      const listing = await apiFetch<FsListing>(`/api/fs/tree?${query.toString()}`);
      if (at !== epoch || treeAt !== treeEpoch || get().cwd !== cwd) return;
      set((s) => {
        const errors = { ...s.errors };
        delete errors[path];
        return {
          levels: { ...s.levels, [path]: listing.entries ?? [] },
          truncated: { ...s.truncated, [path]: Boolean(listing.truncated) },
          loading: { ...s.loading, [path]: false },
          errors,
        };
      });
    } catch (reason) {
      if (at !== epoch || treeAt !== treeEpoch || get().cwd !== cwd) return;
      set((s) => ({
        loading: { ...s.loading, [path]: false },
        errors: { ...s.errors, [path]: errorText(reason) },
      }));
    }
  },

  reloadTree: async () => {
    treeEpoch += 1;
    // 不先清空 levels：清空会让所有子目录节点卸载重挂，TreeNode 的本地展开状态
    // （`open`）随之归零，用户点一次刷新就得把折叠的目录重新展开一遍。
    // 这里只把**已经加载过的**目录原样重取（根目录永远重取），树保持可视、原地更新，
    // 列表里已经消失的路径自然不再渲染。
    const paths = [...new Set([...Object.keys(get().levels), ""])];
    // 清掉 loading 才能让这些路径的强制重取不被 `loading[path]` 提前 return 掉（旧
    // treeEpoch 的请求可能还挂着，它们的响应本来就会被丢弃）；清 errors 让读取失败过的
    // 目录重新发请求——刷新本来就是「再试一次」，挂着的节点会在 effect 里补取。
    set({ loading: {}, errors: {} });
    await Promise.all(paths.map((path) => get().loadDir(path, true)));
  },

  readFile: async (path) => {
    const { cwd } = get();
    if (!cwd) throw new Error("未选择工作区");
    const query = new URLSearchParams({ cwd, path });
    return apiFetch<FsFile>(`/api/fs/file?${query.toString()}`);
  },

  searchFiles: async (query, opts) => {
    const cwd = opts?.cwd ?? get().cwd;
    if (!cwd) throw new Error("未选择工作区");
    const params = new URLSearchParams({ cwd, q: query, hidden: (opts?.hidden ?? get().hidden) ? "1" : "0" });
    if (opts?.limit) params.set("limit", String(opts.limit));
    return apiFetch<FsListing>(`/api/fs/search?${params.toString()}`, { signal: opts?.signal });
  },

  readBytes: async (path, opts) => {
    const cwd = opts?.cwd ?? get().cwd;
    if (!cwd) throw new Error("未选择工作区");
    const query = new URLSearchParams({ cwd, path });
    return apiFetchBytes(`/api/fs/blob?${query.toString()}`, opts?.signal);
  },

  requestOpenFile: (path) => {
    const rel = path.trim();
    if (!rel) return;
    set((s) => ({ openRequest: { path: rel, seq: (s.openRequest?.seq ?? 0) + 1 } }));
  },

  consumeOpenFile: () => {
    if (get().openRequest === null) return;
    set({ openRequest: null });
  },

}));
