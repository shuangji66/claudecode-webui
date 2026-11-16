import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import type { ConversationInfo, WorkspaceEntry } from "../../transport/types";
import { baseName, conversationTitle, relativeTime, stateLabel } from "../../lib/labels";
import { useLocale, useT } from "../../lib/i18n";
import { belongs, conversationStatus } from "../../lib/conversations";
import { askConfirm, askPrompt } from "../common/SystemDialogs";
import { Menu, type MenuItem } from "../common/Menu";
import { StateDot } from "../common/StateDot";
import {
  BrandMark,
  IconArchive,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconDownload,
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
  /** 直接落到「设置 → 部署」，用于左下角的更新提示。 */
  onOpenDeploy?: () => void;
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
  anchor: HTMLElement;
}

interface WsMenuState {
  path: string;
  name: string;
  anchor: HTMLElement;
}

export function Sidebar({ onClose, collapsed = false, onToggleCollapse, onOpenSettings, onOpenDeploy, onAddWorkspace, onOpenHistory }: Props) {
  const t = useT();
  const claude = useAppStore((s) => s.claude);
  // 只有「已装过」才提示更新：一个版本都没装时走首屏的安装弹窗，
  // 否则左下角会同时出现两个入口，指向同一件事。
  const updateAvailable = Boolean(claude?.update_available && claude.active);
  const claudeLatest = claude?.latest ?? "";
  const locale = useLocale();
  const workspaces = useAppStore((s) => s.workspaces);
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const conversations = useAppStore((s) => s.conversations);
  const activeId = useAppStore((s) => s.activeId);
  const items = useAppStore((s) => s.items);
  const states = useAppStore((s) => s.states);
  const perms = useAppStore((s) => s.perms);
  const doneIds = useAppStore((s) => s.doneIds);
  const starting = useAppStore((s) => s.starting);
  const switchWorkspace = useAppStore((s) => s.switchWorkspace);
  const openConversation = useAppStore((s) => s.openConversation);
  const createSession = useAppStore((s) => s.createSession);
  const closeSession = useAppStore((s) => s.closeSession);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const renameWorkspace = useAppStore((s) => s.renameWorkspace);
  const startConversationIn = useAppStore((s) => s.startConversationIn);
  const openWorkspaceInFiles = useAppStore((s) => s.openWorkspaceInFiles);
  const renameConversation = useAppStore((s) => s.renameConversation);
  const archiveConversation = useAppStore((s) => s.archiveConversation);
  const deleteConversation = useAppStore((s) => s.deleteConversation);

  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(currentWorkspace ? [currentWorkspace] : []));
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [wsMenu, setWsMenu] = useState<WsMenuState | null>(null);

  useEffect(() => {
    if (!currentWorkspace) return;
    setExpanded((prev) => (prev.has(currentWorkspace) ? prev : new Set(prev).add(currentWorkspace)));
  }, [currentWorkspace]);

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
    if (!g.exists) return;
    // 工作区行本身就是展开/收起开关；切到别的工作区时顺带打开它最近的对话。
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(g.path)) next.delete(g.path);
      else next.add(g.path);
      return next;
    });
    if (g.path !== "__other__" && g.path !== currentWorkspace) void switchWorkspace(g.path);
    onClose?.();
  };

  const openWsMenu = (e: React.MouseEvent<HTMLButtonElement>, g: WorkspaceGroup) => {
    e.stopPropagation();
    setWsMenu({ path: g.path, name: g.name, anchor: e.currentTarget });
  };

  const askRenameWorkspace = async (m: WsMenuState) => {
    const next = await askPrompt({
      title: t("重命名工作区", "Rename workspace"),
      message: t("只改显示名，不会改动真实目录。", "Only the display name changes; the real directory is untouched."),
      initial: m.name,
    });
    if (next === null) return;
    void renameWorkspace(m.path, next.trim());
  };

  const revealWorkspace = (m: WsMenuState) => {
    void openWorkspaceInFiles(m.path);
  };

  const askRemove = async (path: string) => {
    if (path === "__other__") return;
    const ok = await askConfirm({
      title: t("删除工作区", "Delete workspace"),
      message: t(`「${baseName(path)}」将不再作为工作区；已存在的对话和历史记录都会保留。`, `"${baseName(path)}" will no longer be a workspace; existing conversations and history are kept.`),
      danger: true,
      confirmText: t("删除", "Delete"),
    });
    if (ok) await removeWorkspace(path);
  };

  const openOne = (c: ConversationInfo) => {
    setMenu(null);
    void openConversation(c.id);
    onClose?.();
  };

  const titleOf = (c: ConversationInfo) => conversationTitle(c.title, items[c.id], locale);

  const askRename = async (c: ConversationInfo) => {
    const next = await askPrompt({ title: t("重命名对话", "Rename conversation"), initial: titleOf(c) });
    if (next === null) return;
    void renameConversation(c.id, next.trim());
  };

  const askArchive = (c: ConversationInfo) => {
    void archiveConversation(c.id, !c.archived);
  };

  const askDelete = async (c: ConversationInfo) => {
    const ok = await askConfirm({
      title: t("删除对话", "Delete conversation"),
      message: t(`「${titleOf(c)}」会从列表移除并结束运行中的进程，转录文件仍保留。`, `"${titleOf(c)}" is removed from the list and any running process is stopped; the transcript file is kept.`),
      danger: true,
      confirmText: t("删除", "Delete"),
    });
    if (ok) void deleteConversation(c.id);
  };

  const askStop = async (c: ConversationInfo) => {
    const ok = await askConfirm({
      title: t("结束进程", "Stop process"),
      message: t(`结束「${titleOf(c)}」的 claude 进程？对话仍保留，下次点击会恢复。`, `Stop the claude process for "${titleOf(c)}"? The conversation stays and can be resumed later.`),
      danger: true,
      confirmText: t("结束进程", "Stop"),
    });
    if (ok) void closeSession(c.id);
  };

  const openMenu = (e: React.MouseEvent<HTMLButtonElement>, c: ConversationInfo) => {
    e.stopPropagation();
    setMenu({ id: c.id, anchor: e.currentTarget });
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
        {updateAvailable && onOpenDeploy && (
          <button
            type="button"
            onClick={onOpenDeploy}
            className="mb-2 flex h-9 w-9 items-center justify-center rounded-lg text-brand hover:bg-black/5"
            aria-label={t("有新版本可安装", "Update available")}
            title={t(`有更新 ${claudeLatest}`, `Update ${claudeLatest}`)}
          >
            <IconDownload size={18} />
          </button>
        )}
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
    <aside className="safe-top flex h-full w-full shrink-0 flex-col border-r border-line bg-panel md:w-[280px] md:pt-0">
      {/* 三栏（侧栏 / 对话 / 右侧栏）的表头统一 56px，分隔线才对得齐。 */}
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3">
        {/* 品牌区只做标识，不是按钮：点标题/logo 就新建对话太容易误触，
            「新对话」有下面那个独立按钮。 */}
        <div className="flex min-w-0 items-center gap-2">
          <BrandMark size={25} className="shrink-0 text-ink" />
          <span className="truncate text-[15px] font-semibold tracking-tight text-ink">Claude Code</span>
          <span className="shrink-0 rounded-[5px] border border-line-strong px-1 py-[1px] text-[9px] font-semibold tracking-wide text-muted">
            CONSOLE
          </span>
        </div>
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

      {/* 功能区：和 DSH 一样放在「新对话」与工作区之间，一行一个入口。 */}
      <div className="mt-3 px-3">
        <button type="button" onClick={onOpenHistory} className="side-row text-ink-2 hover:text-ink">
          <IconHistory size={15} />
          <span className="text-[12.5px]">{t("历史记录", "History")}</span>
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
                  disabled={!g.exists}
                  aria-expanded={open}
                  className={`side-row min-w-0 flex-1 ${isCurrent ? "text-ink" : "text-ink-2"} ${!g.exists ? "opacity-50" : ""}`}
                  data-active={isCurrent}
                  title={g.path === "__other__" ? t("不在授权目录内的对话", "Conversations outside authorized directories") : g.path}
                >
                  {g.path === "__other__" ? <IconTerminal size={15} className="shrink-0 text-muted" /> : <IconFolder size={15} className="shrink-0 text-muted" />}
                  <span className="truncate text-[12.5px] font-medium">{g.name}</span>
                  {!g.exists && g.path !== "__other__" && <span className="shrink-0 text-[10px] text-warn">{t("不可用", "Missing")}</span>}
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    {g.conversations.length > 0 && (
                      <span className="rounded-full bg-black/[0.06] px-1.5 text-[10px] text-muted">{g.conversations.length}</span>
                    )}
                    {open ? <IconChevronDown size={14} className="text-muted" /> : <IconChevronRight size={14} className="text-muted" />}
                  </span>
                </button>
                {g.path !== "__other__" && (
                  <>
                    <button
                      type="button"
                      onClick={(e) => openWsMenu(e, g)}
                      className="rounded-md p-1 text-muted transition hover:bg-black/5 hover:text-ink md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                      aria-label={`${t("工作区操作", "Workspace actions")} ${g.path}`}
                      aria-haspopup="menu"
                      title={t("更多", "More")}
                    >
                      <IconMore size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void startConversationIn(g.path)}
                      className="rounded-md p-1 text-muted transition hover:bg-black/5 hover:text-ink md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                      aria-label={`${t("在该工作区新建对话", "New conversation in this workspace")} ${g.path}`}
                      title={t("新建对话", "New conversation")}
                    >
                      <IconPlus size={14} />
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
                    // 待审批 > 进行中 > 完成未看 > 活跃（不画点）> 未运行（灰点），见 lib/conversations。
                    const status = conversationStatus({
                      pending: perms[c.id]?.length ?? 0,
                      live: c.live,
                      state: liveState,
                      done: Boolean(doneIds[c.id]),
                    });
                    return (
                      <div key={c.id} className="group/session flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => openOne(c)}
                          className={`side-row min-w-0 flex-1 ${c.archived ? "opacity-60" : ""}`}
                          data-active={active}
                          title={`${c.cwd}\n${c.live ? stateLabel(liveState, locale) : t("未运行（点击恢复）", "Not running (click to resume)")}`}
                        >
                          <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center">
                            {status !== "active" && <StateDot state={status} />}
                          </span>
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
        {updateAvailable && onOpenDeploy && (
          <button
            type="button"
            onClick={onOpenDeploy}
            className="side-row text-brand hover:bg-brand/10"
            title={t(`有更新 ${claudeLatest}，点击去部署页安装`, `Update ${claudeLatest} available — open deployment`)}
          >
            <IconDownload size={15} />
            <span className="text-[12px]">{t(`有更新 ${claudeLatest}`, `Update ${claudeLatest}`)}</span>
            <span className="ml-auto text-[10px] text-brand/80">{t("去安装", "Install")}</span>
          </button>
        )}
        <button type="button" onClick={onOpenSettings} className="side-row text-muted hover:text-ink">
          <IconSettings size={15} />
          <span className="text-[12px]">{t("设置", "Settings")}</span>
          <span className="ml-auto flex items-center gap-1 text-[10px] text-faint">
            <span className={`h-1.5 w-1.5 rounded-full ${connTone}`} />
            {connLabel}
          </span>
        </button>
      </div>

      <Menu
        open={Boolean(wsMenu)}
        anchor={wsMenu?.anchor ?? null}
        onClose={() => setWsMenu(null)}
        items={
          wsMenu
            ? ([
                { id: "rename", label: t("重命名", "Rename"), icon: <IconPencil size={13} className="text-muted" />, onSelect: () => void askRenameWorkspace(wsMenu) },
                { id: "reveal", label: t("在文件夹显示", "Show in files"), icon: <IconFolder size={13} className="text-muted" />, onSelect: () => revealWorkspace(wsMenu) },
                { id: "remove", label: t("删除工作区", "Delete workspace"), icon: <IconTrash size={13} />, danger: true, onSelect: () => void askRemove(wsMenu.path) },
              ] satisfies MenuItem[])
            : []
        }
      />

      <Menu
        open={Boolean(menu && menuConv)}
        anchor={menu?.anchor ?? null}
        onClose={() => setMenu(null)}
        width={168}
        items={
          menuConv
            ? ([
                { id: "rename", label: t("重命名", "Rename"), icon: <IconPencil size={13} className="text-muted" />, onSelect: () => void askRename(menuConv) },
                { id: "archive", label: menuConv.archived ? t("取消归档", "Unarchive") : t("归档", "Archive"), icon: <IconArchive size={13} className="text-muted" />, onSelect: () => askArchive(menuConv) },
                ...(menuConv.live
                  ? [{ id: "stop", label: t("结束进程", "Stop process"), icon: <IconStop size={13} className="text-muted" />, onSelect: () => void askStop(menuConv) }]
                  : []),
                { id: "delete", label: t("删除", "Delete"), icon: <IconTrash size={13} />, danger: true, onSelect: () => void askDelete(menuConv) },
              ] satisfies MenuItem[])
            : []
        }
      />
    </aside>
  );
}
