import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import type { SessionInfo, WorkspaceEntry } from "../../transport/types";
import { baseName, relativeTime, sessionTitle, stateLabel } from "../../lib/labels";
import { useLocale, useT } from "../../lib/i18n";
import {
  BrandMark,
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconClose,
  IconFolder,
  IconFolderPlus,
  IconHistory,
  IconPanel,
  IconPlus,
  IconSearch,
  IconSettings,
  IconTerminal,
  IconTrash,
} from "../common/Icons";

interface Props {
  /** 移动端抽屉关闭；桌面侧栏不传。 */
  onClose?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onOpenSettings: () => void;
  onAddWorkspace: () => void;
  onOpenHistory: () => void;
}

interface WorkspaceGroup {
  path: string;
  name: string;
  exists: boolean;
  workspace: WorkspaceEntry | null;
  sessions: SessionInfo[];
}

/** 判断会话是否属于某个工作区（工作区本身或它的子目录）。 */
function belongs(cwd: string, workspacePath: string): boolean {
  return cwd === workspacePath || cwd.startsWith(`${workspacePath}/`);
}

export function Sidebar({ onClose, collapsed = false, onToggleCollapse, onOpenSettings, onAddWorkspace, onOpenHistory }: Props) {
  const t = useT();
  const locale = useLocale();
  const workspaces = useAppStore((s) => s.workspaces);
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const sessions = useAppStore((s) => s.sessions);
  const activeId = useAppStore((s) => s.activeId);
  const items = useAppStore((s) => s.items);
  const states = useAppStore((s) => s.states);
  const conns = useAppStore((s) => s.conns);
  const starting = useAppStore((s) => s.starting);
  const info = useAppStore((s) => s.info);
  const switchWorkspace = useAppStore((s) => s.switchWorkspace);
  const setActive = useAppStore((s) => s.setActive);
  const createSession = useAppStore((s) => s.createSession);
  const closeSession = useAppStore((s) => s.closeSession);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);

  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(currentWorkspace ? [currentWorkspace] : []));

  useEffect(() => {
    if (!currentWorkspace) return;
    setExpanded((prev) => (prev.has(currentWorkspace) ? prev : new Set(prev).add(currentWorkspace)));
  }, [currentWorkspace]);

  const groups = useMemo<WorkspaceGroup[]>(() => {
    const result: WorkspaceGroup[] = workspaces.map((w) => ({
      path: w.path,
      name: w.name || baseName(w.path),
      exists: w.exists,
      workspace: w,
      sessions: [],
    }));
    const others: SessionInfo[] = [];
    for (const s of sessions) {
      // 嵌套工作区（/data 与 /data/proj）必须归到最长匹配，不能先命中父目录。
      const group = result
        .filter((g) => belongs(s.cwd, g.path))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (group) group.sessions.push(s);
      else others.push(s);
    }
    if (others.length > 0) {
      result.push({ path: "__other__", name: t("其他会话", "Other sessions"), exists: true, workspace: null, sessions: others });
    }
    const q = query.trim().toLowerCase();
    for (const g of result) {
      g.sessions.sort((a, b) => (b.last_active ?? "").localeCompare(a.last_active ?? ""));
    }
    if (!q) return result;
    return result
      .map((g) => ({
        ...g,
        sessions: g.sessions.filter(
          (s) =>
            sessionTitle(s.cwd, items[s.id], locale).toLowerCase().includes(q) ||
            s.cwd.toLowerCase().includes(q) ||
            g.name.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.sessions.length > 0 || g.name.toLowerCase().includes(q));
  }, [workspaces, sessions, query, items, locale]);

  const activeConn = activeId ? (conns[activeId]?.state ?? "idle") : "idle";
  const connLabel =
    activeConn === "open"
      ? t("已连接", "Connected")
      : activeConn === "reconnecting"
        ? t("重连中", "Reconnecting")
        : activeConn === "connecting"
          ? t("连接中", "Connecting")
          : activeConn === "closed"
            ? t("已断开", "Disconnected")
            : t("未连接", "Not connected");
  const connTone =
    activeConn === "open" ? "bg-ok" : activeConn === "reconnecting" || activeConn === "connecting" ? "bg-warn" : "bg-faint";

  const startNewChat = () => {
    if (!currentWorkspace) {
      onAddWorkspace();
      return;
    }
    void createSession(currentWorkspace);
    onClose?.();
  };

  const onWorkspaceClick = (g: WorkspaceGroup) => {
    if (g.path === "__other__") return;
    setExpanded((prev) => new Set(prev).add(g.path));
    void switchWorkspace(g.path);
    onClose?.();
  };

  const toggleGroup = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const askRemove = async (g: WorkspaceGroup) => {
    if (g.path === "__other__") return;
    if (!window.confirm(t(`移除授权目录「${g.path}」？\n移除后不能再在该目录新建会话。`, `Remove authorized directory "${g.path}"?\nYou cannot start new sessions there afterwards.`))) return;
    await removeWorkspace(g.path);
  };

  const closeOne = async (s: SessionInfo) => {
    if (!window.confirm(t(`关闭会话「${sessionTitle(s.cwd, items[s.id], locale)}」？\n会终止对应的 claude 进程。`, `Close session "${sessionTitle(s.cwd, items[s.id], locale)}"?\nThe claude process will be terminated.`))) return;
    await closeSession(s.id);
  };

  if (collapsed) {
    return (
      <aside className="flex h-full w-16 shrink-0 flex-col items-center border-r border-line bg-panel px-2 py-3">
        <button type="button" onClick={onToggleCollapse} className="rounded-lg p-1.5 text-ink hover:bg-black/5" aria-label={t("展开侧栏", "Expand sidebar")} title={t("展开侧栏", "Expand sidebar")}>
          <BrandMark size={26} />
        </button>
        <button
          type="button"
          onClick={startNewChat}
          className="mt-4 flex h-9 w-9 items-center justify-center rounded-full border border-line-strong bg-canvas text-ink hover:bg-panel-strong"
          aria-label={t("新对话", "New chat")}
          title={t("新对话", "New chat")}
        >
          <IconPlus size={17} />
        </button>
        <button
          type="button"
          onClick={onOpenHistory}
          className="mt-2 flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-black/5 hover:text-ink"
          aria-label={t("历史记录", "History")}
          title={t("历史记录", "History")}
        >
          <IconHistory size={18} />
        </button>
        <div className="flex-1" />
        <span className={`mb-3 h-2 w-2 rounded-full ${connTone}`} title={connLabel} />
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-black/5 hover:text-ink"
          aria-label={t("设置", "Settings")}
          title={t("设置", "Settings")}
        >
          <IconSettings size={18} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="safe-top flex h-full w-[280px] shrink-0 flex-col border-r border-line bg-panel md:pt-0">
      <div className="flex h-[58px] shrink-0 items-center gap-2 px-3">
        <button type="button" onClick={startNewChat} className="flex min-w-0 items-center gap-2 text-left" aria-label={t("新对话", "New chat")}>
          <BrandMark size={25} className="shrink-0 text-ink" />
          <span className="truncate text-[15px] font-semibold tracking-tight text-ink">Claude Code</span>
          <span className="shrink-0 rounded-[5px] border border-line-strong px-1 py-[1px] text-[9px] font-semibold tracking-wide text-muted">
            CONSOLE
          </span>
        </button>
        <button
          type="button"
          onClick={onClose ?? onToggleCollapse}
          className="ml-auto rounded-md p-1.5 text-muted hover:bg-black/5 hover:text-ink"
          aria-label={onClose ? t("关闭侧栏", "Close sidebar") : t("收起侧栏", "Collapse sidebar")}
          title={onClose ? t("关闭", "Close") : t("收起侧栏", "Collapse sidebar")}
        >
          {onClose ? <IconClose size={17} /> : <IconPanel size={17} />}
        </button>
      </div>

      <div className="px-3">
        <button
          type="button"
          onClick={startNewChat}
          className="flex w-full items-center justify-center gap-2 rounded-[10px] border border-line-strong bg-canvas py-2 text-[13px] font-medium text-ink transition hover:bg-panel-strong"
        >
          <IconPlus size={15} />
          {starting ? t("正在启动…", "Starting…") : t("新对话", "New chat")}
        </button>
      </div>

      <div className="mt-4 flex items-center gap-1 px-3">
        <span className="text-[12px] font-medium text-muted">{t("工作区", "Workspaces")}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => {
              setSearchOpen((v) => !v);
              if (searchOpen) setQuery("");
            }}
            className="rounded-md p-1.5 text-muted hover:bg-black/5 hover:text-ink"
            aria-label={t("搜索会话", "Search sessions")}
            title={t("搜索", "Search")}
          >
            <IconSearch size={15} />
          </button>
          <button
            type="button"
            onClick={onAddWorkspace}
            className="rounded-md p-1.5 text-muted hover:bg-black/5 hover:text-ink"
            aria-label={t("添加授权目录", "Add authorized directory")}
            title={t("添加授权目录", "Add authorized directory")}
          >
            <IconFolderPlus size={15} />
          </button>
        </div>
      </div>

      {searchOpen && (
        <div className="px-3 pb-1 pt-1.5">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("搜索工作区或会话", "Search workspaces or sessions")}
            className="w-full rounded-lg border border-line-strong bg-canvas px-2.5 py-1.5 text-[12px] outline-none placeholder:text-faint focus:border-brand/60"
          />
        </div>
      )}

      <div className="dsh-scroll mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {groups.length === 0 && (
          <button
            type="button"
            onClick={onAddWorkspace}
            className="mt-6 flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong px-4 py-6 text-center hover:bg-black/[0.02]"
          >
            <IconFolder size={22} className="text-faint" />
            <span className="text-[12px] font-medium text-ink">{t("添加授权目录", "Add authorized directory")}</span>
            <span className="text-[11px] leading-relaxed text-muted">{t("授权一个目录后，Claude 就能在其中工作。", "Authorize a directory and Claude can work there.")}</span>
          </button>
        )}

        {groups.map((g) => {
          const open = expanded.has(g.path) || Boolean(query.trim());
          const isCurrent = g.path === currentWorkspace;
          return (
            <div key={g.path} className="mb-1">
              <div className="group flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => onWorkspaceClick(g)}
                  disabled={g.path === "__other__" || !g.exists}
                  className={`side-row min-w-0 flex-1 ${isCurrent ? "text-ink" : "text-ink-2"} ${!g.exists ? "opacity-50" : ""}`}
                  data-active={isCurrent}
                  title={g.path === "__other__" ? t("不在授权目录内的运行会话", "Running sessions outside authorized directories") : g.path}
                >
                  {g.path === "__other__" ? <IconTerminal size={15} className="shrink-0 text-muted" /> : <IconFolder size={15} className="shrink-0 text-muted" />}
                  <span className="truncate text-[12.5px] font-medium">{g.name}</span>
                  {!g.exists && g.path !== "__other__" && <span className="shrink-0 text-[10px] text-warn">{t("不可用", "Missing")}</span>}
                  {g.sessions.length > 0 && (
                    <span className="ml-auto shrink-0 rounded-full bg-black/[0.06] px-1.5 text-[10px] text-muted">{g.sessions.length}</span>
                  )}
                </button>
                {g.path !== "__other__" && (
                  <>
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.path)}
                      className="rounded-md p-1 text-muted hover:bg-black/5 hover:text-ink"
                      aria-label={open ? t("收起会话", "Collapse sessions") : t("展开会话", "Expand sessions")}
                      title={open ? t("收起", "Collapse") : t("展开", "Expand")}
                    >
                      {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => void askRemove(g)}
                      className="rounded-md p-1 text-muted opacity-0 transition hover:bg-black/5 hover:text-danger group-hover:opacity-100"
                      aria-label={`${t("移除授权目录", "Remove authorized directory")} ${g.path}`}
                      title={t("移除授权目录", "Remove authorized directory")}
                    >
                      <IconTrash size={14} />
                    </button>
                  </>
                )}
              </div>

              {open && (
                <div className="mb-1 ml-2 border-l border-line pl-1.5">
                  {g.sessions.length === 0 && (
                    <p className="px-2 py-1.5 text-[11px] text-faint">
                      {isCurrent && starting ? t("正在启动 Claude…", "Starting Claude…") : t("暂无会话", "No sessions")}
                    </p>
                  )}
                  {g.sessions.map((s) => {
                    const state = states[s.id] ?? s.state;
                    const active = s.id === activeId;
                    return (
                      <div key={s.id} className="group/session flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => {
                            setActive(s.id);
                            onClose?.();
                          }}
                          className="side-row min-w-0 flex-1"
                          data-active={active}
                          title={`${s.cwd}\n${stateLabel(state, locale)}`}
                        >
                          <span
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                              state === "busy" ? "bg-warn" : state === "ready" ? "bg-ok" : state === "closed" ? "bg-danger" : "bg-faint"
                            }`}
                          />
                          <span className={`truncate text-[12px] ${active ? "text-ink" : "text-ink-2"}`}>
                            {sessionTitle(s.cwd, items[s.id], locale)}
                          </span>
                          <span className="ml-auto shrink-0 text-[10px] text-faint">{relativeTime(s.last_active ?? s.created_at, Date.now(), locale)}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void closeOne(s)}
                          className="rounded-md p-1 text-muted opacity-0 transition hover:bg-black/5 hover:text-danger group-hover/session:opacity-100"
                          aria-label={t("关闭会话", "Close session")}
                          title={t("关闭会话", "Close session")}
                        >
                          <IconClose size={13} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="shrink-0 border-t border-line px-2 pb-[calc(env(safe-area-inset-bottom,0px)+8px)] pt-2 md:pb-2">
        <button type="button" onClick={onOpenHistory} className="side-row text-muted hover:text-ink">
          <IconClock size={15} />
          <span className="text-[12px]">{t("历史记录", "History")}</span>
        </button>
        <button type="button" onClick={onOpenSettings} className="side-row text-muted hover:text-ink">
          <IconSettings size={15} />
          <span className="text-[12px]">{t("设置", "Settings")}</span>
          <span className="ml-auto flex items-center gap-1 text-[10px] text-faint">
            <span className={`h-1.5 w-1.5 rounded-full ${connTone}`} />
            {connLabel}
          </span>
        </button>
        <div className="flex items-center justify-between px-2 pt-1 text-[10px] text-faint">
          <span className="truncate font-mono">{currentWorkspace ? baseName(currentWorkspace) : t("未选择工作区", "No workspace")}</span>
          <span>v{info?.version ?? "-"}</span>
        </div>
      </div>
    </aside>
  );
}
