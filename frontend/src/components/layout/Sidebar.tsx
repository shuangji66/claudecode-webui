import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useAppStore } from "../../store/useAppStore";
import type { ConversationInfo, WorkspaceEntry } from "../../transport/types";
import { baseName, conversationTitle, relativeTime } from "../../lib/labels";
import { useLocale, useT } from "../../lib/i18n";
import { ConversationPreview } from "./ConversationPreview";
import { WorkspacePreview } from "./WorkspacePreview";
import { ARCHIVED_NOTICE_EN, ARCHIVED_NOTICE_ZH, belongs, conversationStatus, pinnedFirst, sortByRecent, type ConversationStatus } from "../../lib/conversations";
import {
  FLAT_KEY,
  OTHER_KEY,
  SESSION_GROUP_LIMIT,
  applyOrder,
  applyWorkspaceOrder,
  canDrop,
  dropHalf,
  flattenWorkspaceTree,
  loadOrder,
  loadView,
  loadWorkspaceOrder,
  matchArchive,
  movePath,
  moveStep,
  moveTo,
  saveOrder,
  saveView,
  saveWorkspaceOrder,
  type DropHalf,
  type SidebarView,
} from "../../lib/sidebarView";
import { clearDragPreview, startDragPreview } from "../../lib/dragImage";
import { toggleHiddenFeature, useHiddenFeatures, type FeatureKey } from "../../lib/sidebarFeatures";
import { askConfirm, askPrompt } from "../common/SystemDialogs";
import { copyText } from "../../lib/clipboard";
import { Menu, type MenuItem } from "../common/Menu";
import { StateDot } from "../common/StateDot";
import {
  BrandMark,
  IconArchive,
  IconChevronDown,
  IconChevronUp,
  IconChevronRight,
  IconClock,
  IconClose,
  IconCopy,
  IconDownload,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconGitBranch,
  IconGlobe,
  IconGrid,
  IconHistory,
  IconMore,
  IconPanel,
  IconPencil,
  IconPin,
  IconPlugin,
  IconPlus,
  IconRetry,
  IconSearch,
  IconLogout,
  IconSettings,
  IconSliders,
  IconSpark,
  IconStop,
  IconTerminal,
  IconTrash,
  IconWrench,
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
  /**
   * 打开功能区对应的整页视图（插件 / MCP / 技能中心 / 自动化任务 / 历史记录）。
   * 同一个入口再点一次由上层切成「回到对话」。
   */
  onOpenFeature: (feature: FeatureKey) => void;
  /** 当前打开的功能页：入口在原地高亮（对齐 DSH）。 */
  activeFeature?: FeatureKey | null;
  /**
   * 「回到对话区」：点某条对话（含**已经在用的那条**）或「新对话」时调。
   *
   * 不能靠上层观察 `activeId` 变化来推断：点当前那条时 id 没变，回调不会触发；
   * 而后台恢复会话（进程没了 → 重连/新建）也会改 `activeId`，那时用户正在插件页
   * 操作，不该被踢回对话区。所以要挂在动作上，而不是状态上。
   */
  onOpenChat?: () => void;
}

/** 功能区的一个入口。图标给成渲染函数：同一份清单要在 15px 的行内与 18px 的收起态各画一次。 */
interface FeatureEntry {
  key: FeatureKey;
  label: string;
  icon: (size: number) => ReactNode;
  onClick: () => void;
}

interface WorkspaceGroup {
  path: string;
  name: string;
  exists: boolean;
  workspace: WorkspaceEntry | null;
  conversations: ConversationInfo[];
  /** 按工作区树分组时的缩进层级。 */
  depth: number;
}

/** 悬浮概览的主题：会话或工作区（同一时刻只弹一张卡片）。 */
type HoverSubject = { kind: "conv"; conv: ConversationInfo } | { kind: "ws"; group: WorkspaceGroup };
type HoverState = HoverSubject & { anchor: HTMLElement };

/**
 * 「复制 Session ID」暂时下线（**保留实现，不删**，以后再说）。
 *
 * 它复制的是 claude 的 session id：`--resume`、转录文件名、`session-env/<id>/` 都用它，
 * 但它跟 claude 多会话那套「名字 + 6 位 ref」（`ListAgents` / `SendMessage`）不是一套，
 * 粘进对话也不会让模型自己回看，所以当前用途只剩排查/终端接管，先收起来。
 * 要恢复就把开关改成 true（菜单项、`copySessionId` 与它的测试都在）。
 */
const SHOW_COPY_SESSION_ID = false;
/**
 * 触摸拖拽工作区长按多久才激活（毫秒）。
 *
 * 不用「按下就拖」：侧栏在手机上主要靠滑动滚动，按下即拖会把手势全吃掉。
 * 300ms 与系统列表排序的手感接近；期间手指移动超过 10px 就当滚动、放弃长按。
 */
const WS_LONG_PRESS_MS = 300;

interface MenuState {
  id: string;
  anchor: HTMLElement;
}

interface WsMenuState {
  path: string;
  name: string;
  anchor: HTMLElement;
}

/** 手动排序的拖拽状态：拖的是谁（哪一组、是否置顶），以及当前吸附在哪一行的哪半边。 */
interface DragState {
  id: string;
  groupKey: string;
  pinned: boolean;
  over: { id: string; half: DropHalf } | null;
}

export function Sidebar({ onClose, collapsed = false, onToggleCollapse, onOpenSettings, onOpenDeploy, onAddWorkspace, onOpenFeature, activeFeature = null, onOpenChat }: Props) {
  const t = useT();
  const claude = useAppStore((s) => s.claude);
  const authRequired = useAppStore((s) => Boolean(s.info?.auth_required));
  const logout = useAppStore((s) => s.logout);
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
  const openConversation = useAppStore((s) => s.openConversation);
  const createSession = useAppStore((s) => s.createSession);
  const closeSession = useAppStore((s) => s.closeSession);
  const restartSession = useAppStore((s) => s.restartSession);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const renameWorkspace = useAppStore((s) => s.renameWorkspace);
  const startConversationIn = useAppStore((s) => s.startConversationIn);
  const openWorkspaceInFiles = useAppStore((s) => s.openWorkspaceInFiles);
  const renameConversation = useAppStore((s) => s.renameConversation);
  const archiveConversation = useAppStore((s) => s.archiveConversation);
  const pinConversation = useAppStore((s) => s.pinConversation);
  const forkConversation = useAppStore((s) => s.forkConversation);
  const deleteConversation = useAppStore((s) => s.deleteConversation);
  const showToast = useAppStore((s) => s.showToast);

  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  // 分组 / 排序 / 归档筛选（对齐 DSH 的工作区菜单），随设备持久化。
  const [view, setView] = useState<SidebarView>(loadView);
  const [order, setOrder] = useState<Record<string, string[]>>(loadOrder);
  const [viewAnchor, setViewAnchor] = useState<HTMLElement | null>(null);
  /** 拖拽中的会话与当前吸附位置：手动排序用（对齐 DSH 的 drag marker）。 */
  const [drag, setDrag] = useState<DragState | null>(null);
  /**
   * 工作区拖动排序（每台设备）：保存的是 path 顺序，见 `lib/sidebarView`。
   *
   * 只影响「按工作区分组」下的排列；树模式的层级由目录路径决定，换回树模式时
   * 顺序原样保留，切回来还是拖过的那一份。
   */
  const [wsOrder, setWsOrder] = useState<string[]>(loadWorkspaceOrder);
  const [wsDrag, setWsDrag] = useState<{ path: string; over: { path: string; half: DropHalf } | null } | null>(null);
  /** 按下后还没激活（鼠标等移动超过阈值 / 触摸等长按到点）。 */
  const wsPress = useRef<{
    path: string;
    x: number;
    y: number;
    pointerId: number;
    el: HTMLElement;
    timer: number | null;
    active: boolean;
    /**
     * 活跃之后**真的动过**没有。
     *
     * 长按 300ms 已经激活、但手指没移动就松手，那仍是一次点击：`beginWsDrag` 只是
     * 把行调暗、清了选区，落点还是空的。按「激活了就吞掉这次 click」处理的话，
     * 用户点了一下工作区行（尤其那颗只在悬停才露出的 ⋯ / ＋）会毫无反应——
     * 不展开、不出菜单，看起来像界面卡了。
     */
    moved: boolean;
    over: { path: string; half: DropHalf } | null;
  } | null>(null);
  /** 拖动中指针的纵坐标：边缘自动滚动要用（move 可能停在容器外）。 */
  const wsPointerY = useRef(0);
  /** 拖动结束后浏览器还会补一次 click：吞掉它，别把这一组展开/收起。 */
  const wsSuppressClick = useRef(false);
  /** 工作区列表容器：落点只在这一份里量（移动端抽屉与桌面侧栏会同时存在）。 */
  const wsListRef = useRef<HTMLDivElement>(null);
  /** 悬浮概览：鼠标停住一会儿才弹，离开/滚动就收。工作区与会话共用一张卡片位。 */
  const [hover, setHover] = useState<HoverState | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(currentWorkspace ? [currentWorkspace] : []));
  /**
   * 「展开其余 N 个会话」被点开的工作区。
   *
   * 收起工作区时一并清掉：折叠再来一次就该回到默认的前 5 条，
   * 否则这条设置会让「展开其余」变成一次性开关，收起毫无意义。
   */
  const [moreSessions, setMoreSessions] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [wsMenu, setWsMenu] = useState<WsMenuState | null>(null);
  /**
   * 功能区里被取消固定的入口（只存本机，见 lib/sidebarFeatures）。
   *
   * 走模块级共享快照而不是 useState：侧栏同时有两个实例（桌面常驻 + 移动端抽屉），
   * 各持一份的话，在抽屉里取消固定后桌面实例会用旧集合整体回写，把选择抹掉。
   */
  const hiddenFeatures = useHiddenFeatures();
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);

  useEffect(() => {
    saveView(view);
  }, [view]);

  /** 收起搜索：查询一并清空，列表立刻回到完整状态（Esc 与「取消」共用）。 */
  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
  };

  /**
   * 搜索收起后把焦点还给那颗搜索按钮。
   *
   * 输入框在收起时被卸载，焦点会掉到 `body` 上：键盘用户下一次 Tab 要从页面开头
   * （品牌、收起、功能区……）重新数一遍。**不能在 `closeSearch` 里直接 focus**——
   * 那颗按钮要到下一次 commit 才存在，只能在 effect 里等它挂上。
   */
  const searchButton = useRef<HTMLButtonElement>(null);
  const wasSearching = useRef(false);
  useEffect(() => {
    if (searchOpen) {
      wasSearching.current = true;
      return;
    }
    if (!wasSearching.current) return;
    wasSearching.current = false;
    searchButton.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    saveOrder(order);
  }, [order]);

  useEffect(() => {
    if (!currentWorkspace) return;
    setExpanded((prev) => (prev.has(currentWorkspace) ? prev : new Set(prev).add(currentWorkspace)));
  }, [currentWorkspace]);

  const archivedCount = conversations.filter((c) => c.archived).length;

  // 功能区入口（对齐 DSH）：模型 / 插件 / MCP / 技能中心 / 自动化任务 / 历史记录。
  // 每一项都能从「更多」里取消固定，取消后同时从展开态与收起态消失。
  const featureEntries: FeatureEntry[] = [
    { key: "models", label: t("模型", "Models"), icon: (size) => <IconSpark size={size} />, onClick: () => onOpenFeature("models") },
    { key: "plugins", label: t("插件", "Plugins"), icon: (size) => <IconPlugin size={size} />, onClick: () => onOpenFeature("plugins") },
    { key: "mcp", label: "MCP", icon: (size) => <IconGlobe size={size} />, onClick: () => onOpenFeature("mcp") },
    { key: "skills", label: t("技能中心", "Skills"), icon: (size) => <IconWrench size={size} />, onClick: () => onOpenFeature("skills") },
    { key: "schedules", label: t("自动化任务", "Automations"), icon: (size) => <IconClock size={size} />, onClick: () => onOpenFeature("schedules") },
    { key: "history", label: t("历史记录", "History"), icon: (size) => <IconHistory size={size} />, onClick: () => onOpenFeature("history") },
  ];
  const visibleFeatures = featureEntries.filter((f) => !hiddenFeatures.has(f.key));
  // 取消固定的入口不会消失，只是从主列表挪进「更多」——那里点一下照样能进，
  // 行尾那颗图钉把它固定回主列表。
  const hiddenEntries = featureEntries.filter((f) => hiddenFeatures.has(f.key));
  const moreItems: MenuItem[] = hiddenEntries.map((f) => ({
    id: f.key,
    label: f.label,
    icon: f.icon(13),
    onSelect: f.onClick,
    trailing: {
      label: t(`固定 ${f.label}`, `Pin ${f.label}`),
      icon: <IconPin size={13} />,
      // 固定完把菜单也收掉：被取消固定的入口只剩最后一项时，「更多」按钮会随
      // 列表清空而卸载，锚点却还在——留下一个空浮层要点别处才消失。
      onSelect: () => {
        toggleHiddenFeature(f.key);
        setMoreAnchor(null);
      },
    },
  }));
  const pin = (key: FeatureKey) => toggleHiddenFeature(key);
  /**
   * 先取出 currentTarget 再 setState：把 `e.currentTarget` 放进 state 的更新函数里，
   * 等它真正执行时事件已经回收成 null，菜单会「点了没反应」。
   */
  const toggleMore = (e: React.MouseEvent<HTMLButtonElement>) => {
    const anchor = e.currentTarget;
    setMoreAnchor((prev) => (prev ? null : anchor));
  };

  /** 会话所属工作区的显示名（单列表模式下在行首标出来）。 */
  const workspaceNameOf = (cwd: string): string => {
    const ws = workspaces
      .filter((w) => belongs(cwd, w.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    return ws ? ws.name || baseName(ws.path) : baseName(cwd);
  };

  /**
   * 一行的状态标记：行上画点、悬浮卡里写文案，两处必须是同一口径。
   * （卡片在对话区域里，不再让原生的 title 提示单独再报一次状态。）
   */
  const statusOf = (c: ConversationInfo): ConversationStatus => {
    const liveState = c.live ? (states[c.id] ?? c.state ?? "ready") : "";
    return conversationStatus({
      pending: perms[c.id]?.length ?? 0,
      live: c.live,
      state: liveState,
      done: Boolean(doneIds[c.id]),
    });
  };

  // 标题只由「自定义标题 + 首条用户消息」决定。流式增量每帧都在改 items，
  // 但不会改这两者；用一个签名把它们抽出来，分组就能在流式期间保持稳定，
  // 不必每个 token 重算全部分组与排序。
  const titleSig = useMemo(() => {
    let sig = "";
    for (const c of conversations) {
      const first = (items[c.id] ?? []).find((i) => i.kind === "user");
      sig += `${c.id}\u0001${c.title ?? ""}\u0001${first && first.kind === "user" ? first.text : ""}\u0002`;
    }
    return `${locale}\u0003${sig}`;
  }, [conversations, items, locale]);

  const groups = useMemo<WorkspaceGroup[]>(() => {
    const visible = conversations.filter((c) => matchArchive(c, view.archive));
    // 手动排序只在 manual 模式生效；其它模式一律按最近更新。
    // 置顶永远在最前：两种排序都先过 pinnedFirst，组内顺序保持原样。
    const sortList = (list: ConversationInfo[], key: string) =>
      pinnedFirst(view.sort === "manual" ? applyOrder(list, order[key] ?? []) : sortByRecent(list));

    const q = query.trim().toLowerCase();
    const matches = (c: ConversationInfo, groupName: string) =>
      !q ||
      conversationTitle(c.title, items[c.id], locale).toLowerCase().includes(q) ||
      c.cwd.toLowerCase().includes(q) ||
      groupName.toLowerCase().includes(q);

    // 单列表：不分组，全部会话按当前排序排成一列（行上标出所属工作区）。
    if (view.group === "flat") {
      // 单列表里也按「会话标题 / 路径 / 所属工作区名」搜。
      const all = sortList(visible, FLAT_KEY).filter((c) => matches(c, workspaceNameOf(c.cwd)));
      return [
        { path: FLAT_KEY, name: "", exists: true, workspace: null, conversations: all, depth: 0 },
      ];
    }

    const entries =
      view.group === "tree"
        ? flattenWorkspaceTree(workspaces)
        : applyWorkspaceOrder(workspaces, wsOrder).map((w) => ({ workspace: w, depth: 0 }));
    const result: WorkspaceGroup[] = entries.map(({ workspace: w, depth }) => ({
      path: w.path,
      name: w.name || baseName(w.path),
      exists: w.exists,
      workspace: w,
      conversations: [],
      depth,
    }));
    const others: ConversationInfo[] = [];
    for (const c of visible) {
      const group = result
        .filter((g) => belongs(c.cwd, g.path))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (group) group.conversations.push(c);
      else others.push(c);
    }
    if (others.length > 0) {
      result.push({
        path: OTHER_KEY,
        name: t("其他对话", "Other conversations"),
        exists: true,
        workspace: null,
        conversations: others,
        depth: 0,
      });
    }
    for (const g of result) {
      g.conversations = sortList(g.conversations, g.path);
    }
    if (!q) return result;
    return result
      .map((g) => ({ ...g, conversations: g.conversations.filter((c) => matches(c, g.name)) }))
      .filter((g) => g.conversations.length > 0 || g.name.toLowerCase().includes(q));
    // titleSig 是 items 的「标题投影」：只有它变了才需要重算分组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, conversations, view, order, wsOrder, query, titleSig, t]);

  const endHover = () => {
    if (hoverTimer.current) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setHover(null);
  };

  // 卸载（关抽屉、切布局）时把待弹的定时器收掉：220ms 后对已卸载的组件 setState
  // 会静默留下一个悬空闭包，里面还攥着那张已经脱离文档的行节点。
  useEffect(() => () => {
    if (hoverTimer.current) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  /**
   * 悬停 220ms 才弹卡片：划过列表时不该一路闪卡片。
   * 触屏没有 hover；抽屉模式（窄屏）也没有并排的对话区域可放卡片，都不弹。
   */
  const armHover = (event: ReactPointerEvent<HTMLElement>, state: HoverSubject) => {
    if (event.pointerType !== "mouse") return;
    if (window.matchMedia?.("(min-width: 768px)").matches === false) return;
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    const anchor = event.currentTarget;
    hoverTimer.current = window.setTimeout(() => setHover({ ...state, anchor }), 220);
  };

  /* ------------------------------------------------------------------
   * 工作区拖动排序
   *
   * 用 Pointer Events 而不是 HTML5 DnD：手机上拖拽根本不会触发 dragstart，
   * 而「上下拖动调整顺序」在触屏上是刚需。两条启动方式：
   *   - 鼠标：按下后移动超过 6px 就开始拖（不会误伤点击）；
   *   - 触摸：**先长按 300ms**。不加这一条的话，手指在侧栏上向下滑会被当成
   *     拖拽，侧栏就没法滚了；长按之前移出 10px 一律按「在滚动」处理。
   *
   * 落点规则与 DSH 一致：指针在某行的上半 → 插到它前面，下半 → 插到它后面；
   * 越过最后一行就落到末尾。提示线复用会话拖拽那条 `.side-drop-line`。
   * ------------------------------------------------------------------ */
  const wsReorderable = view.group === "workspace" && query.trim() === "";

  /** 工作区行（排除「其他」）：落点只在这一组里算。 */
  const wsRows = (): HTMLElement[] => {
    const root = wsListRef.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>("[data-workspace]")).filter(
      (row) => row.dataset.workspace && row.dataset.workspace !== OTHER_KEY,
    );
  };

  const wsOverAt = (clientY: number): { path: string; half: DropHalf } | null => {
    const rows = wsRows();
    if (rows.length === 0) return null;
    for (const row of rows) {
      // 落点的上/下半与提示线用同一份判定（`dropHalf`），别在这里再写一次中线。
      if (dropHalf(clientY, row.getBoundingClientRect()) === "before") {
        return { path: row.dataset.workspace!, half: "before" };
      }
    }
    return { path: rows[rows.length - 1].dataset.workspace!, half: "after" };
  };

  /** 屏幕此刻的工作区顺序（已应用保存的偏好）：拖拽与菜单的上移/下移共用基准。 */
  const wsCurrentOrder = () =>
    groups.filter((g) => g.path !== FLAT_KEY && g.path !== OTHER_KEY).map((g) => g.path);

  /**
   * 落盘一份新顺序。**顺序没变就什么都不写**：拖到相邻行的「等价位置」
   * （把第 1 行拖到第 2 行上半）算出来的数组与原来一模一样，写进去只会让
   * 整列重渲染 + 多一次同步 localStorage 写入，还会在用户根本没改过顺序时
   * 把后端的原始排序永久钉死（之后新增的工作区只能落末尾）。
   */
  const commitWsOrder = (next: string[]) => {
    const current = wsCurrentOrder();
    if (next.length === current.length && next.every((p, i) => p === current[i])) return;
    setWsOrder(next);
    saveWorkspaceOrder(next);
  };

  /** 菜单里的上移/下移：触屏没有拖拽习惯、键盘也拿不到落点，总得有第二条通道。 */
  const stepWsOrder = (path: string, delta: -1 | 1) => {
    const current = wsCurrentOrder();
    const i = current.indexOf(path);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= current.length) return;
    commitWsOrder(movePath(current, path, current[j], delta < 0 ? "before" : "after"));
  };

  /** 这一行还能不能往那个方向挪（首/末行的菜单项置灰）。 */
  const wsCanStep = (path: string, delta: -1 | 1) => {
    const current = wsCurrentOrder();
    const i = current.indexOf(path);
    return i >= 0 && i + delta >= 0 && i + delta < current.length;
  };

  const beginWsDrag = () => {
    const press = wsPress.current;
    if (!press || press.active) return;
    press.active = true;
    if (press.timer !== null) window.clearTimeout(press.timer);
    press.timer = null;
    endHover();
    // 指针移出这一行也要继续收 move：不 capture 的话拖到相邻工作区上就断线了。
    try {
      press.el.setPointerCapture(press.pointerId);
    } catch {
      /* 老 WebView 没有 pointer capture：落点仍由 move 事件更新。 */
    }
    // 拖动中别顺手把标题选中。
    window.getSelection()?.removeAllRanges();
    wsPointerY.current = press.y;
    setWsDrag({ path: press.path, over: null });
  };

  const onWsPointerDown = (e: ReactPointerEvent<HTMLDivElement>, g: WorkspaceGroup) => {
    if (!wsReorderable || g.path === OTHER_KEY || !g.exists) return;
    // 鼠标/手写笔只认主键；`button` 对触摸恒为 0。
    if (e.pointerType !== "touch" && e.button !== 0) return;
    // 已经有别的指针在拖（多指）：不要顶掉那一个，否则第一根手指松手时
    // 会按第二个 press 的落点提交。
    if (wsPress.current?.active) return;
    wsSuppressClick.current = false;
    const mouseLike = e.pointerType !== "touch";
    wsPress.current = {
      path: g.path,
      x: e.clientX,
      y: e.clientY,
      pointerId: e.pointerId,
      el: e.currentTarget,
      active: false,
      moved: false,
      over: null,
      // 手写笔按鼠标处理：它在触屏上没法「按住不动 300ms」。
      timer: mouseLike ? null : window.setTimeout(beginWsDrag, WS_LONG_PRESS_MS),
    };
  };

  const onWsPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const press = wsPress.current;
    if (!press || press.pointerId !== e.pointerId) return;
    if (!press.active) {
      /**
       * 没按键还收到 move = 上一次的 `pointerup` 丢了（拖出窗口、Ctrl+点击弹原生
       * 菜单、元素重挂）。鼠标的 `pointerId` 是恒定的，残留下来的 press 会让之后
       * **只是划过**任意工作区行的鼠标被当成拖拽：被拖行一直半透明、document 上
       * 挡 touchmove 的监听还挂着（触摸屏笔记本上整页划不动）。
       * 与右侧栏分隔线同一条规则（`RightSidebar` 的 `onResizeMove`）。
       */
      if (e.buttons === 0) {
        if (press.timer !== null) window.clearTimeout(press.timer);
        wsPress.current = null;
        return;
      }
      const dx = Math.abs(e.clientX - press.x);
      const dy = Math.abs(e.clientY - press.y);
      if (press.timer !== null) {
        // 触摸：手指先动了就按滚动处理，把长按取消（侧栏照常能划）。
        if (dx > 10 || dy > 10) {
          window.clearTimeout(press.timer);
          press.timer = null;
          wsPress.current = null;
        }
        return;
      }
      if (dx < 6 && dy < 6) return;
      beginWsDrag();
    }
    wsPointerY.current = e.clientY;
    const over = wsOverAt(e.clientY);
    press.over = over;
    // 「动过」按与按下点的位移判，不按「收到过 move」：触摸长按期间手指会抖几像素，
    // 那仍是一次点击（松手要能展开这一组）。
    if (Math.abs(e.clientX - press.x) > 6 || Math.abs(e.clientY - press.y) > 6) press.moved = true;
    setWsDrag((prev) => {
      if (!prev) return prev;
      if (prev.over?.path === over?.path && prev.over?.half === over?.half) return prev;
      return { ...prev, over };
    });
  };

  /** 只有发起拖拽的那个指针才能结束它（多指时第二根手指的 up 不算）。 */
  const guardWsPointer = (pointerId: number, fn: () => void) => {
    if (wsPress.current?.pointerId !== pointerId) return;
    fn();
  };

  const endWsPress = (commit: boolean) => {
    const press = wsPress.current;
    wsPress.current = null;
    if (!press) return;
    if (press.timer !== null) window.clearTimeout(press.timer);
    try {
      press.el.releasePointerCapture(press.pointerId);
    } catch {
      /* 没有 capture 过 */
    }
    if (!press.active) {
      setWsDrag(null);
      return;
    }
    if (!press.moved) {
      // 长按到点但一步没挪就松手：这仍是一次点击，别把展开/菜单吞掉。
      setWsDrag(null);
      return;
    }
    if (commit && press.over && press.over.path !== press.path) {
      commitWsOrder(movePath(wsCurrentOrder(), press.path, press.over.path, press.over.half));
    }
    setWsDrag(null);
    // 松手后浏览器还会补一次 click：吞掉它，别把这一组展开/收起。
    // 新的一次按下会把它复位（见 onWsPointerDown），不必靠超时精确到毫秒。
    wsSuppressClick.current = true;
    window.setTimeout(() => {
      wsSuppressClick.current = false;
    }, 120);
  };

  /**
   * 松手可能落在这五行之外：`setPointerCapture` 失败的老 WebView、拖动中元素重挂、
   * 系统收回指针（`pointercancel`）都拿不到行上的 `pointerup`。**必须挂到 window 上
   * 兜底**：漏一次 `wsDrag` 就永远不为 null，document 上那条挡 `touchmove` 的监听
   * 会让整页划不动，直到下一次点击。
   */
  useEffect(() => {
    const release = () => {
      if (wsPress.current !== null) endWsPress(false);
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
    };
    // 只挂一次：`endWsPress` 每次都读最新的 ref 与 `groups`（经 `endWsPress` 的
    // 闭包），依赖它会让监听反复重挂。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 组件卸载时把「等长按到点」的定时器收掉，别让它在已卸载的 Sidebar 上 setState。 */
  useEffect(() => {
    return () => {
      const press = wsPress.current;
      if (press?.timer != null) window.clearTimeout(press.timer);
      wsPress.current = null;
    };
  }, []);

  /**
   * 拖动期间必须在 document 上挡掉 touchmove：长按后手指一移动，浏览器仍会
   * 试着滚侧栏，落点就跟着跳。`{ passive: false }` 才拦得住（React 的 touch
   * 监听是 passive 的）。
   */
  useEffect(() => {
    if (!wsDrag) return;
    const stop = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
    };
    document.addEventListener("touchmove", stop, { passive: false });
    return () => document.removeEventListener("touchmove", stop);
  }, [wsDrag]);

  /**
   * 拖到列表上下沿时自动滚动。
   *
   * 没有它，一次手势只能在一屏之内换位：工作区一多，远处两个之间根本换不了
   * （会话那套走原生 HTML5 DnD，浏览器会在容器边缘自己滚）。而且指针停在容器
   * 下沿时 `wsOverAt` 会命中**视口下方看不见的那一行**，提示线画在屏幕外，
   * 松手落在用户没看到的地方。
   *
   * 依赖只取「在不在拖」：状态每帧都会重写 `wsDrag`，按对象依赖会让这个循环
   * 每帧重建一次。
   */
  const wsDragging = wsDrag !== null;
  useEffect(() => {
    if (!wsDragging) return;
    let raf = 0;
    const step = () => {
      raf = window.requestAnimationFrame(step);
      const root = wsListRef.current;
      const press = wsPress.current;
      if (!root || !press?.active) return;
      const max = root.scrollHeight - root.clientHeight;
      if (max <= 0) return;
      const rect = root.getBoundingClientRect();
      const y = wsPointerY.current;
      const EDGE = 28;
      const delta =
        y < rect.top + EDGE
          ? -Math.ceil((rect.top + EDGE - y) / 3)
          : y > rect.bottom - EDGE
            ? Math.ceil((y - (rect.bottom - EDGE)) / 3)
            : 0;
      if (delta === 0) return;
      const before = root.scrollTop;
      root.scrollTop = Math.max(0, Math.min(max, before + delta));
      if (root.scrollTop === before) return;
      // 指针没动、行在动：落点要跟着重算，否则提示线与松手的位置对不上。
      press.over = wsOverAt(y);
      setWsDrag((prev) => (prev ? { ...prev, over: press.over } : prev));
    };
    raf = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsDragging]);

  /** 手动排序的落盘入口：拖拽和菜单里的上移/下移共用。 */
  const reorder = (key: string, list: ConversationInfo[], fromId: string, toId: string, half: DropHalf) => {
    setOrder((prev) => ({ ...prev, [key]: moveTo(prev[key] ?? [], list, fromId, toId, half) }));
  };
  const commitDrag = (d: DragState) => {
    if (!d.over) return;
    const group = groups.find((g) => g.path === d.groupKey);
    if (!group) return;
    reorder(d.groupKey, group.conversations, d.id, d.over.id, d.over.half);
  };
  const stepOrder = (key: string, list: ConversationInfo[], id: string, delta: number) => {
    setOrder((prev) => ({ ...prev, [key]: moveStep(prev[key] ?? [], list, id, delta) }));
  };
  const groupOf = (c: ConversationInfo) => groups.find((g) => g.conversations.some((x) => x.id === c.id));

  /** 一行会话：状态点 + 标题 +（单列表模式）工作区名 + 时间 + 管理菜单。 */
  const renderConversation = (c: ConversationInfo, groupKey: string, showWorkspace: boolean) => {
    const active = c.id === activeId;
    // 待审批 > 进行中 > 完成未看 > 活跃（不画点）> 未运行（灰点），见 lib/conversations。
    const status = statusOf(c);
    const manual = view.sort === "manual";
    // 吸附提示线只画在「这次真的能落下去」的那一行上：同组、不是自己、置顶状态一致。
    const marker = drag?.over?.id === c.id ? drag.over.half : null;
    return (
      // 高亮同样画在整行上（含右侧操作组），与工作区行一致：只包住标题时，
      // 底色会在按钮前硬生生截断，当前对话看起来像被切了一刀。
      <div
        key={c.id}
        className="group/session side-row relative gap-1"
        data-active={active}
        // 右键 = 「管理对话」菜单：桌面端不用先瞄准右上角那个只有在悬停时才出现的按钮。
        onContextMenu={(e) => openMenuAt(e, c)}
        draggable={manual}
        onDragStart={
          manual
            ? (e) => {
                endHover();
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", c.id);
                // 自己造拖影：浏览器默认那张图在手机上会被缩小，看起来像把这行压扁了。
                startDragPreview(e.dataTransfer, e.currentTarget, e.clientX, e.clientY);
                setDrag({ id: c.id, groupKey, pinned: Boolean(c.pinned), over: null });
              }
            : undefined
        }
        onDragOver={
          manual
            ? (e) => {
                if (!drag) return;
                const valid = canDrop(drag, c, groupKey);
                if (valid) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }
                // 提示线永远跟着指针所在的那一行：飘到不能落的行（自己 / 置顶组）上，
                // 线就收掉，而不是留在上一行——否则松手会落到一个已经不看的位置。
                const over = valid ? { id: c.id, half: dropHalf(e.clientY, e.currentTarget.getBoundingClientRect()) } : null;
                setDrag((prev) => {
                  if (!prev) return prev;
                  // dragover 每帧都来：位置没变就别触发重渲染。
                  if (prev.over?.id === over?.id && prev.over?.half === over?.half) return prev;
                  return { ...prev, over };
                });
              }
            : undefined
        }
        onDrop={
          manual
            ? (e) => {
                if (!drag) return;
                e.preventDefault();
                commitDrag(drag);
                setDrag(null);
                clearDragPreview();
              }
            : undefined
        }
        onDragEnd={
          manual
            ? () => {
                // 落位只认真正的 drop：拖到空白处或按 Esc 取消都不改顺序
                // （提示线是「松手会插到这里」的预告，不是「已经插进去」）。
                setDrag(null);
                clearDragPreview();
              }
            : undefined
        }
      >
        <button
          type="button"
          onClick={() => openOne(c)}
          onPointerEnter={(e) => armHover(e, { kind: "conv", conv: c })}
          onPointerLeave={endHover}
          className={`flex min-w-0 flex-1 items-center gap-2 text-left ${c.archived ? "opacity-60" : ""}`}
        >
          <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center">
            {status !== "active" && <StateDot state={status} />}
          </span>
          {showWorkspace && (
            <span className="shrink-0 max-w-[38%] truncate text-[10px] text-faint">{workspaceNameOf(c.cwd)}</span>
          )}
          <span className={`truncate text-[12px] ${active ? "text-ink" : "text-ink-2"}`}>{titleOf(c)}</span>
          {c.pinned && <IconPin size={11} className="shrink-0 text-brand" />}
          {c.archived && (
            <span className="shrink-0 rounded-full bg-black/[0.06] px-1 text-[9px] text-muted">{t("归档", "Archived")}</span>
          )}
          <span
            className={`ml-auto shrink-0 text-[10px] text-faint ${
              // 桌面端两套显示（对齐 DSH）：不悬停只露时间，悬停 / 聚焦 / 菜单打开时让位给操作按钮。
              // `hidden` 而不是 `opacity-0`：悬停后按钮组要真的把时间挤掉，否则三颗按钮会盖在标题上。
              menu?.id === c.id
                ? "md:hidden"
                : "md:group-hover/session:hidden md:group-has-focus-visible/session:hidden"
            }`}
          >
            {relativeTime(c.last_active, Date.now(), locale)}
          </span>
        </button>
        {/* 操作组：桌面悬停 / 键盘聚焦 / 本行菜单打开时出现；触屏只留「···」
            （归档、置顶在菜单里同样能点，触屏没有 hover 也够得着）。 */}
        <div
          className={`flex items-center gap-0.5 ${
            menu?.id === c.id
              ? "md:flex"
              : "md:hidden md:group-hover/session:flex md:group-has-focus-visible/session:flex"
          }`}
        >
          <button
            type="button"
            onClick={() => void archiveConversation(c.id, !c.archived)}
            // 已归档的行这颗是「取消归档」，用主题色与灰色的「归档」区分（与历史记录页一致）。
            className={`hidden rounded-md p-1 transition md:inline-flex ${
              c.archived ? "text-brand hover:bg-brand/10" : "text-muted hover:bg-black/5 hover:text-ink"
            }`}
            aria-label={`${c.archived ? t("取消归档", "Unarchive") : t("归档", "Archive")} ${titleOf(c)}`}
            title={c.archived ? t("取消归档", "Unarchive") : t("归档", "Archive")}
          >
            <IconArchive size={14} />
          </button>
          <button
            type="button"
            onClick={() => void pinConversation(c.id, !c.pinned)}
            className={`hidden rounded-md p-1 transition hover:bg-black/5 md:inline-flex ${c.pinned ? "text-brand" : "text-muted hover:text-ink"}`}
            aria-label={`${c.pinned ? t("取消置顶", "Unpin") : t("置顶", "Pin")} ${titleOf(c)}`}
            aria-pressed={Boolean(c.pinned)}
            title={c.pinned ? t("取消置顶", "Unpin") : t("置顶", "Pin")}
          >
            <IconPin size={14} />
          </button>
          <button
            type="button"
            onClick={(e) => openMenu(e, c)}
            className="rounded-md p-1 text-muted transition hover:bg-black/5 hover:text-ink"
            aria-label={`${t("管理对话", "Manage conversation")} ${titleOf(c)}`}
            aria-haspopup="menu"
            title={t("管理对话", "Manage conversation")}
          >
            <IconMore size={14} />
          </button>
        </div>
        {/* 吸附提示线（对齐 DSH）：拖到这一行的上半/下半就画在它的上/下沿，
            比「整行变色」清楚得多，也不会盖住标题。 */}
        {marker && (
          <span
            aria-hidden
            data-drop-line={marker}
            className={`side-drop-line ${marker === "before" ? "side-drop-line-before" : "side-drop-line-after"}`}
          />
        )}
      </div>
    );
  };

  const startNewChat = () => {
    if (starting) return;
    if (!currentWorkspace) {
      onAddWorkspace();
      return;
    }
    endHover();
    onOpenChat?.();
    void createSession(currentWorkspace);
    onClose?.();
  };

  const onWorkspaceClick = (g: WorkspaceGroup) => {
    if (!g.exists) return;
    // 工作区行只是展开/收起开关：展开一组的会话列表不是导航，不切当前工作区，
    // 也不能替用户打开那个目录的最近一条对话（点一下就想看看列表，结果进了旧对话）。
    // 换工作区要么点具体对话（openConversation 自己会切），要么点行尾的「+」新建。
    const open = expanded.has(g.path);
    if (open) {
      // 收起时把「展开其余」也复位：下次展开回到默认的前 5 条。
      setMoreSessions((prev) => {
        if (!prev.has(g.path)) return prev;
        const next = new Set(prev);
        next.delete(g.path);
        return next;
      });
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(g.path)) next.delete(g.path);
      else next.add(g.path);
      return next;
    });
  };

  const openWsMenu = (e: React.MouseEvent<HTMLButtonElement>, g: WorkspaceGroup) => {
    e.stopPropagation();
    // 菜单开在行外：悬浮概览让位，别让两张浮层叠在一起。
    endHover();
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
    // 悬浮卡是 pointer-events-none 的 fixed 浮层：不先收掉，它会在新对话左上角
    // 继续盖着（指针还停在原来那行上，不会触发 pointerleave）。
    endHover();
    // 已归档的对话不能进入（对齐 DSH）：它已经「从当前视图收起」了，
    // 点进去等于把用户刚归档的那条又拉回面前。要打开得先取消归档。
    if (c.archived) {
      showToast(t(ARCHIVED_NOTICE_ZH, ARCHIVED_NOTICE_EN));
      return;
    }
    // 先回对话区再打开：点的是当前这条时 activeId 不变，靠上层观察状态永远收不到。
    onOpenChat?.();
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

  /**
   * 复制会话 id（对齐 DSH 的「复制 Session ID」）。
   *
   * id 是这个应用里唯一的会话句柄：终端里 `claude --resume <id>` 能接管同一条对话，
   * 排查时转录文件名 / 后端日志 / conversations.json 也只认它。
   */
  const copySessionId = async (c: ConversationInfo) => {
    if (await copyText(c.id)) return;
    // 非安全上下文（局域网 http）或用户拒绝时剪贴板会失败：把 id 摆出来让用户手动复制，
    // 比"点了没反应"强。
    await askPrompt({
      title: t("复制 Session ID", "Copy session ID"),
      message: t("浏览器不允许自动复制，请手动选中下面的 ID。", "The browser blocked clipboard access; select the ID below manually."),
      initial: c.id,
      confirmText: t("完成", "Done"),
    });
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

  /**
   * 重启 = 关掉进程再按同一 id `--resume` 拉起来（`store.restartSession`）。
   *
   * 与切推理等级时的重开不同：那条会等这一轮 result 再动手（不在 busy 时杀进程），
   * 这里是用户主动叫的，按确认就立刻重开——所以确认文案必须写明正在进行的一轮会被中断。
   * 对话 id 与转录都不变，上下文不会丢。
   */
  const askRestart = async (c: ConversationInfo) => {
    const ok = await askConfirm({
      title: t("重启进程", "Restart process"),
      message: t(
        `重启「${titleOf(c)}」的 claude 进程？对话记录与上下文都会保留，正在进行的一轮会被中断。`,
        `Restart the claude process for "${titleOf(c)}"? The conversation and its context are kept; a running turn is interrupted.`,
      ),
      confirmText: t("重启进程", "Restart"),
    });
    if (ok) void restartSession(c.id);
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

  /** 右键：菜单锚在这一行上（不是那个悬停才出现的按钮），并顺手收掉悬浮预览。 */
  const openMenuAt = (e: React.MouseEvent<HTMLElement>, c: ConversationInfo) => {
    e.preventDefault();
    e.stopPropagation();
    endHover();
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
        {visibleFeatures.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={f.onClick}
            className={`mt-2 flex h-9 w-9 items-center justify-center rounded-lg hover:bg-panel-strong ${
              activeFeature === f.key ? "bg-panel-strong text-ink" : "text-muted hover:text-ink"
            }`}
            aria-label={f.label}
            aria-current={activeFeature === f.key ? "page" : undefined}
            title={f.label}
          >
            {f.icon(18)}
          </button>
        ))}
        {hiddenEntries.length > 0 && (
          <button
            type="button"
            onClick={toggleMore}
            className="mt-2 flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-black/5 hover:text-ink"
            aria-label={t("更多", "More")}
            aria-haspopup="menu"
            aria-expanded={moreAnchor !== null}
            title={t("更多", "More")}
          >
            <IconGrid size={18} />
          </button>
        )}
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
        {authRequired && (
          <button
            type="button"
            onClick={() => void logout()}
            className="mb-2 flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-black/5 hover:text-ink"
            aria-label={t("退出登录", "Sign out")}
            title={t("退出登录", "Sign out")}
          >
            <IconLogout size={18} />
          </button>
        )}
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-black/5 hover:text-ink"
          aria-label={t("设置", "Settings")}
          title={t("设置", "Settings")}
        >
          <IconSettings size={18} />
        </button>
        <Menu
          open={moreAnchor !== null}
          anchor={moreAnchor}
          onClose={() => setMoreAnchor(null)}
          width={216}
          align="start"
          items={moreItems}
        />
      </aside>
    );
  }

  const menuConv = menu ? conversations.find((c) => c.id === menu.id) ?? null : null;

  return (
    <aside className="safe-top flex h-full w-full shrink-0 flex-col border-r border-line bg-panel md:w-[280px] md:pt-0">
      {/* 高度和其它两栏的表头对齐（56px），但不画分隔线：品牌区和工作区之间
          不需要一条横线，留白已经够区分。 */}
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        {/* 品牌区只做标识，不是按钮：点标题/logo 就新建对话太容易误触，
            「新对话」有下面那个独立按钮。 */}
        <div className="flex min-w-0 items-center gap-2">
          <BrandMark size={25} className="shrink-0 text-ink" />
          <span className="truncate text-[15px] font-semibold tracking-tight text-ink">Claude Code</span>
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

      {/* 功能区：和 DSH 一样放在「新对话」与工作区之间，一行一个入口。
          「更多」里可以取消固定，隐藏的入口只留在这里的菜单中。 */}
      <div className="mt-3 px-3">
        {visibleFeatures.map((f) => (
          // 行本身是容器而不是按钮：右侧还要嵌一颗固定按钮（按钮不能嵌套）。
          <div key={f.key} className="group/feature flex items-center">
            <button
              type="button"
              onClick={f.onClick}
              data-active={activeFeature === f.key ? "true" : undefined}
              aria-current={activeFeature === f.key ? "page" : undefined}
              className={`side-row min-w-0 flex-1 hover:text-ink ${activeFeature === f.key ? "font-medium text-ink" : "text-ink-2"}`}
            >
              {f.icon(15)}
              <span className="truncate text-[12.5px]">{f.label}</span>
            </button>
            <button
              type="button"
              onClick={() => pin(f.key)}
              aria-pressed={true}
              aria-label={t(`取消固定 ${f.label}`, `Unpin ${f.label}`)}
              title={t("取消固定（移入更多）", "Unpin (moves to More)")}
              className="shrink-0 rounded-md p-1.5 text-faint transition hover:bg-black/5 hover:text-ink md:opacity-0 md:focus-visible:opacity-100 md:group-hover/feature:opacity-100"
            >
              <IconPin size={13} className="text-brand" />
            </button>
          </div>
        ))}
        {hiddenEntries.length > 0 && (
          <button
            type="button"
            onClick={toggleMore}
            className="side-row text-ink-2 hover:text-ink"
            aria-label={t("更多", "More")}
            aria-haspopup="menu"
            aria-expanded={moreAnchor !== null}
            title={t("更多", "More")}
          >
            <IconGrid size={15} />
            <span className="text-[12.5px]">{t("更多", "More")}</span>
          </button>
        )}
      </div>

      {/* 工具条：标题 + 三个动作；点搜索时**在工具条里就地展开输入框**（对齐 DSH 的
          section 头），不再另起一行把下面的列表整体顶下去——搜索的瞬间正读到哪一条
          不该跟着跳。高度固定 36px（DSH 的 --workspace-toolbar-height），展开与收起
          都不改变列表的起点。 */}
      <div className="mt-4 flex h-9 items-center gap-1 px-3">
        {!searchOpen ? (
          <>
            <span className="text-[12px] font-medium text-muted">{t("工作区", "Workspaces")}</span>
            <div className="ml-auto flex items-center gap-0.5">
              <button
                type="button"
                ref={searchButton}
                onClick={() => setSearchOpen(true)}
                className="rounded-md p-1.5 text-muted hover:bg-black/5 hover:text-ink"
                aria-label={t("搜索对话", "Search conversations")}
                title={t("搜索", "Search")}
              >
                <IconSearch size={15} />
              </button>
              <button
                type="button"
                onClick={(e) => setViewAnchor((prev) => (prev ? null : e.currentTarget))}
                className={`rounded-md p-1.5 hover:bg-black/5 ${
                  view.group !== "workspace" || view.sort !== "recent" || view.archive !== "hide"
                    ? "text-brand"
                    : "text-muted hover:text-ink"
                }`}
                aria-label={t("分组、排序与筛选", "Grouping, sorting and filtering")}
                aria-haspopup="menu"
                aria-expanded={viewAnchor !== null}
                title={t("分组、排序与筛选", "Grouping, sorting and filtering")}
              >
                <IconSliders size={15} />
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
          </>
        ) : (
          <div
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-line-strong bg-canvas px-2 py-1 focus-within:border-brand/60"
            // Esc 挂在包住输入框与「取消」的这一层：焦点 Tab 到「取消」上时用户仍然
            // 期待 Esc 能退出搜索。`isComposing` 必须判——中文输入法用 Esc 取消候选时
            // 也会走到这里，那一刻不该顺手把搜索关掉、把已输入的内容清空。
            onKeyDown={(e) => {
              if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
              e.stopPropagation();
              closeSearch();
            }}
          >
            <IconSearch size={13} className="shrink-0 text-faint" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("搜索工作区或对话", "Search workspaces or conversations")}
              aria-label={t("搜索工作区或对话", "Search workspaces or conversations")}
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-faint"
            />
            {/* 按钮上有可见文字「取消」就不再挂 `aria-label`：可访问名要包含可见文本
                （WCAG 2.5.3），覆盖成「关闭搜索」会让语音控制念不出屏幕上那个词。 */}
            <button
              type="button"
              onClick={closeSearch}
              className="shrink-0 rounded px-1 text-[11px] text-muted transition hover:bg-black/5 hover:text-ink"
            >
              {t("取消", "Cancel")}
            </button>
          </div>
        )}
      </div>

      <div ref={wsListRef} className="dsh-scroll mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-3" onScroll={endHover}>
        {/* 空列表有两种意思，别都给「添加授权目录」那张卡：搜索没有命中时摆一颗
            加号会让人以为「这个搜索还得先加个工作区」。 */}
        {groups.length === 0 &&
          (query.trim() ? (
            <p className="mt-6 px-2 text-center text-[11.5px] leading-relaxed text-faint">
              {t("没有匹配的工作区或对话", "No matching workspaces or conversations")}
            </p>
          ) : (
            <button
              type="button"
              onClick={onAddWorkspace}
              className="mt-6 flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong px-4 py-6 text-center hover:bg-black/[0.02]"
            >
              <IconFolder size={22} className="text-faint" />
              <span className="text-[12px] font-medium text-ink">{t("添加授权目录", "Add authorized directory")}</span>
              <span className="text-[11px] leading-relaxed text-muted">{t("授权一个目录后，Claude 就能在其中工作。", "Authorize a directory and Claude can work there.")}</span>
            </button>
          ))}

        {groups.map((g) => {
          // 单列表：没有工作区分组标题，行首标出所属工作区。
          if (g.path === FLAT_KEY) {
            return (
              <div key={FLAT_KEY} className="mb-1">
                {g.conversations.length === 0 && (
                  <p className="px-2 py-1.5 text-[11px] text-faint">{t("暂无对话", "No conversations")}</p>
                )}
                {g.conversations.map((c) => renderConversation(c, FLAT_KEY, true))}
              </div>
            );
          }
          const open = expanded.has(g.path) || Boolean(query.trim());
          const isCurrent = g.path === currentWorkspace;
          // 组内会话里有当前这条（或它的子代理会话）→ 图标上主题色。
          const holdsActive = Boolean(activeId) && g.conversations.some((c) => c.id === activeId);
          // 这里只算「这一组现在露出几条」：可见项是排好序（最近更新优先）之后的尾部被折起来。
          const shown = query.trim()
            ? g.conversations
            : moreSessions.has(g.path)
              ? g.conversations
              : g.conversations.slice(0, SESSION_GROUP_LIMIT);
          const hiddenCount = g.conversations.length - shown.length;
          return (
            <div
              key={g.path}
              className="mb-1"
              style={g.depth > 0 ? { marginLeft: g.depth * 12 } : undefined}
            >
              {/* 高亮只画在悬停上（对齐 DSH）：当前工作区不再常亮——点击工作区行只负责
                  展开/收起，常亮那个底色会让人以为这里是「已选中的导航项」。
                  悬停高亮画在整行上（含右侧「⋯ / +」），只包住名字时底色会在图标前截断。 */}
              <div
                className={`group side-row relative gap-1 ${
                  wsReorderable && g.path !== OTHER_KEY ? "cursor-grab" : ""
                } ${wsDrag?.path === g.path ? "cursor-grabbing select-none opacity-50" : ""} ${
                  wsDrag?.over?.path === g.path ? "select-none" : ""
                }`}
                data-workspace={g.path}
                onPointerDown={wsReorderable ? (e) => onWsPointerDown(e, g) : undefined}
                onPointerMove={wsReorderable ? onWsPointerMove : undefined}
                // 只认发起拖拽的那个指针：第二根手指在任意行抬起不能结束这一次拖拽。
                onPointerUp={wsReorderable ? (e) => guardWsPointer(e.pointerId, () => endWsPress(true)) : undefined}
                onPointerCancel={wsReorderable ? (e) => guardWsPointer(e.pointerId, () => endWsPress(false)) : undefined}
                // 指针捕获被系统收回（元素重挂、拖出窗口）：当作取消，别留下半截状态。
                onLostPointerCapture={wsReorderable ? () => endWsPress(false) : undefined}
                onContextMenu={wsDrag ? (e) => e.preventDefault() : undefined}
                // 拖动结束后补发的那一次 click 会落在行内的按钮上：在捕获阶段吞掉，
                // 否则松手会把这一组展开/收起，或者弹出「工作区操作」菜单。
                onClickCapture={(e) => {
                  if (!wsSuppressClick.current) return;
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onPointerEnter={g.path === OTHER_KEY ? undefined : (e) => armHover(e, { kind: "ws", group: g })}
                onPointerLeave={endHover}
              >
                {wsDrag?.over?.path === g.path && wsDrag.path !== g.path && (
                  <span
                    className={`side-drop-line ${
                      wsDrag.over.half === "before" ? "side-drop-line-before" : "side-drop-line-after"
                    }`}
                  />
                )}
                <button
                  type="button"
                  onClick={() => onWorkspaceClick(g)}
                  disabled={!g.exists}
                  aria-expanded={open}
                  className={`flex min-w-0 flex-1 items-center gap-2 text-left ${isCurrent ? "text-ink" : "text-ink-2"} ${!g.exists ? "opacity-50" : ""}`}
                >
                  {/* 图标位（对齐 DSH）：平时是工作区文件夹，悬停/聚焦时换成展开箭头方向；
                      收起与展开是两张不同的文件夹，一眼能看出这组现在开着还是关着——
                      触屏没有 hover，状态只能靠这两张图区分。
                      组里有当前对话时图标带主题色：不用展开也知道「人在哪一组」。
                      两者叠在同一个 15px 的格子里靠透明度互换：换成背景色盖一层时，
                      行的悬停底色和那个小方块对不上，会露出一块补丁。 */}
                  <span
                    data-ws-active={holdsActive ? "true" : undefined}
                    className={`relative flex h-[15px] w-[15px] shrink-0 items-center justify-center ${
                      holdsActive ? "text-brand" : "text-muted"
                    }`}
                  >
                    <span className="flex items-center justify-center transition-opacity group-hover:opacity-0 group-has-focus-visible:opacity-0">
                      {/* 「其他对话」不是真目录，仍然用终端图标区分开；折叠/展开的
                          两张文件夹图只给真工作区。 */}
                      {g.path === OTHER_KEY ? (
                        <IconTerminal size={15} data-ws-icon="other" />
                      ) : open ? (
                        <IconFolderOpen size={15} data-ws-icon="open" />
                      ) : (
                        <IconFolder size={15} data-ws-icon="closed" />
                      )}
                    </span>
                    <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 group-has-focus-visible:opacity-100">
                      {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                    </span>
                  </span>
                  <span className="truncate text-[12.5px] font-medium">{g.name}</span>
                  {!g.exists && g.path !== OTHER_KEY && <span className="shrink-0 text-[10px] text-warn">{t("不可用", "Missing")}</span>}
                </button>
                {g.path !== OTHER_KEY && (
                  <>
                    <button
                      type="button"
                      onClick={(e) => openWsMenu(e, g)}
                      className="rounded-md p-1 text-muted transition hover:bg-black/5 hover:text-ink md:opacity-0 md:group-hover:opacity-100 md:group-has-focus-visible:opacity-100"
                      aria-label={`${t("工作区操作", "Workspace actions")} ${g.path}`}
                      aria-haspopup="menu"
                      title={t("更多", "More")}
                    >
                      <IconMore size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        // 与 startNewChat 同一条规矩：先回对话区再建会话。少了这一步，
                        // 功能区整页视图还盖在上面，新对话建好了也看不见（入口仍在原地高亮）。
                        onOpenChat?.();
                        void startConversationIn(g.path);
                        // 移动端：抽屉里发起的「新建对话」都要让出位置，直接落到新会话上。
                        onClose?.();
                      }}
                      className="rounded-md p-1 text-muted transition hover:bg-black/5 hover:text-ink md:opacity-0 md:group-hover:opacity-100 md:group-has-focus-visible:opacity-100"
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
                  {shown.map((c) => renderConversation(c, g.path, false))}
                  {/* 超过 5 条时只露最近更新的前几条（对齐 DSH）：侧栏是导航，
                      不是清单。折叠的是排好序之后的尾部，所以「最近更新优先」在
                      收起状态下同样成立；搜索时一律全露，不然搜索结果会被截掉。 */}
                  {hiddenCount > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        setMoreSessions((prev) => {
                          const next = new Set(prev);
                          next.add(g.path);
                          return next;
                        })
                      }
                      className="side-row text-faint hover:text-ink-2"
                    >
                      <span className="pl-[22px] text-[11.5px]">{t(`展开其余 ${hiddenCount} 个会话`, `Show ${hiddenCount} more conversations`)}</span>
                    </button>
                  )}
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
        {authRequired && (
          <button type="button" onClick={() => void logout()} className="side-row text-muted hover:text-ink">
            <IconLogout size={15} />
            <span className="text-[12px]">{t("退出登录", "Sign out")}</span>
          </button>
        )}
        <button type="button" onClick={onOpenSettings} className="side-row text-muted hover:text-ink">
          <IconSettings size={15} />
          <span className="text-[12px]">{t("设置", "Settings")}</span>
        </button>
      </div>

      <Menu
        open={Boolean(wsMenu)}
        anchor={wsMenu?.anchor ?? null}
        onClose={() => setWsMenu(null)}
        items={
          wsMenu
            ? ([
                // 上移/下移与拖拽是**两条并列的入口**（会话排序也是这么分的）：
                // 触屏上拖拽要长按，键盘与读屏根本拿不到落点，没有这一对就等于
                // 「只有鼠标能改顺序」。顺序只在本设备生效，见 lib/sidebarView。
                ...(wsReorderable && wsMenu.path !== FLAT_KEY
                  ? [
                      {
                        id: "move-up",
                        label: t("上移", "Move up"),
                        icon: <IconChevronUp size={13} className="text-muted" />,
                        disabled: !wsCanStep(wsMenu.path, -1),
                        onSelect: () => stepWsOrder(wsMenu.path, -1),
                      },
                      {
                        id: "move-down",
                        label: t("下移", "Move down"),
                        icon: <IconChevronDown size={13} className="text-muted" />,
                        disabled: !wsCanStep(wsMenu.path, 1),
                        onSelect: () => stepWsOrder(wsMenu.path, 1),
                      },
                    ]
                  : []),
                { id: "rename", label: t("重命名", "Rename"), icon: <IconPencil size={13} className="text-muted" />, onSelect: () => void askRenameWorkspace(wsMenu) },
                { id: "reveal", label: t("在文件夹显示", "Show in files"), icon: <IconFolder size={13} className="text-muted" />, onSelect: () => revealWorkspace(wsMenu) },
                { id: "remove", label: t("删除工作区", "Delete workspace"), icon: <IconTrash size={13} />, danger: true, onSelect: () => void askRemove(wsMenu.path) },
              ] satisfies MenuItem[])
            : []
        }
      />

      <Menu
        open={moreAnchor !== null}
        anchor={moreAnchor}
        onClose={() => setMoreAnchor(null)}
        width={216}
        align="start"
        items={moreItems}
      />

      {hover?.kind === "conv" && (
        <ConversationPreview
          anchor={hover.anchor}
          conv={hover.conv}
          title={titleOf(hover.conv)}
          path={hover.conv.cwd}
          status={statusOf(hover.conv)}
        />
      )}

      {hover?.kind === "ws" && (
        <WorkspacePreview
          anchor={hover.anchor}
          name={hover.group.name}
          path={hover.group.path}
          exists={hover.group.exists}
          count={hover.group.conversations.length}
          lastUsed={hover.group.workspace?.last_used}
        />
      )}

      <Menu
        open={viewAnchor !== null}
        anchor={viewAnchor}
        onClose={() => setViewAnchor(null)}
        width={236}
        align="end"
        items={
          [
            {
              id: "g-workspace",
              group: t("分组方式", "Group by"),
              label: t("按工作区", "By workspace"),
              icon: <IconFolder size={13} className="text-muted" />,
              checked: view.group === "workspace",
              onSelect: () => setView((v) => ({ ...v, group: "workspace" })),
            },
            {
              id: "g-tree",
              label: t("按工作区树", "By workspace tree"),
              icon: <IconGitBranch size={13} className="text-muted" />,
              checked: view.group === "tree",
              onSelect: () => setView((v) => ({ ...v, group: "tree" })),
            },
            {
              id: "g-flat",
              label: t("单列表", "Single list"),
              icon: <IconPanel size={13} className="text-muted" />,
              checked: view.group === "flat",
              onSelect: () => setView((v) => ({ ...v, group: "flat" })),
            },
            {
              id: "s-manual",
              group: t("排序方式", "Sort by"),
              label: t("手动排序", "Manual order"),
              icon: <IconMore size={13} className="text-muted" />,
              checked: view.sort === "manual",
              onSelect: () => setView((v) => ({ ...v, sort: "manual" })),
            },
            {
              id: "s-recent",
              label: t("最近更新", "Last updated"),
              icon: <IconClock size={13} className="text-muted" />,
              checked: view.sort === "recent",
              onSelect: () => setView((v) => ({ ...v, sort: "recent" })),
            },
            {
              id: "f-hide",
              group: t("筛选会话", "Filter sessions"),
              label: t("隐藏已归档", "Hide archived"),
              icon: <IconArchive size={13} className="text-muted" />,
              checked: view.archive === "hide",
              onSelect: () => setView((v) => ({ ...v, archive: "hide" })),
            },
            {
              id: "f-all",
              label: t("全部对话（显示已归档）", "All (show archived)"),
              icon: <IconHistory size={13} className="text-muted" />,
              checked: view.archive === "all",
              onSelect: () => setView((v) => ({ ...v, archive: "all" })),
            },
            {
              id: "f-only",
              label: t(
                `仅显示已归档${archivedCount ? `（${archivedCount}）` : ""}`,
                `Archived only${archivedCount ? ` (${archivedCount})` : ""}`,
              ),
              icon: <IconArchive size={13} className="text-muted" />,
              checked: view.archive === "only",
              onSelect: () => setView((v) => ({ ...v, archive: "only" })),
            },
          ] satisfies MenuItem[]
        }
      />

      <Menu
        open={Boolean(menu && menuConv)}
        anchor={menu?.anchor ?? null}
        onClose={() => setMenu(null)}
        width={208}
        items={
          menuConv
            ? ([
                { id: "rename", label: t("重命名", "Rename"), icon: <IconPencil size={13} className="text-muted" />, onSelect: () => void askRename(menuConv) },
                {
                  id: "pin",
                  label: menuConv.pinned ? t("取消置顶", "Unpin") : t("置顶", "Pin"),
                  icon: <IconPin size={13} className={menuConv.pinned ? "text-brand" : "text-muted"} />,
                  onSelect: () => void pinConversation(menuConv.id, !menuConv.pinned),
                },
                { id: "archive", label: menuConv.archived ? t("取消归档", "Unarchive") : t("归档", "Archive"), icon: <IconArchive size={13} className={menuConv.archived ? "text-brand" : "text-muted"} />, onSelect: () => askArchive(menuConv) },
                {
                  id: "fork",
                  // 复制的是上下文，不是权限：新进程要重新审批（CLI 的 fork 语义）。
                  label: t("分叉会话", "Fork conversation"),
                  icon: <IconGitBranch size={13} className="text-muted" />,
                  onSelect: () => void forkConversation(menuConv.id, `${titleOf(menuConv)}${t("（分叉）", " (fork)")}`),
                },
                ...(SHOW_COPY_SESSION_ID
                  ? [
                      {
                        id: "copy-id",
                        label: t("复制 Session ID", "Copy session ID"),
                        // 前 8 位让人确认"复制的是哪一条"，完整 id 在剪贴板里。
                        hint: menuConv.id.slice(0, 8),
                        icon: <IconCopy size={13} className="text-muted" />,
                        onSelect: () => void copySessionId(menuConv),
                      },
                    ]
                  : []),
                ...(view.sort === "manual" && groupOf(menuConv)
                  ? [
                      {
                        id: "move-up",
                        label: t("上移", "Move up"),
                        icon: <IconChevronUp size={13} className="text-muted" />,
                        onSelect: () => {
                          const g = groupOf(menuConv);
                          if (g) stepOrder(g.path, g.conversations, menuConv.id, -1);
                        },
                      },
                      {
                        id: "move-down",
                        label: t("下移", "Move down"),
                        icon: <IconChevronDown size={13} className="text-muted" />,
                        onSelect: () => {
                          const g = groupOf(menuConv);
                          if (g) stepOrder(g.path, g.conversations, menuConv.id, 1);
                        },
                      },
                    ]
                  : []),
                ...(menuConv.live
                  ? [
                      // 两条都是对正在跑的进程动手：用主题色从一堆灰条目里跳出来。
                      { id: "restart", brand: true, label: t("重启进程", "Restart process"), icon: <IconRetry size={13} className="text-brand" />, onSelect: () => void askRestart(menuConv) },
                      { id: "stop", brand: true, label: t("结束进程", "Stop process"), icon: <IconStop size={13} className="text-brand" />, onSelect: () => void askStop(menuConv) },
                    ]
                  : []),
                { id: "delete", label: t("删除", "Delete"), icon: <IconTrash size={13} />, danger: true, onSelect: () => void askDelete(menuConv) },
              ] satisfies MenuItem[])
            : []
        }
      />
    </aside>
  );
}
