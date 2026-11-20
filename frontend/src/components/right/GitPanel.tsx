import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import {
  asAddedDiff,
  diffStat,
  groupChanges,
  lineCountParts,
  parseUnifiedDiff,
  refsLabel,
  type ChangeRow,
  type GitTone,
} from "../../lib/workspace";
import { useSidebarStore } from "../../store/useSidebarStore";
import { watchGitRepo } from "../../store/useAppStore";
import { Select } from "../common/Select";
import { FileIcon } from "../common/FileIcon";
import { askConfirm } from "../common/SystemDialogs";
import type { GitLineCounts, GitLogEntry } from "../../transport/types";
import {
  IconChevronLeft,
  IconGitBranch,
  IconGitCommit,
  IconMinus,
  IconPlus,
  IconRetry,
  IconSync,
  IconTrash,
  IconWrap,
} from "../common/Icons";

interface Props {
  cwd: string;
  active: boolean;
}

type Mode = "changes" | "history";

interface DiffViewState {
  title: string;
  subtitle: string;
  text: string;
  /** 这是一条提交详情（历史页签），不是工作区改动。 */
  commit?: boolean;
}

const TONE_TEXT: Record<GitTone, string> = {
  modified: "text-warn",
  added: "text-ok",
  deleted: "text-danger",
  untracked: "text-muted",
  renamed: "text-brand",
  copied: "text-brand",
  conflict: "text-danger",
};

const MAX_DIFF_LINES = 4000;

/** 增删行数：绿色 `+N` / 红色 `−N` 各自一段，为 0 的一侧不渲染（不出 `−0`）。 */
function LineCounts({ counts }: { counts: GitLineCounts | undefined }) {
  const parts = lineCountParts(counts);
  return (
    <>
      {parts.map((part, i) => (
        <span key={part.text} className={part.tone}>
          {i > 0 ? " " : ""}
          {part.text}
        </span>
      ))}
    </>
  );
}

/** 右侧栏 Git 面板：变更分组 + diff 预览 + 提交框 + 最近提交 + 分支底栏。 */
export function GitPanel({ cwd, active }: Props) {
  const t = useT();
  const repos = useSidebarStore((s) => s.repos);
  const repoRoot = useSidebarStore((s) => s.repo);
  const selectRepo = useSidebarStore((s) => s.selectRepo);
  const git = useSidebarStore((s) => s.git);
  const gitLoading = useSidebarStore((s) => s.gitLoading);
  const gitError = useSidebarStore((s) => s.gitError);
  const branches = useSidebarStore((s) => s.branches);
  const log = useSidebarStore((s) => s.log);
  const logLoading = useSidebarStore((s) => s.logLoading);
  const logError = useSidebarStore((s) => s.logError);
  const actionError = useSidebarStore((s) => s.actionError);
  const refreshGit = useSidebarStore((s) => s.refreshGit);
  const loadLog = useSidebarStore((s) => s.loadLog);
  const loadDiff = useSidebarStore((s) => s.loadDiff);
  const showCommit = useSidebarStore((s) => s.showCommit);
  const readFile = useSidebarStore((s) => s.readFile);
  const stage = useSidebarStore((s) => s.stage);
  const unstage = useSidebarStore((s) => s.unstage);
  const discard = useSidebarStore((s) => s.discard);
  const commit = useSidebarStore((s) => s.commit);
  const checkout = useSidebarStore((s) => s.checkout);
  const pull = useSidebarStore((s) => s.pull);
  const clearActionError = useSidebarStore((s) => s.clearActionError);

  const [mode, setMode] = useState<Mode>("changes");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null);
  const [diff, setDiff] = useState<DiffViewState | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState("");
  /**
   * diff 里的长行是否按面板宽度折行（默认折行）。
   *
   * 右侧栏宽度是拖出来的，窄栏里横向滚动条基本没法用（与文件源码预览同一条理由）；
   * 但 diff 逐行标了行号，看大段改动时也有人更想要「一行就是一行」，所以给个开关。
   * 状态放在面板这一层而不是 DiffView 里面：关掉再打开文件时不该自己弹回去。
   */
  const [wrap, setWrap] = useState(true);
  /** 连续点不同文件时，只允许最后一次请求发布结果。 */
  const diffSeq = useRef(0);

  useEffect(() => {
    diffSeq.current += 1;
    setMode("changes");
    setMessage("");
    setSelected(null);
    setDiff(null);
    setDiffError("");
    setDiffLoading(false);
  }, [cwd]);

  // 历史按需加载；切到历史页签才请求，避免每次开侧栏都跑一条 git log。
  useEffect(() => {
    if (active && mode === "history" && log.length === 0 && !logLoading && !logError) void loadLog();
  }, [active, mode, log.length, logLoading, logError, loadLog]);

  // 可见时不再自己轮询：让后端盯住这个仓库，变了就推 `git.changed`
  // （系统通道的 git.watch，见 useAppStore.watchGitRepo）。切走标签就退订，
  // 否则关掉的侧栏也会一直让 NAS 上每几秒跑一次 git status。
  const watchCwd = repoRoot || cwd;
  useEffect(() => {
    if (!active || !watchCwd) return;
    watchGitRepo(watchCwd);
    return () => watchGitRepo(null);
  }, [active, watchCwd]);

  // 推送只在「变了」时来：重新可见时要先把停用期间的变化补齐，不然面板停在旧数据上。
  useEffect(() => {
    if (!active) return;
    void refreshGit();
    // loadLog 只补历史那一页；没打开过历史就不必为它跑一条 git log。
    if (mode === "history") void loadLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const groups = useMemo(() => groupChanges(git?.entries ?? []), [git?.entries]);
  const stagedCount = groups.staged.length;
  const totalCount = useMemo(() => {
    const paths = new Set<string>();
    for (const row of [...groups.conflicts, ...groups.staged, ...groups.unstaged]) paths.add(row.entry.path);
    return paths.size;
  }, [groups]);

  const openChange = async (row: ChangeRow, staged: boolean) => {
    const seq = diffSeq.current + 1;
    diffSeq.current = seq;
    setSelected({ path: row.entry.path, staged });
    setDiff(null);
    setDiffError("");
    setDiffLoading(true);
    try {
      let text = await loadDiff(row.entry.path, staged);
      if (!text && !staged && row.entry.xy === "??") {
        const file = await readFile(row.entry.path);
        text = asAddedDiff(file.content);
      }
      if (diffSeq.current !== seq) return;
      setDiff({
        title: row.entry.path,
        subtitle: staged ? t("已暂存", "Staged") : t("工作区", "Working tree"),
        text,
      });
    } catch (reason) {
      if (diffSeq.current !== seq) return;
      setDiffError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (diffSeq.current === seq) setDiffLoading(false);
    }
  };

  const openCommit = async (entry: GitLogEntry) => {
    const seq = diffSeq.current + 1;
    diffSeq.current = seq;
    setDiff(null);
    setDiffError("");
    setDiffLoading(true);
    try {
      const text = await showCommit(entry.hash);
      if (diffSeq.current !== seq) return;
      setDiff({
        title: entry.subject || entry.hash,
        subtitle: `${entry.hash} · ${entry.author} · ${entry.date.slice(0, 16)}`,
        text,
        commit: true,
      });
    } catch (reason) {
      if (diffSeq.current !== seq) return;
      setDiffError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (diffSeq.current === seq) setDiffLoading(false);
    }
  };

  const run = async (fn: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    const ok = await fn();
    setBusy(false);
    if (ok) {
      setDiff(null);
      setSelected(null);
    }
  };

  const askDiscard = async (row: ChangeRow) => {
    if (row.entry.xy === "??") return;
    const ok = await askConfirm({
      title: t("丢弃工作区改动", "Discard changes"),
      message: t(`「${row.entry.path}」的未暂存改动会被丢弃，此操作不可撤销。`, `Unstaged changes in "${row.entry.path}" will be discarded. This cannot be undone.`),
      danger: true,
      confirmText: t("丢弃", "Discard"),
    });
    if (ok) void run(() => discard(row.entry.path));
  };

  const askCheckout = async (branch: string) => {
    if (!branch || branch === git?.branch) return;
    const ok = await askConfirm({
      title: t("切换分支", "Switch branch"),
      message: t(`切换到「${branch}」？工作区未提交的改动会跟着带过去。`, `Switch to "${branch}"? Uncommitted changes come along.`),
      confirmText: t("切换", "Switch"),
    });
    if (ok) void run(() => checkout(branch));
  };

  // 只拉不推：推送是对外动作，交给用户自己在终端里做（见 AGENTS 的 Git 约定）。
  // 拉取不再二次确认：它就是右上角那颗同步图标的本意，失败时面板顶部的错误条
  // 会给原因（ff 冲突、网络、没配上游），成功则安静刷新，不弹任何提示。
  const pullRemote = () => {
    if (!git?.upstream || git.detached || busy) return;
    void run(() => pull());
  };

  const submit = async () => {
    const text = message.trim();
    if (!text || stagedCount === 0 || groups.conflicts.length > 0 || busy) return;
    setBusy(true);
    const ok = await commit(text);
    setBusy(false);
    if (ok) setMessage("");
  };

  const backFromDiff = () => {
    diffSeq.current += 1;
    setDiff(null);
    setDiffError("");
    setSelected(null);
  };

  const repo = git?.is_repo === true;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 工作区里并排放着好几个仓库时给一排切换 chip；只有一个仓库就不用占这行。 */}
      {repos.length > 1 && (
        <div className="dsh-scroll flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2 py-1.5">
          {repos.map((r) => (
            <button
              key={r.root}
              type="button"
              aria-pressed={r.root === repoRoot}
              onClick={() => {
                diffSeq.current += 1;
                setDiff(null);
                setSelected(null);
                setMode("changes");
                void selectRepo(r.root);
              }}
              title={r.path || t("工作区根", "Workspace root")}
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
                r.root === repoRoot ? "bg-panel-strong font-medium text-ink" : "text-muted hover:bg-black/[0.03] hover:text-ink"
              }`}
            >
              {r.name}
            </button>
          ))}
        </div>
      )}

      <div className="flex h-[42px] shrink-0 items-center gap-1 border-b border-line px-2">
        <button
          type="button"
          onClick={() => {
            diffSeq.current += 1;
            setMode("changes");
            setDiff(null);
          }}
          aria-pressed={mode === "changes" && !diff?.commit}
          className={`rounded-md px-2 py-1 text-[11.5px] ${
            mode === "changes" && !diff?.commit ? "bg-panel-strong font-medium text-ink" : "text-muted hover:text-ink"
          }`}
        >
          {t("变更", "Changes")}
          {totalCount > 0 && (
            <span className="ml-1 rounded-full bg-brand/12 px-1.5 text-[10px] text-brand">{totalCount}</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => {
            diffSeq.current += 1;
            setMode("history");
            setDiff(null);
          }}
          aria-pressed={mode === "history"}
          className={`rounded-md px-2 py-1 text-[11.5px] ${
            mode === "history" ? "bg-panel-strong font-medium text-ink" : "text-muted hover:text-ink"
          }`}
        >
          {t("历史", "History")}
        </button>
        <button
          type="button"
          onClick={pullRemote}
          disabled={busy || !git?.upstream || git?.detached || groups.conflicts.length > 0}
          className="ml-auto rounded-md p-1.5 text-muted hover:bg-black/5 hover:text-ink disabled:opacity-35"
          aria-label={t("拉取", "Pull")}
          aria-busy={busy || undefined}
          title={!git?.upstream ? t("没有上游分支，无法拉取", "No upstream branch to pull") : t("拉取", "Pull")}
        >
          <IconSync size={14} />
        </button>
        <button
          type="button"
          onClick={() => {
            void refreshGit();
            if (mode === "history") void loadLog();
          }}
          className="rounded-md p-1.5 text-muted hover:bg-black/5 hover:text-ink"
          aria-label={t("刷新 Git 状态", "Refresh git status")}
          title={t("刷新", "Refresh")}
        >
          <IconRetry size={14} className={gitLoading ? "opacity-50" : undefined} />
        </button>
      </div>

      {(gitError || actionError) && (
        <div className="flex items-start gap-2 border-b border-line bg-danger/[0.05] px-2 py-1.5 text-[10.5px] leading-relaxed text-danger">
          <span className="min-w-0 flex-1 break-words">{gitError || actionError}</span>
          {actionError && (
            <button type="button" onClick={clearActionError} className="shrink-0 font-medium hover:underline">
              {t("知道了", "Dismiss")}
            </button>
          )}
        </div>
      )}

      {diff || diffLoading || diffError ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {diffLoading && <p className="px-3 py-3 text-[11.5px] text-faint">{t("读取差异…", "Loading diff…")}</p>}
          {diffError && (
            <div className="m-3 rounded-lg border border-danger/25 bg-danger/[0.06] px-2.5 py-2 text-[11.5px] leading-relaxed text-danger">
              {diffError}
            </div>
          )}
          {diff && !diffLoading && (
            <DiffView
              state={diff}
              busy={busy}
              wrap={wrap}
              onToggleWrap={() => setWrap((v) => !v)}
              onBack={backFromDiff}
            />
          )}
          {!diff && !diffLoading && diffError && (
            <button
              type="button"
              onClick={backFromDiff}
              className="mx-3 mt-2 self-start rounded-md border border-line-strong px-2 py-1 text-[11px] text-ink hover:bg-panel-strong"
            >
              {t("返回", "Back")}
            </button>
          )}
        </div>
      ) : (
        <>
          {mode === "changes" && repo && (
            <div className="shrink-0 border-b border-line p-2">
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void submit();
                  }
                }}
                rows={3}
                placeholder={t("提交信息（Ctrl/⌘ + Enter 提交）", "Commit message (Ctrl/⌘ + Enter)")}
                className="w-full resize-y rounded-lg border border-line-strong bg-canvas px-2 py-1.5 font-mono text-[11.5px] leading-relaxed text-ink outline-none placeholder:text-faint focus:border-brand/60"
              />
              <div className="mt-1.5 flex items-center gap-2">
                <span className="min-w-0 truncate text-[10px] text-faint">
                  {groups.conflicts.length > 0
                    ? t("先解决合并冲突", "Resolve conflicts first")
                    : stagedCount > 0
                      ? t(`${stagedCount} 个文件已暂存`, `${stagedCount} staged`)
                      : t("暂存文件后才能提交", "Stage files to commit")}
                </span>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={busy || !message.trim() || stagedCount === 0 || groups.conflicts.length > 0}
                  className="ml-auto shrink-0 rounded-lg bg-ink px-3 py-1.5 text-[11.5px] font-medium text-canvas hover:opacity-90 disabled:opacity-35"
                >
                  {busy ? t("提交中…", "Committing…") : t("提交", "Commit")}
                </button>
              </div>
            </div>
          )}

          <div className="dsh-scroll min-h-0 flex-1 overflow-y-auto">
            {!git && gitLoading && <p className="px-3 py-3 text-[11.5px] text-faint">{t("读取 Git 状态…", "Loading git status…")}</p>}
            {git && !repo && (
              <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-panel-strong text-muted">
                  <IconGitBranch size={20} />
                </span>
                <p className="text-[12.5px] font-medium text-ink">{t("不是 Git 仓库", "Not a Git repository")}</p>
                <p className="text-[11px] leading-relaxed text-muted">
                  {t("在终端里执行 git init 后，点右上角刷新。", "Run git init in the terminal, then refresh.")}
                </p>
              </div>
            )}
            {repo && mode === "changes" && (
              <>
                {totalCount === 0 && (
                  <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
                    <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-panel-strong text-ok">
                      <IconGitCommit size={20} />
                    </span>
                    <p className="text-[12.5px] font-medium text-ink">{t("工作区干净", "Working tree clean")}</p>
                    <p className="text-[11px] text-muted">{t("没有未提交的改动。", "No uncommitted changes.")}</p>
                  </div>
                )}
                {groups.conflicts.length > 0 && (
                  <ChangeGroup
                    title={t("合并冲突", "Merge")}
                    rows={groups.conflicts}
                    side="conflict"
                    busy={busy}
                    active={selected}
                    onOpen={(row) => void openChange(row, false)}
                  />
                )}
                {groups.staged.length > 0 && (
                  <ChangeGroup
                    title={t("已暂存", "Staged")}
                    rows={groups.staged}
                    side="staged"
                    busy={busy}
                    active={selected}
                    onOpen={(row) => void openChange(row, true)}
                    onStageAll={undefined}
                    onUnstageAll={() => void run(() => unstage())}
                  />
                )}
                {groups.unstaged.length > 0 && (
                  <ChangeGroup
                    title={t("更改", "Changes")}
                    rows={groups.unstaged}
                    side="unstaged"
                    busy={busy}
                    active={selected}
                    onOpen={(row) => void openChange(row, false)}
                    onStage={(path) => void run(() => stage(path))}
                    onDiscard={askDiscard}
                    onStageAll={groups.conflicts.length === 0 ? () => void run(() => stage()) : undefined}
                  />
                )}
                {git?.truncated && (
                  <p className="px-3 py-2 text-[10.5px] text-warn">{t("改动过多，仅显示前 2000 条。", "Too many changes; showing first 2000.")}</p>
                )}
              </>
            )}
            {repo && mode === "history" && (
              <HistoryList
                entries={log}
                loading={logLoading}
                error={logError}
                onOpen={(entry) => void openCommit(entry)}
              />
            )}
          </div>
        </>
      )}

      {repo && !diff && (
        <div className="shrink-0 border-t border-line px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <IconGitBranch size={13} className="shrink-0 text-muted" />
            {/* 分支胶囊按内容收窄：整行拉满会把下面一行挤成两截，也点不出「这是个下拉」。 */}
            <span className="min-w-0 max-w-[10rem]">
              <Select
                variant="ghost"
                className="max-w-full text-[11.5px] text-ink"
                ariaLabel={t("切换分支", "Switch branch")}
                value={git?.branch ?? ""}
                disabled={busy || !branches || branches.names.length === 0}
                placeholder={git?.detached ? t("分离 HEAD", "detached HEAD") : t("选择分支", "Select branch")}
                onChange={(next) => void askCheckout(next)}
                options={(branches?.names ?? (git?.branch ? [git.branch] : [])).map((name) => ({ value: name, label: name }))}
              />
            </span>
            <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">
              {git?.ahead ? `↑${git.ahead}` : ""} {git?.behind ? `↓${git.behind}` : ""}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

interface GroupProps {
  title: string;
  rows: ChangeRow[];
  side: "conflict" | "staged" | "unstaged";
  busy: boolean;
  active: { path: string; staged: boolean } | null;
  onOpen: (row: ChangeRow) => void;
  onStage?: (path: string) => void;
  onUnstage?: (path: string) => void;
  onDiscard?: (row: ChangeRow) => void;
  onStageAll?: () => void;
  onUnstageAll?: () => void;
}

function ChangeGroup({ title, rows, side, busy, active, onOpen, onStage, onUnstage, onDiscard, onStageAll, onUnstageAll }: GroupProps) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const additions = rows.reduce((n, row) => n + (side === "staged" ? row.entry.staged?.additions ?? 0 : row.entry.unstaged?.additions ?? 0), 0);
  const deletions = rows.reduce((n, row) => n + (side === "staged" ? row.entry.staged?.deletions ?? 0 : row.entry.unstaged?.deletions ?? 0), 0);

  return (
    <section className="border-b border-line/70">
      <div className="sticky top-0 z-10 flex items-center gap-1 bg-canvas/95 px-2 py-1.5 backdrop-blur">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={open}
        >
          <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</span>
          <span className="shrink-0 rounded-full bg-panel-strong px-1.5 text-[10px] text-muted">{rows.length}</span>
          {side !== "conflict" && (additions > 0 || deletions > 0) && (
            <span className="shrink-0 font-mono text-[9.5px]">
              <LineCounts counts={{ additions, deletions }} />
            </span>
          )}
        </button>
        {side === "staged" && onUnstageAll && (
          <button
            type="button"
            disabled={busy}
            onClick={onUnstageAll}
            className="rounded p-1 text-muted hover:bg-black/5 hover:text-ink disabled:opacity-40"
            aria-label={t("全部取消暂存", "Unstage all")}
            title={t("全部取消暂存", "Unstage all")}
          >
            <IconMinus size={13} />
          </button>
        )}
        {side === "unstaged" && onStageAll && (
          <button
            type="button"
            disabled={busy}
            onClick={onStageAll}
            className="rounded p-1 text-muted hover:bg-black/5 hover:text-ink disabled:opacity-40"
            aria-label={t("全部暂存", "Stage all")}
            title={t("全部暂存", "Stage all")}
          >
            <IconPlus size={13} />
          </button>
        )}
      </div>
      {open && (
        <div className="pb-1">
          {rows.map((row) => {
            const counts = side === "staged" ? row.entry.staged : row.entry.unstaged;
            const isActive = active?.path === row.entry.path && active?.staged === (side === "staged");
            const dir = row.entry.path.includes("/") ? row.entry.path.slice(0, row.entry.path.lastIndexOf("/") + 1) : "";
            const name = dir ? row.entry.path.slice(dir.length) : row.entry.path;
            return (
              <div
                key={`${side}:${row.entry.path}`}
                className={`group flex items-center gap-1 px-1 ${isActive ? "bg-brand/[0.07]" : ""}`}
              >
                <button
                  type="button"
                  onClick={() => onOpen(row)}
                  title={row.entry.path}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-[3px] text-left hover:bg-black/[0.035]"
                >
                  <FileIcon name={name} size={13} className="shrink-0" />
                  <span
                    className={`inline-flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-[4px] border border-line-strong bg-panel font-mono text-[10px] font-semibold ${TONE_TEXT[row.status.tone]}`}
                    aria-hidden="true"
                  >
                    {row.status.letter}
                  </span>
                  <span className="min-w-0 truncate text-[11.5px] text-ink-2">
                    {dir && <span className="text-faint">{dir}</span>}
                    <span className="text-ink">{name}</span>
                  </span>
                  {counts && (
                    <span className="ml-auto shrink-0 font-mono text-[9.5px]">
                      <LineCounts counts={counts} />
                    </span>
                  )}
                </button>
                <div className="flex shrink-0 items-center opacity-100 transition md:opacity-0 md:group-hover:opacity-100 md:group-has-focus-visible:opacity-100">
                  {side === "staged" && onUnstage && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onUnstage(row.entry.path)}
                      className="rounded p-1 text-muted hover:bg-black/5 hover:text-ink disabled:opacity-40"
                      aria-label={`${t("取消暂存", "Unstage")} ${row.entry.path}`}
                      title={t("取消暂存", "Unstage")}
                    >
                      <IconMinus size={12} />
                    </button>
                  )}
                  {side === "unstaged" && onStage && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onStage(row.entry.path)}
                      className="rounded p-1 text-muted hover:bg-black/5 hover:text-ink disabled:opacity-40"
                      aria-label={`${t("暂存", "Stage")} ${row.entry.path}`}
                      title={t("暂存", "Stage")}
                    >
                      <IconPlus size={12} />
                    </button>
                  )}
                  {side === "unstaged" && onDiscard && row.entry.xy !== "??" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onDiscard(row)}
                      className="rounded p-1 text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                      aria-label={`${t("丢弃改动", "Discard changes")} ${row.entry.path}`}
                      title={t("丢弃改动", "Discard changes")}
                    >
                      <IconTrash size={12} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function HistoryList({ entries, loading, error, onOpen }: { entries: GitLogEntry[]; loading: boolean; error: string; onOpen: (entry: GitLogEntry) => void }) {
  const t = useT();
  if (loading && entries.length === 0) {
    return <p className="px-3 py-3 text-[11.5px] text-faint">{t("读取提交历史…", "Loading history…")}</p>;
  }
  if (error && entries.length === 0) {
    return <p className="px-3 py-3 text-[11px] leading-relaxed text-danger">{error}</p>;
  }
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
        <IconGitCommit size={22} className="text-faint" />
        <p className="text-[11.5px] text-muted">{t("还没有提交。", "No commits yet.")}</p>
      </div>
    );
  }
  return (
    <div className="py-1">
      {entries.map((entry) => (
        <button
          key={entry.hash_full || entry.hash}
          type="button"
          onClick={() => onOpen(entry)}
          title={`${entry.hash} ${entry.subject}`}
          className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left hover:bg-black/[0.035]"
        >
          <span className="mt-[3px] shrink-0 rounded bg-panel-strong px-1 py-0.5 font-mono text-[9.5px] text-muted">
            {entry.hash}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11.5px] text-ink">{entry.subject || t("（无提交信息）", "(no subject)")}</span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[9.5px] text-faint">
              <span className="truncate">{entry.author}</span>
              <span className="shrink-0">·</span>
              <span className="shrink-0">{entry.date.slice(0, 16)}</span>
              {entry.refs && (
                <span className="min-w-0 truncate rounded-full bg-brand/10 px-1.5 text-brand">{refsLabel(entry.refs)}</span>
              )}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

interface DiffViewProps {
  state: DiffViewState;
  busy: boolean;
  /** 长行是否按面板宽度折行（默认开）。 */
  wrap: boolean;
  onToggleWrap: () => void;
  onBack: () => void;
}

function DiffView({ state, busy, wrap, onToggleWrap, onBack }: DiffViewProps) {
  const t = useT();
  const lines = useMemo(() => parseUnifiedDiff(state.text), [state.text]);
  const stat = useMemo(() => diffStat(lines), [lines]);
  const shown = lines.slice(0, MAX_DIFF_LINES);
  // 折行：`whitespace-pre-wrap` 保住缩进、`[overflow-wrap:anywhere]` 让无空格的长串
  // （base64 / minified js / 长路径）也能断；容器不能再 `min-w-max`，否则整块按最长行
  // 撑开，横向滚动条一出现折行就失效了——那是「看起来开了却没生效」的来源。
  const codeWrap = wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start gap-1 border-b border-line px-2 py-1.5">
        <button
          type="button"
          onClick={onBack}
          className="mt-0.5 rounded-md p-1 text-muted hover:bg-black/5 hover:text-ink"
          aria-label={t("返回", "Back")}
          title={t("返回", "Back")}
        >
          <IconChevronLeft size={15} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-1.5 truncate text-[11.5px] font-medium text-ink" title={state.title}>
            <FileIcon name={state.title} size={13} className="shrink-0" />
            <span className="truncate">{state.title}</span>
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-[9.5px] text-faint">
            <span className="truncate">{state.subtitle}</span>
            {lines.length > 0 && (
              <span className="shrink-0 font-mono">
                <LineCounts counts={{ additions: stat.added, deletions: stat.removed }} />
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onToggleWrap}
            className={`rounded-md p-1.5 hover:bg-black/5 ${wrap ? "text-brand" : "text-muted hover:text-ink"}`}
            aria-label={wrap ? t("关闭自动换行", "Disable word wrap") : t("开启自动换行", "Enable word wrap")}
            aria-pressed={wrap}
            title={wrap ? t("关闭自动换行", "Disable word wrap") : t("开启自动换行", "Enable word wrap")}
          >
            <IconWrap size={14} />
          </button>
        </div>
      </div>
      <div className="dsh-scroll min-h-0 flex-1 overflow-auto bg-canvas">
        {shown.length === 0 ? (
          <p className="px-3 py-3 text-[11.5px] text-faint">{t("没有文本差异（可能是二进制文件或改动已暂存）。", "No textual diff (binary file or already staged).")}</p>
        ) : (
          <div className={`py-1 font-mono text-[11px] leading-[1.55] ${wrap ? "" : "min-w-max"}`}>
            {shown.map((line, i) => {
              if (line.kind === "hunk") {
                return (
                  <div key={i} className={`${codeWrap} bg-brand/[0.07] px-2 py-0.5 text-[10.5px] text-brand`}>
                    {line.text}
                  </div>
                );
              }
              if (line.kind === "meta") {
                return (
                  <div key={i} className={`${codeWrap} px-2 py-0.5 text-[10px] text-faint`}>
                    {line.text}
                  </div>
                );
              }
              const add = line.kind === "add";
              const del = line.kind === "del";
              return (
                <div
                  key={i}
                  className={`flex ${add ? "bg-emerald-500/[0.09]" : del ? "bg-rose-500/[0.09]" : ""}`}
                >
                  <span className="w-9 shrink-0 select-none pr-1.5 text-right text-[9.5px] text-faint">{line.oldNo ?? ""}</span>
                  <span className="w-9 shrink-0 select-none pr-1.5 text-right text-[9.5px] text-faint">{line.newNo ?? ""}</span>
                  <span className={`w-3 shrink-0 select-none text-center ${add ? "text-ok" : del ? "text-danger" : "text-faint"}`}>
                    {add ? "+" : del ? "−" : " "}
                  </span>
                  <span className={`${codeWrap} pr-3 text-ink-2 ${wrap ? "min-w-0 flex-1" : ""}`}>{line.text || " "}</span>
                </div>
              );
            })}
          </div>
        )}
        {lines.length > MAX_DIFF_LINES && (
          <p className="px-3 py-2 text-[10.5px] text-warn">
            {t(`差异过大，仅显示前 ${MAX_DIFF_LINES} 行。`, `Diff too large; showing first ${MAX_DIFF_LINES} lines.`)}
          </p>
        )}
        {busy && <p className="px-3 py-1 text-[10px] text-faint">{t("正在更新…", "Updating…")}</p>}
      </div>
    </div>
  );
}
