// 一个 Git 面板实例自己的状态与动作。
//
// 右侧栏分栏后可以同时开两个 Git 面板，它们要能各看一个仓库：仓库选择、状态、
// 分支、历史都必须按实例隔离。以前这些都放在 `useSidebarStore` 里，两个面板因此
// 永远同步显示同一个仓库（一边点 chip，另一边跟着变）。共享的只剩
// 「工作区里扫到哪些仓库」这份只读列表（`repos` / `cwdRepo`）。
//
// 组件不直接 fetch 的约定不变：请求都收在这里，面板只读状态、调动作。

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/runtime";
import { pickRepo } from "../lib/workspace";
import { useSidebarStore } from "./useSidebarStore";
import { acquireGitWatch, subscribeGitChanged } from "./useAppStore";
import type { GitBranches, GitCommit, GitLogEntry, GitRepo, GitStatus } from "../transport/types";

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

async function postGit(path: string, body: Record<string, unknown>): Promise<void> {
  await apiFetch(path, { method: "POST", body: JSON.stringify(body) });
}

export interface GitRepoState {
  /** 工作区里扫到的仓库（共享只读列表）。 */
  repos: GitRepo[];
  /** 这个面板当前选中的仓库绝对路径；空串表示还没选定。 */
  repo: string;
  git: GitStatus | null;
  gitLoading: boolean;
  gitError: string;
  branches: GitBranches | null;
  log: GitLogEntry[];
  logLoading: boolean;
  logError: string;
  /** 当前仓库的 log 是否已经取过（空仓库也算取过）。 */
  logLoaded: boolean;
  actionError: string;

  selectRepo: (root: string) => void;
  /** 拉一次状态；返回这次拿到的快照（失败 / 已过期时 null），
   *  调用方据此决定要不要继续拉分支与历史（`git.changed` 的收尾要用它）。 */
  refreshGit: () => Promise<GitStatus | null>;
  loadBranches: () => Promise<void>;
  loadLog: () => Promise<void>;
  loadDiff: (path: string, staged: boolean) => Promise<string>;
  showCommit: (hash: string) => Promise<GitCommit>;
  stage: (path?: string) => Promise<boolean>;
  unstage: (path?: string) => Promise<boolean>;
  discard: (path: string) => Promise<boolean>;
  commit: (message: string) => Promise<boolean>;
  checkout: (branch: string) => Promise<boolean>;
  pull: () => Promise<boolean>;
  clearActionError: () => void;
}

/**
 * 绑一个 Git 面板实例到它自己的仓库状态。
 *
 * `active` 只在面板真的可见时为真：不可见时不订阅 `git.watch`（不然没人看的屏幕
 * 也会让后端每几秒跑一次 git），但仓库选择与数据保留着，切回来直接显示。
 */
export function useGitRepo(cwd: string, active: boolean): GitRepoState {
  const repos = useSidebarStore((s) => s.repos);
  const cwdRepo = useSidebarStore((s) => s.cwdRepo);

  // 初始选中：工作区扫到的仓库列表可能已经就绪（侧栏先 loadRepos 再渲染面板），
  // 就按 cwd 归属选好，避免先按工作区根拉一遍状态再重拉。
  const [repo, setRepo] = useState(() => (cwd ? pickRepo(repos, "", cwd, cwdRepo) : ""));
  const [git, setGit] = useState<GitStatus | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState("");
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState("");
  const [logLoaded, setLogLoaded] = useState(false);
  const [actionError, setActionError] = useState("");

  const repoRef = useRef(repo);
  repoRef.current = repo;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  /** 面板内的「代」：换 cwd / 换仓库时递增，丢弃迟到响应。 */
  const epochRef = useRef(0);
  const statusInFlight = useRef<{ key: string; promise: Promise<GitStatus | null> } | null>(null);
  const logInFlight = useRef<{ key: string; promise: Promise<void> } | null>(null);

  const target = useCallback(() => repoRef.current || cwdRef.current, []);

  // 仓库列表刷新（含刚建立工作区、新建/删除仓库）后，保持当前选择；
  // 选择失效时按 cwd 归属重选。
  useEffect(() => {
    if (!cwd) {
      setRepo("");
      return;
    }
    setRepo((current) => {
      const next = pickRepo(repos, current, cwd, cwdRepo);
      return next === current ? current : next;
    });
  }, [cwd, repos, cwdRepo]);

  const refreshGit = useCallback(async (): Promise<GitStatus | null> => {
    const at = epochRef.current;
    const dir = target();
    if (!dir) return null;
    const key = `${at}:${dir}`;
    if (statusInFlight.current?.key === key) return statusInFlight.current.promise;
    setGitLoading(true);
    setGitError("");
    const slot: { key: string; promise: Promise<GitStatus | null> } = {
      key,
      promise: Promise.resolve(null),
    };
    const promise = (async (): Promise<GitStatus | null> => {
      try {
        const query = new URLSearchParams({ cwd: dir });
        const status = await apiFetch<GitStatus>(`/api/git/status?${query.toString()}`);
        if (epochRef.current !== at || target() !== dir) return null;
        setGit(status);
        setGitLoading(false);
        return status;
      } catch (reason) {
        if (epochRef.current !== at || target() !== dir) return null;
        setGitLoading(false);
        setGitError(errorText(reason));
        return null;
      } finally {
        if (statusInFlight.current === slot) statusInFlight.current = null;
      }
    })();
    slot.promise = promise;
    statusInFlight.current = slot;
    return promise;
  }, [target]);

  const loadBranches = useCallback(async () => {
    const at = epochRef.current;
    const dir = target();
    if (!dir) return;
    try {
      const query = new URLSearchParams({ cwd: dir });
      const next = await apiFetch<GitBranches>(`/api/git/branches?${query.toString()}`);
      if (epochRef.current !== at || target() !== dir) return;
      setBranches(next);
    } catch {
      // 分支下拉是辅助信息；失败时不覆盖面板的主错误。
    }
  }, [target]);

  const loadLog = useCallback(async () => {
    const at = epochRef.current;
    const dir = target();
    if (!dir) return;
    const key = `${at}:${dir}`;
    if (logInFlight.current?.key === key) return logInFlight.current.promise;
    setLogLoading(true);
    setLogError("");
    const slot: { key: string; promise: Promise<void> } = { key, promise: Promise.resolve() };
    const promise = (async () => {
      try {
        const query = new URLSearchParams({ cwd: dir, count: "30" });
        const payload = await apiFetch<{ entries: GitLogEntry[] }>(`/api/git/log?${query.toString()}`);
        if (epochRef.current !== at || target() !== dir) return;
        setLog(payload.entries ?? []);
        setLogLoading(false);
        setLogError("");
        setLogLoaded(true);
      } catch (reason) {
        if (epochRef.current !== at || target() !== dir) return;
        const message = errorText(reason);
        setLogLoading(false);
        setLogError(message);
        setLogLoaded(true);
        setActionError(message);
      } finally {
        if (logInFlight.current === slot) logInFlight.current = null;
      }
    })();
    slot.promise = promise;
    logInFlight.current = slot;
    return promise;
  }, [target]);

  // 换仓库 / 换工作区：清掉上一份数据，再按新目标拉一次状态与分支。
  // 依赖只有 cwd 与 repo，effect 里用的动作只读 ref，不会自触发。
  useEffect(() => {
    epochRef.current += 1;
    setGit(null);
    setGitLoading(false);
    setGitError("");
    setBranches(null);
    setLog([]);
    setLogLoading(false);
    setLogError("");
    setLogLoaded(false);
    setActionError("");
    if (!cwd) return;
    void refreshGit();
    void loadBranches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, repo]);

  // 后端推来的「这个仓库变了」。两个面板可能盯不同仓库：只处理自己这一个。
  const handlerRef = useRef<(changed: string) => void>(() => {});
  handlerRef.current = (changed: string) => {
    const dir = target();
    if (!dir || (changed && changed !== dir)) return;
    // 用 refreshGit 的**返回值**判断要不要继续：React 的 setState 是异步的，
    // await 之后读 `gitRef.current` 还是上一份快照（会把「已经不是仓库」当成仓库）。
    void refreshGit().then((status) => {
      // 已经不是仓库了（被删掉 .git）：别再拉分支与历史，那两条只会各报一次错。
      if (!status?.is_repo) return;
      void loadBranches();
      void loadLog();
    });
  };
  useEffect(() => subscribeGitChanged((changed) => handlerRef.current(changed)), []);

  // 看得见才订阅这个仓库；两栏各看一个仓库时，系统通道会同时盯两个。
  useEffect(() => {
    if (!active) return;
    return acquireGitWatch(repo || cwd);
  }, [active, repo, cwd]);

  const selectRepo = useCallback(
    (root: string) => {
      if (root === repoRef.current) return;
      setRepo(root);
    },
    [],
  );

  const loadDiff = useCallback(async (path: string, staged: boolean) => {
    const at = epochRef.current;
    const dir = target();
    if (!dir) throw new Error("未选择工作区");
    const query = new URLSearchParams({ cwd: dir, path, staged: staged ? "1" : "0" });
    const payload = await apiFetch<{ diff: string }>(`/api/git/diff?${query.toString()}`);
    if (epochRef.current !== at || target() !== dir) throw new Error("工作区已切换");
    return payload.diff ?? "";
  }, [target]);

  const showCommit = useCallback(async (hash: string) => {
    const at = epochRef.current;
    const dir = target();
    if (!dir) throw new Error("未选择工作区");
    const query = new URLSearchParams({ cwd: dir, hash });
    const payload = await apiFetch<GitCommit>(`/api/git/show?${query.toString()}`);
    if (epochRef.current !== at || target() !== dir) throw new Error("工作区已切换");
    return { ...payload, diff: payload.diff ?? "", parents: payload.parents ?? [] };
  }, [target]);

  const stage = useCallback(async (path?: string) => {
    const dir = target();
    if (!dir) return false;
    try {
      await postGit("/api/git/stage", { cwd: dir, ...(path !== undefined ? { path } : {}) });
      setActionError("");
      await refreshGit();
      return true;
    } catch (reason) {
      setActionError(errorText(reason));
      return false;
    }
  }, [refreshGit, target]);

  const unstage = useCallback(async (path?: string) => {
    const dir = target();
    if (!dir) return false;
    try {
      await postGit("/api/git/unstage", { cwd: dir, ...(path !== undefined ? { path } : {}) });
      setActionError("");
      await refreshGit();
      return true;
    } catch (reason) {
      setActionError(errorText(reason));
      return false;
    }
  }, [refreshGit, target]);

  const discard = useCallback(async (path: string) => {
    const dir = target();
    if (!dir) return false;
    try {
      await postGit("/api/git/discard", { cwd: dir, path });
      setActionError("");
      await refreshGit();
      return true;
    } catch (reason) {
      setActionError(errorText(reason));
      return false;
    }
  }, [refreshGit, target]);

  const commit = useCallback(async (message: string) => {
    const dir = target();
    if (!dir) return false;
    try {
      await postGit("/api/git/commit", { cwd: dir, message });
      setActionError("");
      await refreshGit();
      await loadLog();
      return true;
    } catch (reason) {
      setActionError(errorText(reason));
      return false;
    }
  }, [loadLog, refreshGit, target]);

  const checkout = useCallback(async (branch: string) => {
    const dir = target();
    if (!dir) return false;
    try {
      await postGit("/api/git/checkout", { cwd: dir, branch });
      setActionError("");
      await refreshGit();
      await loadBranches();
      return true;
    } catch (reason) {
      setActionError(errorText(reason));
      return false;
    }
  }, [loadBranches, refreshGit, target]);

  const pull = useCallback(async () => {
    const dir = target();
    if (!dir) return false;
    try {
      await postGit("/api/git/pull", { cwd: dir });
      setActionError("");
      await refreshGit();
      await loadBranches();
      // 拉下来的提交必须立刻出现在「历史」里：只刷新状态的话，用户得手动点刷新
      // 才知道这次到底拉到了什么。
      await loadLog();
      return true;
    } catch (reason) {
      setActionError(errorText(reason));
      // 冲突/分叉时 git 会停下；刷新一次让面板反映真实状态（不在这里制造 merge）。
      await refreshGit();
      return false;
    }
  }, [loadBranches, loadLog, refreshGit, target]);

  const clearActionError = useCallback(() => setActionError(""), []);

  return {
    repos,
    repo,
    git,
    gitLoading,
    gitError,
    branches,
    log,
    logLoading,
    logError,
    logLoaded,
    actionError,
    selectRepo,
    refreshGit,
    loadBranches,
    loadLog,
    loadDiff,
    showCommit,
    stage,
    unstage,
    discard,
    commit,
    checkout,
    pull,
    clearActionError,
  };
}
