import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import type { ConversationInfo, WorkspaceEntry } from "../../transport/types";
import { baseName, conversationTitle, relativeTime, stateLabel } from "../../lib/labels";
import { useLocale, useT } from "../../lib/i18n";
import { belongs } from "../../lib/conversations";
import {
  BrandMark,
  IconArchive,
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconClose,
  IconFolder,
  IconFolderPlus,
  IconHistory,
  IconMore,
  IconPanel,
  IconPencil,
  IconPlus,
  IconSearch,
  IconSettings,
  IconStop,
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
  conversations: ConversationInfo[];
}

interface MenuState {
  id: string;
  x: number;
  y: number;
}

export function Sidebar({ onClose, collapsed = false, onToggleCollapse, onOpenSettings, onAddWorkspace, onOpenHistory }: Props) {
  const t = useT();
  const locale = useLocale();
  const workspaces = useAppStore((s) => s.workspaces);
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const conversations = useAppStore((s) => s.conversations);
  const activeId = useAppStore((s) => s.activeId);
  const items = useAppStore((s) => s.items);
  const states = useAppStore((s) => s.states);
  const starting = useAppStore((s) => s.starting);
  const info = useAppStore((s) => s.info);
  const switchWorkspace = useAppStore((s) => s.switchWorkspace);
  const openConversation = useAppStore((s) => s.openConversation);
  const createSession = useAppStore((s) => s.createSession);
  const closeSession = useAppStore((s) => s.closeSession);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const renameConversation = useAppStore((s) => s.renameConversation);
  const archiveConversation = useAppStore((s) => s.archiveConversation);
  const deleteConversation = useAppStore((s) => s.deleteConversation);

  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(currentWorkspace ? [currentWorkspace] : []));
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    if (!currentWorkspace) return;
    setExpanded((prev) => (prev.has(currentWorkspace) ? prev : new Set(prev).add(currentWorkspace)));
  }, [currentWorkspace]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-conv-menu]")) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const archivedCount = conversations.filter((c) => c.archived).length;

  const groups = useMemo<WorkspaceGroup[]>(() => {
    const result: WorkspaceGroup[] = workspaces.map((w) => ({
      path: w.path,
      name: w.name || baseName(w.path),
      exists: w.exists,
      workspace: w,
      conversations: [],
    }));
    const others: ConversationInfo[] = [];
    for (const c of conversations) {
      if (!showArchived && c.archived) continue;
      const group = result
        .filter((g) => belongs(c.cwd, g.path))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (group) group.conversations.push(c);
      else others.push(c);
    }
    if (others.length > 0) {
      result.push({ path: "__other__", name: t("其他对话", "Other conversations"), exists: true, workspace: null, conversations: others });
    }
    for (const g of result) {
      g.conversations.sort((a, b) => (b.last_active ?? "").localeCompare(a.last_active ?? ""));
    }
    const q = query.trim().toLowerCase();
    if (!q) return result;
    return result
      .map((g) => ({
        ...g,
        conversations: g.conversations.filter(
          (c) =>
            conversationTitle(c.title, items[c.id], locale).toLowerCase().includes(q) ||
            c.cwd.toLowerCase().includes(q) ||
            g.name.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.conversations.length > 0 || g.name.toLowerCase().includes(q));
  }, [workspaces, conversations, showArchived, query, items, locale, t]);

  const activeConn = activeId ? (states[activeId] ?? "idle") : "idle";
  const connLabel =
    activeConn === "busy"
      ? t("运行中", "Running")
      : activeConn === "ready"
        ? t("已连接", "Connected")
        : activeConn === "starting"
          ? t("启动中", "Starting")
          : t("未连接", "Not connected");
  const connTone = activeConn === "busy" || activeConn === "starting" ? "bg-warn" : activeConn === "ready" ? "bg-ok" : "bg-faint";

  const startNewChat = () => {
    if (starting) return;
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
    if (!window.confirm(t(`移除授权目录「${g.path}」？\n移除后不能再在该目录新建对话。`, `Remove authorized directory "${g.path}"?\nYou cannot start new conversations there afterwards.`))) return;
    await removeWorkspace(g.path);
  };

  const openOne = (c: ConversationInfo) => {
    setMenu(null);
    void openConversation(c.id);
    onClose?.();
  };

  const titleOf = (c: ConversationInfo) => conversationTitle(c.title, items[c.id], locale);

  const askRename = (c: ConversationInfo) => {
    setMenu(null);
    const next = window.prompt(t("重命名对话", "Rename conversation"), titleOf(c));
    if (next === null) return;
    void renameConversation(c.id, next.trim());
  };

  const askArchive = (c: ConversationInfo) => {
    setMenu(null);
    void archiveConversation(c.id, !c.archived);
  };

  const askDelete = (c: ConversationInfo) => {
    setMenu(null);
    if (!window.confirm(t(`删除对话「${titleOf(c)}」？\n会从列表移除并结束运行中的进程，转录文件仍保留。`, `Delete conversation "${titleOf(c)}"?\nIt is removed from the list and any running process is stopped; the transcript file is kept.`))) return;
    void deleteConversation(c.id);
  };

  const askStop = (c: ConversationInfo) => {
    setMenu(null);
    if (!window.confirm(t(`结束对话「${titleOf(c)}」的 claude 进程？\n对话仍保留，下次点击会恢复。`, `Stop the claude process for "${titleOf(c)}"?\nThe conversation stays and can be resumed later.`))) return;
    void closeSession(c.id);
  };

  const openMenu = (e: React.MouseEvent<HTMLButtonElement>, c: ConversationInfo) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu({
      id: c.id,
      x: Math.max(8, Math.min(rect.right - 168, window.innerWidth - 176)),
      y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 210)),
    });
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
          disabled={starting}
          className="mt-4 flex h-9 w-9 items-center justify-center rounded-full border border-line-strong bg-canvas text-ink hover:bg-panel-strong disabled:opacity-40"
          aria-label={t("新对话", "New conversation")}
          title={t("新对话", "New conversation")}
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

  const menuConv = menu ? conversations.find((c) => c.id === menu.id) ?? null : null;

  return (
    <aside className="safe-top flex h-full w-[280px] shrink-0 flex-col border-r border-line bg-panel md:pt-0">
      <div className="flex h-[58px] shrink-0 items-center gap-2 px-3">
        <button type="button" onClick={startNewChat} className="flex min-w-0 items-center gap-2 text-left" aria-label={t("新对话", "New conversation")}>
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
          disabled={starting}
          className="flex w-full items-center justify-center gap-2 rounded-[10px] border border-line-strong bg-canvas py-2 text-[13px] font-medium text-ink transition hover:bg-panel-strong disabled:opacity-50"
        >
          <IconPlus size={15} />
          {starting ? t("正在启动…", "Starting…") : t("新对话", "New conversation")}
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
            aria-label={t("搜索对话", "Search conversations")}
            title={t("搜索", "Search")}
          >
            <IconSearch size={15} />
          </button>
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className={`rounded-md p-1.5 hover:bg-black/5 ${showArchived ? "text-brand" : "text-muted hover:text-ink"}`}
            aria-label={showArchived ? t("隐藏已归档", "Hide archived") : t("显示已归档", "Show archived")}
            aria-pressed={showArchived}
            title={showArchived ? t("隐藏已归档", "Hide archived") : t(`显示已归档${archivedCount ? `（${archivedCount}）` : ""}`, `Show archived${archivedCount ? ` (${archivedCount})` : ""}`)}
          >
            <IconArchive size={15} />
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
            placeholder={t("搜索工作区或对话", "Search workspaces or conversations")}
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
                  title={g.path === "__other__" ? t("不在授权目录内的对话", "Conversations outside authorized directories") : g.path}
                >
                  {g.path === "__other__" ? <IconTerminal size={15} className="shrink-0 text-muted" /> : <IconFolder size={15} className="shrink-0 text-muted" />}
                  <span className="truncate text-[12.5px] font-medium">{g.name}</span>
                  {!g.exists && g.path !== "__other__" && <span className="shrink-0 text-[10px] text-warn">{t("不可用", "Missing")}</span>}
                  {g.conversations.length > 0 && (
                    <span className="ml-auto shrink-0 rounded-full bg-black/[0.06] px-1.5 text-[10px] text-muted">{g.conversations.length}</span>
                  )}
                </button>
                {g.path !== "__other__" && (
                  <>
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.path)}
                      className="rounded-md p-1 text-muted hover:bg-black/5 hover:text-ink"
                      aria-label={open ? t("收起对话", "Collapse conversations") : t("展开对话", "Expand conversations")}
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
                  {g.conversations.length === 0 && (
                    <p className="px-2 py-1.5 text-[11px] text-faint">
                      {isCurrent && starting ? t("正在启动 Claude…", "Starting Claude…") : t("暂无对话", "No conversations")}
                    </p>
                  )}
                  {g.conversations.map((c) => {
                    const active = c.id === activeId;
                    const liveState = c.live ? (states[c.id] ?? c.state ?? "ready") : "";
                    const dot =
                      liveState === "busy" ? "bg-warn" : liveState === "ready" ? "bg-ok" : liveState === "starting" ? "bg-warn" : "bg-faint";
                    return (
                      <div key={c.id} className="group/session flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => openOne(c)}
                          className={`side-row min-w-0 flex-1 ${c.archived ? "opacity-60" : ""}`}
                          data-active={active}
                          title={`${c.cwd}\n${c.live ? stateLabel(liveState, locale) : t("未运行（点击恢复）", "Not running (click to resume)")}`}
                        >
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
                          <span className={`truncate text-[12px] ${active ? "text-ink" : "text-ink-2"}`}>{titleOf(c)}</span>
                          {c.archived && (
                            <span className="shrink-0 rounded-full bg-black/[0.06] px-1 text-[9px] text-muted">{t("归档", "Archived")}</span>
                          )}
                          <span className="ml-auto shrink-0 text-[10px] text-faint">{relativeTime(c.last_active, Date.now(), locale)}</span>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => openMenu(e, c)}
                          className="rounded-md p-1 text-muted opacity-100 transition hover:bg-black/5 hover:text-ink md:opacity-0 md:group-hover/session:opacity-100 md:focus:opacity-100"
                          aria-label={`${t("管理对话", "Manage conversation")} ${titleOf(c)}`}
                          aria-haspopup="menu"
                          title={t("管理对话", "Manage conversation")}
                        >
                          <IconMore size={14} />
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

      {menu && menuConv && (
        <div
          data-conv-menu
          role="menu"
          className="fixed z-[70] w-[168px] rounded-xl border border-line bg-canvas p-1 shadow-soft"
          style={{ left: menu.x, top: menu.y }}
        >
          <button type="button" role="menuitem" onClick={() => askRename(menuConv)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] text-ink hover:bg-panel-strong">
            <IconPencil size={13} className="text-muted" />
            {t("重命名", "Rename")}
          </button>
          <button type="button" role="menuitem" onClick={() => askArchive(menuConv)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] text-ink hover:bg-panel-strong">
            <IconArchive size={13} className="text-muted" />
            {menuConv.archived ? t("取消归档", "Unarchive") : t("归档", "Archive")}
          </button>
          {menuConv.live && (
            <button type="button" role="menuitem" onClick={() => askStop(menuConv)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] text-ink hover:bg-panel-strong">
              <IconStop size={13} className="text-muted" />
              {t("结束进程", "Stop process")}
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => askDelete(menuConv)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] text-danger hover:bg-danger/[0.06]">
            <IconTrash size={13} />
            {t("删除", "Delete")}
          </button>
        </div>
      )}
    </aside>
  );
}
