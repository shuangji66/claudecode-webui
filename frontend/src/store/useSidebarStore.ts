// 右侧栏的数据层：文件树（按目录懒加载）、Git 面板与只读预览。
//
// 组件不直接 fetch；所有请求都收敛在这里。切工作区时用一个 epoch 丢弃
// 旧请求的迟到响应，避免 A 目录的树覆盖 B 目录。

import { create } from "zustand";
import { apiFetch, apiFetchBytes } from "../lib/runtime";
import { pickRepo } from "../lib/workspace";
import type {
  FsEntry,
  FsFile,
  FsListing,
  GitBranches,
  GitLogEntry,
  GitRepo,
  GitStatus,
} from "../transport/types";

interface SidebarState {
  cwd: string;
  /** 相对目录路径 → 直接子项；"" 是根。 */
  levels: Record<string, FsEntry[]>;
  loading: Record<string, boolean>;
  truncated: Record<string, boolean>;
  /** 按目录记录读取失败；不要让同一个失败目录在 effect 里无限重试。 */
  errors: Record<string, string>;
  hidden: boolean;

  /** 工作区里扫到的 Git 仓库（含工作区根本身）。 */
  repos: GitRepo[];
  /** 当前选中的仓库绝对路径；空串表示还没选定（面板显示「不是 Git 仓库」）。 */
  repo: string;
  git: GitStatus | null;
  gitLoading: boolean;
  gitError: string;
  branches: GitBranches | null;
  log: GitLogEntry[];
  logLoading: boolean;
  logError: string;
  actionError: string;

  setCwd: (cwd: string) => Promise<void>;
  setHidden: (hidden: boolean) => Promise<void>;
  loadDir: (path: string, force?: boolean) => Promise<void>;
  reloadTree: () => Promise<void>;
  readFile: (path: string) => Promise<FsFile>;
  /**
   * 读 Office 文件的原始字节（docx / xlsx / pptx 由前端解析）。
   *
   * 与 readFile 是两条路：那条回的是文本 JSON（二进制文件只给元数据），
   * 这条拿 ArrayBuffer 交给预览器；后端只放行 Office 扩展名，不能让这里变成
   * 「读工作区任意文件」的通用入口。
   */
  readBytes: (path: string, signal?: AbortSignal) => Promise<ArrayBuffer>;

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
  selectRepo: (root: string) => Promise<void>;
  refreshGit: () => Promise<void>;
  loadBranches: () => Promise<void>;
  loadLog: () => Promise<void>;
  loadDiff: (path: string, staged: boolean) => Promise<string>;
  showCommit: (hash: string) => Promise<string>;
  stage: (path?: string) => Promise<boolean>;
  unstage: (path?: string) => Promise<boolean>;
  discard: (path: string) => Promise<boolean>;
  commit: (message: string) => Promise<boolean>;
  checkout: (branch: string) => Promise<boolean>;
  pull: () => Promise<boolean>;
  clearActionError: () => void;
}

/** 切 cwd 时递增；迟到的响应发现 epoch 变了就直接丢弃。 */
let epoch = 0;
/** 刷新/隐藏开关时递增；只用于丢弃过期的目录树响应。 */
let treeEpoch = 0;
/** Git 状态轮询单飞，避免定时器与手动刷新叠在一起。
 *  必须带上 cwd+epoch：切目录时旧请求仍可能在路上，不能拿它挡住新目录的刷新。 */
let gitInFlight: { key: string; promise: Promise<void> } | null = null;

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

async function postGit(path: string, body: Record<string, unknown>): Promise<void> {
  await apiFetch(path, { method: "POST", body: JSON.stringify(body) });
}

/** Git 请求的 cwd：选中的仓库优先，没有仓库时退回工作区根。 */
function gitCwd(state: SidebarState): string {
  return state.repo || state.cwd;
}

export const useSidebarStore = create<SidebarState>((set, get) => ({
  cwd: "",
  levels: {},
  loading: {},
  truncated: {},
  errors: {},
  hidden: false,

  repos: [],
  repo: "",
  git: null,
  gitLoading: false,
  gitError: "",
  branches: null,
  log: [],
  logLoading: false,
  logError: "",
  actionError: "",
  openRequest: null,

  setCwd: async (cwd) => {
    if (!cwd) {
      epoch += 1;
      treeEpoch += 1;
      set({ cwd: "", levels: {}, loading: {}, truncated: {}, errors: {}, repos: [], repo: "", git: null, branches: null, log: [], openRequest: null });
      return;
    }
    if (cwd === get().cwd) {
      // 重新打开侧栏时刷新，而不是把上次的旧树一直挂在那里。
      await get().reloadTree();
      await get().loadRepos();
      await get().refreshGit();
      return;
    }
    epoch += 1;
    treeEpoch += 1;
    set({
      cwd,
      levels: {},
      loading: {},
      truncated: {},
      errors: {},
      repos: [],
      repo: "",
      git: null,
      gitLoading: true,
      gitError: "",
      branches: null,
      log: [],
      logLoading: false,
      logError: "",
      actionError: "",
      openRequest: null,
    });
    // 先扫仓库再拉状态：状态要打在选中的那个仓库上，顺序反了会先请求工作区根。
    await get().loadDir("");
    await get().loadRepos();
    await Promise.all([get().refreshGit(), get().loadBranches()]);
  },

  loadRepos: async () => {
    const cwd = get().cwd;
    if (!cwd) return;
    const at = epoch;
    try {
      const query = new URLSearchParams({ cwd });
      const payload = await apiFetch<{ repos: GitRepo[] }>(`/api/git/repos?${query.toString()}`);
      if (at !== epoch || get().cwd !== cwd) return;
      const repos = payload.repos ?? [];
      set({ repos, repo: pickRepo(repos, get().repo) });
    } catch (reason) {
      if (at !== epoch || get().cwd !== cwd) return;
      // 扫仓库失败不该让整块面板报错：退回「工作区根」视角，状态接口会给出真实原因。
      set({ repos: [], repo: "", gitError: errorText(reason) });
    }
  },

  selectRepo: async (root) => {
    if (root === get().repo) return;
    set({ repo: root, git: null, branches: null, log: [], gitError: "", actionError: "" });
    await Promise.all([get().refreshGit(), get().loadBranches()]);
    if (get().log.length === 0) await get().loadLog();
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
    set({ levels: {}, loading: {}, truncated: {}, errors: {} });
    await get().loadDir("", true);
  },

  readFile: async (path) => {
    const { cwd } = get();
    if (!cwd) throw new Error("未选择工作区");
    const query = new URLSearchParams({ cwd, path });
    return apiFetch<FsFile>(`/api/fs/file?${query.toString()}`);
  },

  readBytes: async (path, signal) => {
    const { cwd } = get();
    if (!cwd) throw new Error("未选择工作区");
    const query = new URLSearchParams({ cwd, path });
    return apiFetchBytes(`/api/fs/blob?${query.toString()}`, signal);
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

  refreshGit: async () => {
    const cwd = gitCwd(get());
    if (!cwd) return;
    const at = epoch;
    const key = `${at}:${cwd}`;
    if (gitInFlight?.key === key) return gitInFlight.promise;
    set({ gitLoading: true, gitError: "" });
    const slot: { key: string; promise: Promise<void> } = { key, promise: Promise.resolve() };
    const promise = (async () => {
      try {
        const query = new URLSearchParams({ cwd });
        const status = await apiFetch<GitStatus>(`/api/git/status?${query.toString()}`);
        if (at !== epoch || gitCwd(get()) !== cwd) return;
        set({ git: status, gitLoading: false });
      } catch (reason) {
        if (at !== epoch || gitCwd(get()) !== cwd) return;
        set({ gitLoading: false, gitError: errorText(reason) });
      } finally {
        if (gitInFlight === slot) gitInFlight = null;
      }
    })();
    slot.promise = promise;
    gitInFlight = slot;
    return promise;
  },

  loadBranches: async () => {
    const cwd = gitCwd(get());
    if (!cwd) return;
    const at = epoch;
    try {
      const query = new URLSearchParams({ cwd });
      const branches = await apiFetch<GitBranches>(`/api/git/branches?${query.toString()}`);
      if (at !== epoch || gitCwd(get()) !== cwd) return;
      set({ branches });
    } catch {
      // 分支下拉是辅助信息；失败时不覆盖 Git 面板的主错误。
    }
  },

  loadLog: async () => {
    const cwd = gitCwd(get());
    if (!cwd) return;
    const at = epoch;
    set({ logLoading: true, logError: "" });
    try {
      const query = new URLSearchParams({ cwd, count: "30" });
      const payload = await apiFetch<{ entries: GitLogEntry[] }>(`/api/git/log?${query.toString()}`);
      if (at !== epoch || gitCwd(get()) !== cwd) return;
      set({ log: payload.entries ?? [], logLoading: false, logError: "" });
    } catch (reason) {
      if (at !== epoch || gitCwd(get()) !== cwd) return;
      const message = errorText(reason);
      set({ logLoading: false, logError: message, actionError: message });
    }
  },

  loadDiff: async (path, staged) => {
    const cwd = gitCwd(get());
    if (!cwd) throw new Error("未选择工作区");
    const at = epoch;
    const query = new URLSearchParams({ cwd, path, staged: staged ? "1" : "0" });
    const payload = await apiFetch<{ diff: string }>(`/api/git/diff?${query.toString()}`);
    if (at !== epoch || gitCwd(get()) !== cwd) throw new Error("工作区已切换");
    return payload.diff ?? "";
  },

  showCommit: async (hash) => {
    const cwd = gitCwd(get());
    if (!cwd) throw new Error("未选择工作区");
    const at = epoch;
    const query = new URLSearchParams({ cwd, hash });
    const payload = await apiFetch<{ diff: string }>(`/api/git/show?${query.toString()}`);
    if (at !== epoch || gitCwd(get()) !== cwd) throw new Error("工作区已切换");
    return payload.diff ?? "";
  },

  stage: async (path) => {
    const cwd = gitCwd(get());
    if (!cwd) return false;
    try {
      await postGit("/api/git/stage", { cwd, ...(path !== undefined ? { path } : {}) });
      set({ actionError: "" });
      await get().refreshGit();
      return true;
    } catch (reason) {
      set({ actionError: errorText(reason) });
      return false;
    }
  },

  unstage: async (path) => {
    const cwd = gitCwd(get());
    if (!cwd) return false;
    try {
      await postGit("/api/git/unstage", { cwd, ...(path !== undefined ? { path } : {}) });
      set({ actionError: "" });
      await get().refreshGit();
      return true;
    } catch (reason) {
      set({ actionError: errorText(reason) });
      return false;
    }
  },

  discard: async (path) => {
    const cwd = gitCwd(get());
    if (!cwd) return false;
    try {
      await postGit("/api/git/discard", { cwd, path });
      set({ actionError: "" });
      await get().refreshGit();
      return true;
    } catch (reason) {
      set({ actionError: errorText(reason) });
      return false;
    }
  },

  commit: async (message) => {
    const cwd = gitCwd(get());
    if (!cwd) return false;
    try {
      await postGit("/api/git/commit", { cwd, message });
      set({ actionError: "" });
      await get().refreshGit();
      await get().loadLog();
      return true;
    } catch (reason) {
      set({ actionError: errorText(reason) });
      return false;
    }
  },

  checkout: async (branch) => {
    const cwd = gitCwd(get());
    if (!cwd) return false;
    try {
      await postGit("/api/git/checkout", { cwd, branch });
      set({ actionError: "" });
      await get().refreshGit();
      await get().loadBranches();
      return true;
    } catch (reason) {
      set({ actionError: errorText(reason) });
      return false;
    }
  },

  pull: async () => {
    const cwd = gitCwd(get());
    if (!cwd) return false;
    try {
      await postGit("/api/git/pull", { cwd });
      set({ actionError: "" });
      await get().refreshGit();
      await get().loadBranches();
      return true;
    } catch (reason) {
      set({ actionError: errorText(reason) });
      // 冲突/分叉时 git 会停下；刷新一次让面板反映真实状态（不在这里制造 merge）。
      await get().refreshGit();
      return false;
    }
  },

  clearActionError: () => set({ actionError: "" }),
}));
