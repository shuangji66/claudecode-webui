import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useT } from "../../lib/i18n";
import { useWheelScrollX } from "../../lib/wheelScroll";
import { useSidebarStore } from "../../store/useSidebarStore";
import { FilesPanel } from "./FilesPanel";
import { GitPanel } from "./GitPanel";
import {
  IconClose,
  IconExitFullscreen,
  IconFolder,
  IconFullscreen,
  IconGitBranch,
  IconPanel,
  IconPlus,
  IconSpark,
  IconSplit,
  IconTerminal,
  IconUnsplit,
} from "../common/Icons";
import { SubagentPanel } from "./SubagentPanel";
import { useAppStore } from "../../store/useAppStore";

const TerminalView = lazy(() => import("./TerminalView"));

/** 一个标签页；终端每个会话各占一个，子代理对话按 agentId 各占一个。 */
type TabKind = "files" | "git" | "terminal" | "subagent";

/** 分栏后的两栏；不分栏时所有标签都算在 `a` 栏。 */
type PaneId = "a" | "b";

interface Tab {
  id: string;
  kind: TabKind;
  label: string;
  /** 这个标签当前停在哪一栏（分栏关闭时忽略，统一按 `a` 渲染）。 */
  pane: PaneId;
  /** 子代理标签：打开时的会话 id 与 agent id（切换对话后仍指向原来那个子代理）。 */
  sessionId?: string;
  agentId?: string;
}

interface Props {
  cwd: string;
  onClose: () => void;
  /**
   * 整个侧栏是否真的看得见。
   *
   * 功能区整页视图打开时侧栏只是 `display: none`（不卸载，否则终端会被 SIGHUP），
   * 此时 Git 面板仍是「激活标签」，但它要是在后台继续订阅，NAS 上就会没人看也每 3 秒
   * 跑一次 git。所以「激活」要再与可见性相与。
   */
  visible?: boolean;
}

const WIDTH_KEY = "ccweb-right-width";
const FULLSCREEN_KEY = "ccweb-right-fullscreen";
/** 分栏时每一边最少占的宽度比例：再窄连一个标签标题都放不下。 */
const SPLIT_MIN = 0.25;
const SPLIT_MAX = 0.75;
const SPLIT_DEFAULT = 0.5;
/** 分两栏所需的最小面板宽度（两栏各 280px）。不够时先试着把面板撑宽，
 *  视口也放不下就不给分栏入口——两栏各一百多像素连标签都排不下。 */
const SPLIT_MIN_WIDTH = 560;
export const RIGHT_MIN_WIDTH = 300;
const RIGHT_MAX_WIDTH = 680;
const RIGHT_DEFAULT_WIDTH = 380;
/** 桌面左侧栏宽度（与 Sidebar 的 md:w-[280px] 一致）。 */
const LEFT_WIDTH = 280;
/** 对话区最小可用宽度：右侧栏再宽也不能把中间挤成一条缝。 */
const MIN_CHAT_WIDTH = 420;
/** 低于这个视口宽度就改成浮层，不再和对话区抢横向空间。 */
const DOCK_MIN = LEFT_WIDTH + MIN_CHAT_WIDTH + RIGHT_MIN_WIDTH;
/** 与后端 maxTerminals 一致：一个进程最多 8 个终端。 */
const MAX_TERMINALS = 8;

function readWidth(): number {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= RIGHT_MIN_WIDTH) return Math.min(raw, RIGHT_MAX_WIDTH);
  } catch {
    /* 隐私模式 */
  }
  return RIGHT_DEFAULT_WIDTH;
}

/** 全屏偏好只存浏览器：每台设备的屏幕尺寸不同，不该跟着 settings.json 走。 */
function readFullscreen(): boolean {
  try {
    return localStorage.getItem(FULLSCREEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** 宽度同时受三件事约束：用户拖动值、视口比例、以及「给对话区留够地方」。 */
export function clampWidth(width: number, viewport = typeof window === "undefined" ? 1440 : window.innerWidth): number {
  const viewportMax = Math.max(RIGHT_MIN_WIDTH, viewport * 0.7);
  const chatMax = viewport - LEFT_WIDTH - MIN_CHAT_WIDTH;
  const max = Math.max(RIGHT_MIN_WIDTH, Math.min(RIGHT_MAX_WIDTH, viewportMax, chatMax));
  return Math.round(Math.min(Math.max(width, RIGHT_MIN_WIDTH), max));
}

/**
 * 跟踪视口宽度。
 *
 * 停靠判定和宽度收敛都必须是**响应式**的：窗口缩小时右侧栏要自己跟着变窄，
 * 而不是等用户拖一下才被 clamp 住。
 */
export function useViewportWidth(): number {
  const [viewport, setViewport] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return viewport;
}

const KIND_ICON = { files: IconFolder, git: IconGitBranch, terminal: IconTerminal, subagent: IconSpark } as const;

interface DockProps {
  /** 用户是否打开着右侧栏。 */
  open: boolean;
  /** 功能区整页视图是否盖住了侧栏（侧栏被隐藏，但不要卸载）。 */
  covered: boolean;
  cwd: string;
  onClose: () => void;
}

/**
 * 右侧栏的挂载壳：**关掉只隐藏、不卸载**。
 *
 * 卸载等于把里面的标签全丢一遍：顶部标签、当前选中的那个、文件预览、终端 PTY
 * （`TerminalView` 的清理会 `close()` 掉 WS，后端随之 SIGHUP shell）。移动端关抽屉
 * 是高频动作，卸载一次就得从头开标签、重建终端，用户看到的就是「关一下标签就没了」。
 * 所以这里用 `display: none` 保留整棵子树，PTY 与跑着的命令继续活着；`visible` 传
 * false 让 Git 面板停掉 3 秒一次的订阅——看不见的屏幕上不该继续跑 git。
 *
 * 首次打开前不挂载（`RightSidebar` 是懒加载 chunk，没开过就不该下载）。
 */
export function RightSidebarDock({ open, covered, cwd, onClose }: DockProps) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  if (!mounted) return null;
  const shown = open && !covered;
  return (
    <div className={shown ? "contents" : "hidden"}>
      <RightSidebar cwd={cwd} onClose={onClose} visible={shown} />
    </div>
  );
}

/**
 * 右侧栏：顶部一排标签页（文件 / Git / 每个终端各一个），桌面停靠、移动端全屏抽屉。
 *
 * 参照 DSH：没有「启动页 + 返回」那种切换，标签本身就是入口与关闭按钮，`+` 回到开始页。
 * **标签切走不卸载**：终端里挂着 PTY，卸载等于杀 shell；关掉标签才结束进程。
 *
 * 桌面还有两件事（同样对齐 DSH）：
 *   - **全屏**：整块侧栏铺满视口（对话区留在下面不卸载），再点一次恢复停靠宽度；
 *   - **分栏**：左右两栏各自一排标签，可以同时看「文件 + Git」或「文件 + 终端」。
 *     所有标签面板始终挂在同一层里、只改定位与可见性，所以把标签在栏之间移动
 *     **不会重挂组件**——否则终端会连同 PTY 一起被杀掉（关掉标签才该结束 shell）。
 */
export function RightSidebar({ cwd, onClose, visible = true }: Props) {
  const t = useT();
  const setCwd = useSidebarStore((s) => s.setCwd);
  const openRequest = useSidebarStore((s) => s.openRequest);
  const consumeOpenFile = useSidebarStore((s) => s.consumeOpenFile);
  const clearSubagentView = useAppStore((s) => s.clearSubagentView);
  // 存的是用户偏好；实际宽度每次都按当前视口收敛，窗口缩小后立刻跟着变窄。
  const [preferredWidth, setPreferredWidth] = useState(readWidth);
  const viewport = useViewportWidth();
  const docked = viewport >= DOCK_MIN;
  const width = clampWidth(preferredWidth, viewport);

  const [fullscreen, setFullscreen] = useState(readFullscreen);
  const fullActive = fullscreen && docked;

  // 分栏：只有停靠、且面板放得下两栏时 `splitActive` 才成立。宽度或视口不够时
  // 下面的 effect 会把两栏合回一栏（`split=false`），不留一个看不见的 B 栏。
  const [split, setSplit] = useState(false);
  const canSplit = docked && clampWidth(SPLIT_MIN_WIDTH, viewport) >= SPLIT_MIN_WIDTH;
  const splitActive = split && canSplit && width >= SPLIT_MIN_WIDTH && Boolean(cwd);
  const [ratio, setRatio] = useState(SPLIT_DEFAULT);
  const [focused, setFocused] = useState<PaneId>("a");

  // 初始停在开始页：不自动开「文件」标签，由用户点卡片决定。
  //
  // `active` 为空串就是「这一栏在开始页」这个视图：顶部 `+` 是回到它的入口，
  // 标签行不卸载，否则终端里的 PTY 会被 SIGHUP（见下面的渲染分支）。
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeA, setActiveA] = useState("");
  const [activeB, setActiveB] = useState("");
  const termSeq = useRef(0);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const splitDrag = useRef<{ startX: number; startRatio: number; width: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // 标签一多就横向溢出：滚动条藏在 `dsh-scroll-none` 后面，靠滚轮/触控板横向滑。
  const tabStripA = useRef<HTMLDivElement | null>(null);
  const tabStripB = useRef<HTMLDivElement | null>(null);
  useWheelScrollX(tabStripA);
  useWheelScrollX(tabStripB, splitActive);
  const subagentView = useAppStore((s) => s.subagentView);
  const activeSession = useAppStore((s) => s.activeId);
  const handledSubagent = useRef(0);

  /** 标签实际落在哪一栏：不分栏时所有标签都按 `a` 渲染。 */
  const paneOf = (tab: Tab): PaneId => (splitActive ? tab.pane : "a");

  /** 文件 / Git / 子代理在**每一栏各占一份**，id 带栏后缀；终端每次新建，id 已唯一。 */
  const scopedId = (base: string, pane: PaneId) => `${base}-${pane}`;

  /** 某一栏当前激活的标签；引用的标签不在这一栏时按「开始页」处理。 */
  const activeOf = (pane: PaneId): string => {
    const id = pane === "a" ? activeA : activeB;
    if (!id) return "";
    return tabs.some((tab) => tab.id === id && paneOf(tab) === pane) ? id : "";
  };

  const setActiveFor = (pane: PaneId, id: string) => {
    if (pane === "a") setActiveA(id);
    else setActiveB(id);
    setFocused(pane);
  };

  // 窗口缩到不再停靠、或者拖到放不下两栏时合回一栏：移动端是全屏抽屉，
  // 300px 的面板里两栏各只剩一百多像素。
  // 这里是**用户意图复位**（split=false），不是每次渲染临时折叠——留着一个看不见的
  // B 栏只会让标签列表与当前激活项对不上。
  useEffect(() => {
    if (!split) return;
    if (docked && width >= SPLIT_MIN_WIDTH) return;
    foldPanes();
    // foldPanes 只读当前渲染的 tabs / active，不放进依赖数组（与其它标签逻辑一致）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docked, split, width]);

  // 聊天里的「查看对话」只放一个请求到 store，标签的打开/切换留在这里做。
  //
  // 处理完必须把请求清掉：右侧栏关掉再打开会重新挂载，`handledSubagent` 这类 ref
  // 归零，留着请求就会被重放（用户只是收了侧栏，又被送进一个子代理标签）。
  useEffect(() => {
    if (!subagentView || subagentView.nonce === handledSubagent.current) return;
    handledSubagent.current = subagentView.nonce;
    if (!activeSession) return;
    openSubagentTab(activeSession, subagentView.agentId, subagentView.label);
    clearSubagentView();
    // openSubagentTab 只依赖 setState，故意不放进依赖数组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subagentView, activeSession]);

  // 工作区切换 / 侧栏重新可见时刷新一次数据；所有面板都读同一份 store。
  //
  // 换工作区时必须**结束**终端与子代理标签：旧 shell 的 cwd 已经不成立，
  // 而 TerminalView 的建连 effect 依赖 cwd，留着标签只会让它静默重启一个新 shell ——
  // scrollback 全丢，连隐藏的标签也会起一个用户没要求的新进程。
  //
  // 「重新可见」也要刷新：右侧栏收起现在是只隐藏不卸载（见 RightSidebarDock），
  // 不再靠重新挂载来重拉数据。不补这一步的话，收着侧栏时文件变了、分支切了，
  // 再打开看到的还是收起前那一屏。两件事合在一个 effect 里，是为了不重复请求——
  // 换工作区的同时重开侧栏只会发一轮，而不是两轮。
  const firstCwd = useRef(true);
  const seenCwd = useRef(cwd);
  const seenVisible = useRef(visible);
  useEffect(() => {
    const cwdChanged = seenCwd.current !== cwd;
    const becameVisible = visible && !seenVisible.current;
    seenCwd.current = cwd;
    seenVisible.current = visible;
    if (firstCwd.current) {
      firstCwd.current = false;
      void setCwd(cwd);
      return;
    }
    if (!cwdChanged && !becameVisible) return;
    if (cwdChanged) {
      termSeq.current = 0;
      // 文件 / Git 标签各自留在原来那一栏（换工作区不该把两栏收成一栏）；
      // 终端与子代理仍然结束——旧 shell 的 cwd 已不成立。
      const kept = tabs.filter((tab) => tab.kind === "files" || tab.kind === "git");
      setTabs(kept);
      setActiveA(kept.find((tab) => tab.pane === "a")?.id ?? "");
      setActiveB(kept.find((tab) => tab.pane === "b")?.id ?? "");
      setFocused(kept.some((tab) => tab.pane === "b") ? "b" : "a");
    }
    // 看不见的时候只收拾标签，不发请求：收着侧栏（或功能区盖着）时切工作区，
    // 数据留给「重新可见」那一次，别让没人看的界面向 NAS 拉目录树和 git status。
    if (visible) void setCwd(cwd);
  }, [cwd, visible, setCwd]);

  const applyWidth = (next: number) => {
    const value = clampWidth(next, viewport);
    setPreferredWidth(value);
    try {
      localStorage.setItem(WIDTH_KEY, String(value));
    } catch {
      /* 隐私模式 */
    }
  };

  const toggleFullscreen = () => {
    setFullscreen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(FULLSCREEN_KEY, next ? "1" : "0");
      } catch {
        /* 隐私模式 */
      }
      return next;
    });
  };

  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    drag.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // 左缘向左拖 = 变宽。
    applyWidth(drag.current.startWidth + (drag.current.startX - event.clientX));
  };
  const onResizeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* 指针已释放 */
    }
  };
  const onResizeKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      applyWidth(width + 16);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      applyWidth(width - 16);
    } else if (event.key === "Home") {
      event.preventDefault();
      applyWidth(RIGHT_MIN_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      applyWidth(RIGHT_MAX_WIDTH);
    }
  };

  const onSplitStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    const el = bodyRef.current;
    if (!splitActive || !el) return;
    event.preventDefault();
    splitDrag.current = { startX: event.clientX, startRatio: ratio, width: el.getBoundingClientRect().width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onSplitMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = splitDrag.current;
    if (!current || current.width <= 0) return;
    const next = current.startRatio + (event.clientX - current.startX) / current.width;
    setRatio(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, next)));
  };
  const onSplitEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    splitDrag.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* 指针已释放 */
    }
  };
  const onSplitKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.08 : 0.02;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setRatio((value) => Math.max(SPLIT_MIN, value - step));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setRatio((value) => Math.min(SPLIT_MAX, value + step));
    }
  };

  /**
   * 打开标签：文件 / Git / 子代理在**每一栏各占一份**，终端每次新建。
   *
   * 分栏时目标栏默认是**当前聚焦的那一栏**：点哪一栏的卡片就在哪一栏打开。
   * 同一种面板在另一栏里开着**不搬过来**——搬走会让那一栏突然空掉，用户看到的
   * 就是「分栏后还是只能同时看一个面板」；而两栏各开一份文件 / Git 本来就有用
   * （左边浏览、右边预览另一个）。同一栏里已经开着才切过去。
   */
  const openTab = (kind: TabKind, pane?: PaneId): PaneId => {
    const target: PaneId = splitActive ? (pane ?? focused) : "a";
    if (kind === "terminal") {
      if (tabs.filter((tab) => tab.kind === "terminal").length >= MAX_TERMINALS) return target;
      termSeq.current += 1;
      const n = termSeq.current;
      const id = `term-${n}`;
      // 第一个叫 bash，之后编号；序号单调递增，关掉中间那个也不会重排。
      setTabs((prev) => [...prev, { id, kind: "terminal", label: n === 1 ? "bash" : `bash ${n}`, pane: target }]);
      setActiveFor(target, id);
      return target;
    }
    const id = scopedId(kind, target);
    if (!tabs.some((tab) => tab.id === id)) {
      const label = kind === "files" ? t("文件", "Files") : t("Git", "Git");
      setTabs((prev) => [...prev, { id, kind, label, pane: target }]);
    }
    setActiveFor(target, id);
    return target;
  };

  const handledOpenFile = useRef(0);
  /**
   * 正文灯箱「在右侧栏打开」的目标路径。
   *
   * 这里是**唯一**的消费者：往下透传给 FilesPanel。让 FilesPanel 自己订阅 store
   * 会踩到「先开标签、面板后挂载」的时序——两个消费方各读一个 seq，先挂载的那个
   * 把它用掉，后挂载的就永远看不到请求（首次进入前端时只开标签、不进预览）。
   */
  const [pendingOpen, setPendingOpen] = useState<{ path: string; seq: number; pane: PaneId } | null>(null);
  useEffect(() => {
    const req = openRequest;
    if (!req || req.seq <= handledOpenFile.current) return;
    handledOpenFile.current = req.seq;
    // 在**当前聚焦的那一栏**打开文件面板，并把这这次请求只交给那一栏的面板：
    // 两栏各有一份 FilesPanel 时，不限定栏位等于两边同时跳进同一个预览。
    const target = openTab("files");
    setPendingOpen({ ...req, pane: target });
    // 请求只消费一次：**由 store 记「已处理」，不靠组件内的 ref**。关掉侧栏再打开
    // 会重新挂载，ref 归零，留着请求就会重放（又开一个「文件」标签、又预览那张图）。
    consumeOpenFile();
    // openTab 只依赖 tabs 与 setState；seq 已保证同一个请求只处理一次，
    // 放进依赖数组反而会在标签变化时重复触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest]);

  /** 打开某个子代理的对话：同一栏里同一个 agent 只占一个标签。 */
  const openSubagentTab = (sessionId: string, agentId: string, label: string) => {
    const target: PaneId = splitActive ? focused : "a";
    const id = scopedId(`sub-${sessionId}-${agentId}`, target);
    setTabs((prev) =>
      prev.some((tab) => tab.id === id)
        ? prev
        : [
            ...prev,
            { id, kind: "subagent", label: label || t("子代理", "Subagent"), sessionId, agentId, pane: target },
          ],
    );
    setActiveFor(target, id);
  };

  const closeTab = (id: string) => {
    const hit = tabs.find((tab) => tab.id === id);
    if (!hit) return;
    const pane = paneOf(hit);
    // 「文件」面板关掉后 pending 就没意义了：再打开标签时面板会重新挂载、
    // 消费用的 ref 归零，留着它就会自动跳进上次那个文件的预览。
    if (hit.kind === "files" && pendingOpen?.pane === pane) setPendingOpen(null);
    const siblings = tabs.filter((tab) => paneOf(tab) === pane);
    const at = siblings.findIndex((tab) => tab.id === id);
    const next = tabs.filter((tab) => tab.id !== id);
    const remaining = next.filter((tab) => paneOf(tab) === pane);
    const fallback = remaining[Math.min(Math.max(at, 0), remaining.length - 1)]?.id ?? "";
    setTabs(next);
    if (pane === "a") setActiveA((cur) => (cur === id ? fallback : cur));
    else setActiveB((cur) => (cur === id ? fallback : cur));
  };

  /** 把当前栏分成两栏：A 栏保持原样，B 栏从开始页起步，焦点交给 B。
   *  面板不够宽（默认 380px）时先把面板撑到能放下两栏再分——用户点的是「分栏」，
   *  不是「分栏然后每栏一百多像素」。视口也放不下时按钮本身就不出现（`canSplit`）。 */
  const splitOff = () => {
    if (!canSplit || split) return;
    applyWidth(Math.max(width, SPLIT_MIN_WIDTH));
    setSplit(true);
    setFocused("b");
    setActiveB("");
  };

  /**
   * 两栏并回一栏（点「并回左栏」、窗口变窄或面板被拖窄）。
   *
   * 文件 / Git / 子代理的 id 带栏后缀，并栏时要改回 `-a`；A 栏已经有同一种面板时
   * 丢掉 B 栏那份副本（一栏里只留一份，否则「打开文件」会不知道切哪一份）。
   * 终端 id 不变、只改归属：元素不搬家，PTY 不会被 SIGHUP。
   */
  const foldPanes = () => {
    const next: Tab[] = [];
    const renamed = new Map<string, string>();
    for (const tab of tabs) {
      if (tab.pane === "a") {
        next.push(tab);
        continue;
      }
      if (tab.kind === "terminal") {
        next.push({ ...tab, pane: "a" });
        continue;
      }
      const id = `${tab.id.replace(/-[ab]$/, "")}-a`;
      if (tabs.some((other) => other.id === id)) continue;
      next.push({ ...tab, id, pane: "a" });
      renamed.set(tab.id, id);
    }
    setTabs(next);
    setSplit(false);
    setActiveB("");
    setFocused("a");
    // 待打开的请求原本指向 B 栏的文件面板：并栏后交给 A 栏那一份，
    // 否则请求会落在一个已经不存在的栏位上（用户点了「在右侧栏打开」却什么都没发生）。
    setPendingOpen((prev) => (prev && prev.pane === "b" ? { ...prev, pane: "a" } : prev));
    const keepA = activeA && next.some((tab) => tab.id === activeA) ? activeA : "";
    const fromB = activeB ? (renamed.get(activeB) ?? (next.some((tab) => tab.id === activeB) ? activeB : "")) : "";
    setActiveA(keepA || fromB || next[0]?.id || "");
  };

  const startCards: { kind: TabKind; title: string; desc: string; icon: typeof IconFolder; tone: string }[] = [
    {
      kind: "files",
      title: t("工作区文件", "Workspace files"),
      desc: t("浏览工作区文件", "Browse files"),
      icon: IconFolder,
      tone: "text-warn",
    },
    {
      kind: "git",
      title: t("Git", "Git"),
      desc: t("变更、历史与分支", "Changes and branches"),
      icon: IconGitBranch,
      tone: "text-ok",
    },
    {
      kind: "terminal",
      title: t("新建终端", "New terminal"),
      desc: t("在工作区运行命令", "Run commands"),
      icon: IconTerminal,
      tone: "text-brand",
    },
  ];

  const style = { "--right-w": `${width}px`, "--split": `${Math.round(ratio * 10000) / 100}%` } as CSSProperties;

  /** 一栏的标签条：标签、回到开始页的 `+`、以及这一栏自己的操作按钮。 */
  const renderStrip = (pane: PaneId) => {
    const list = tabs.filter((tab) => paneOf(tab) === pane);
    const current = activeOf(pane);
    const last = pane === "a" ? !splitActive : true;
    return (
      <div
        onPointerDown={() => setFocused(pane)}
        className={`flex min-w-0 items-center gap-0.5 ${pane === "a" && splitActive ? "" : "flex-1"}`}
        style={pane === "a" && splitActive ? { width: "var(--split)" } : undefined}
      >
        <div
          ref={pane === "a" ? tabStripA : tabStripB}
          className="dsh-scroll-none flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overscroll-x-contain px-1.5"
        >
          {current === "" && <span className="shrink-0 px-1.5 text-[12.5px] font-medium text-ink">{t("开始", "Start")}</span>}
          {list.map((tab) => {
            const Icon = KIND_ICON[tab.kind];
            const on = tab.id === current;
            return (
              <span
                key={tab.id}
                className={`flex shrink-0 items-center rounded-lg text-[12px] ${
                  on ? "bg-panel-strong font-medium text-ink" : "text-muted hover:bg-black/[0.03] hover:text-ink"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setActiveFor(pane, tab.id)}
                  aria-pressed={on}
                  className="flex max-w-[9rem] items-center gap-1.5 py-1.5 pl-2 pr-1"
                  title={tab.label}
                >
                  <Icon size={14} className={on ? "shrink-0 text-brand" : "shrink-0"} />
                  <span className="truncate">{tab.label}</span>
                </button>
                <button
                  type="button"
                  onClick={() => closeTab(tab.id)}
                  className="mr-1 rounded p-0.5 text-faint hover:bg-black/5 hover:text-danger"
                  aria-label={t(`关闭 ${tab.label}`, `Close ${tab.label}`)}
                  title={t("关闭该标签", "Close this tab")}
                >
                  <IconClose size={11} />
                </button>
              </span>
            );
          })}
          {/* `+` = 回到开始页，不是下拉菜单：三个入口（文件 / Git / 终端）已经在那三张卡片上，
              再摆一份菜单等于同一件事两个入口。这一栏已经在开始页时不显示它。 */}
          {current !== "" && (
            <button
              type="button"
              onClick={() => setActiveFor(pane, "")}
              className="ml-0.5 shrink-0 rounded-md p-1 text-muted hover:bg-black/5 hover:text-ink"
              aria-label={t("回到开始页", "Back to start")}
              title={t("回到开始页", "Back to start")}
            >
              <IconPlus size={15} />
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 pr-1">
          {pane === "a" && canSplit && !splitActive && (
            <button
              type="button"
              onClick={splitOff}
              className="rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink"
              aria-label={t("分栏", "Split panes")}
              title={t("分成两栏", "Split into two panes")}
            >
              <IconSplit size={15} />
            </button>
          )}
          {pane === "b" && (
            <button
              type="button"
              onClick={foldPanes}
              className="rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink"
              aria-label={t("关闭这一栏", "Close pane")}
              title={t("并回左栏", "Merge into the left pane")}
            >
              <IconUnsplit size={15} />
            </button>
          )}
          {/* 全屏与收起侧栏是**整块面板**的操作，永远放在最右那一栏的末尾
              （对齐 DSH 的 panel chrome）：分栏时放在左栏中间会让人以为只作用于那一栏。 */}
          {last && docked && (
            <button
              type="button"
              onClick={toggleFullscreen}
              className="rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink"
              aria-label={fullActive ? t("退出全屏", "Exit fullscreen") : t("全屏", "Fullscreen")}
              aria-pressed={fullActive}
              title={fullActive ? t("退出全屏", "Exit fullscreen") : t("全屏显示", "Fullscreen")}
            >
              {fullActive ? <IconExitFullscreen size={15} /> : <IconFullscreen size={15} />}
            </button>
          )}
          {last && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink"
              aria-label={t("关闭右侧栏", "Close right sidebar")}
              title={t("关闭", "Close")}
            >
              <IconClose size={16} />
            </button>
          )}
        </div>
      </div>
    );
  };

  /** 一栏的开始页：三张功能卡片，点哪张就在这一栏开哪个标签。 */
  const renderStartPage = (pane: PaneId) => {
    if (activeOf(pane) !== "") return null;
    const box = splitActive ? (pane === "a" ? "absolute inset-y-0 left-0" : "absolute inset-y-0 right-0") : "absolute inset-0";
    const boxStyle: CSSProperties | undefined = splitActive
      ? pane === "a"
        ? { width: "var(--split)" }
        : { left: "var(--split)" }
      : undefined;
    return (
      <div
        key={`start-${pane}`}
        onPointerDown={() => setFocused(pane)}
        className={`@container dsh-scroll z-10 flex flex-col justify-center overflow-y-auto bg-canvas px-3 py-6 ${box}`}
        style={boxStyle}
      >
        <div className="grid grid-cols-1 gap-2 @min-[21rem]:grid-cols-2">
          {startCards.map((card) => {
            const Icon = card.icon;
            return (
              <button
                key={card.kind}
                type="button"
                onClick={() => openTab(card.kind, pane)}
                className="flex h-full min-w-0 items-start gap-2.5 rounded-2xl border border-line bg-canvas px-3 py-3 text-left transition hover:border-line-strong hover:bg-panel/60"
              >
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-panel-strong">
                  <Icon size={15} className={card.tone} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium text-ink">{card.title}</span>
                  <span className="mt-0.5 block text-[10.5px] leading-relaxed text-muted">{card.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <>
      {!docked && (
        <button
          type="button"
          aria-label={t("关闭右侧栏", "Close right sidebar")}
          className="fixed inset-0 z-40 bg-black/35"
          onClick={onClose}
        />
      )}
      <aside
        className={`safe-top flex flex-col border-l border-line bg-canvas ${
          fullActive
            ? "fixed inset-0 z-50 h-[100dvh] w-full"
            : docked
              ? "relative z-auto h-full w-[var(--right-w)]"
              : "fixed inset-y-0 right-0 z-50 h-[100dvh] w-full max-w-[460px] shadow-2xl"
        }`}
        style={style}
        aria-label={t("工作区侧栏", "Workspace sidebar")}
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("调整侧栏宽度", "Resize sidebar")}
          tabIndex={0}
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          onDoubleClick={() => applyWidth(RIGHT_DEFAULT_WIDTH)}
          onKeyDown={onResizeKey}
          // `z-20` 不能删：拖动条跨在侧栏左边界上（外 4px 在对话区、内 4px 在侧栏里），
          // 不加层级时侧栏里的面板（Git 的列表/提交框、终端的 xterm）会先于它命中指针，
          // 于是拖到侧栏内部那半截时既没有 col-resize、hover 高亮也被面板背景盖掉一半，
          // 看起来就是「拖动条断在面板边缘」。层级只要盖过面板即可（Git 的 sticky 头是 z-10）。
          className={`absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize hover:bg-brand/30 ${docked && !fullActive ? "" : "hidden"}`}
          title={t("拖动调整宽度，双击复位", "Drag to resize, double-click to reset")}
        />

        <div className="flex h-14 shrink-0 items-stretch border-b border-line">
          {renderStrip("a")}
          {splitActive && <div className="w-px shrink-0 bg-line" />}
          {splitActive && renderStrip("b")}
        </div>

        {!cwd ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-panel-strong text-muted">
              <IconPanel size={20} />
            </span>
            <p className="text-[13px] font-medium text-ink">{t("还没有工作区", "No workspace yet")}</p>
            <p className="text-[11.5px] leading-relaxed text-muted">
              {t("先在左侧选择或添加一个授权目录，右侧栏会显示它的文件与 Git 状态。", "Choose or add an authorized directory first; this sidebar shows its files and Git state.")}
            </p>
          </div>
        ) : (
          // 开始页与标签页是**同一层**里的两块：某一栏的 active 为空串就是它的开始页。
          //
          // 标签面板不能因为回开始页就卸载：终端里挂着 PTY，卸载等于杀 shell
          // （与「标签切走只隐藏」同一条理由）。所以这里只把开始页盖在上面。
          <div ref={bodyRef} className="relative min-h-0 flex-1" style={style}>
            {splitActive && (
              <>
                <div className="pointer-events-none absolute inset-y-0 z-20 w-px bg-line" style={{ left: "var(--split)" }} />
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t("调整两栏宽度", "Resize panes")}
                  tabIndex={0}
                  onPointerDown={onSplitStart}
                  onPointerMove={onSplitMove}
                  onPointerUp={onSplitEnd}
                  onPointerCancel={onSplitEnd}
                  onKeyDown={onSplitKey}
                  className="absolute inset-y-0 z-30 w-2 -translate-x-1/2 cursor-col-resize hover:bg-brand/30"
                  style={{ left: "var(--split)" }}
                  title={t("拖动调整两栏宽度", "Drag to resize the panes")}
                />
              </>
            )}
            {/* 标签切走、甚至整条侧栏收起都只隐藏：终端里挂着 PTY，卸载等于杀 shell。
                「激活」再与侧栏可见性相与——重新打开时要让它补一次 fit，收着的时候也别
                让面板以为自己正被看着（Git 的订阅就是这个口径）。
                位置按栏算（`--split`），**元素本身不搬家**：跨栏移动标签不会重挂终端。 */}
            {tabs.map((tab) => {
              const pane = paneOf(tab);
              const on = visible && activeOf(pane) === tab.id;
              const position = splitActive ? (pane === "a" ? "absolute inset-y-0 left-0" : "absolute inset-y-0 right-0") : "absolute inset-0";
              const region: CSSProperties | undefined = splitActive
                ? pane === "a"
                  ? { width: "var(--split)" }
                  : { left: "var(--split)" }
                : undefined;
              return (
                <div
                  key={tab.id}
                  style={region}
                  onPointerDownCapture={() => setFocused(pane)}
                  className={`${position} ${on ? "" : "hidden"}`}
                >
                  {tab.kind === "files" && (
                    <FilesPanel
                      cwd={cwd}
                      active={on}
                      pending={pendingOpen && pendingOpen.pane === pane ? pendingOpen : null}
                    />
                  )}
                  {tab.kind === "git" && <GitPanel cwd={cwd} active={on} />}
                  {tab.kind === "subagent" && tab.agentId && (
                    <SubagentPanel sessionId={tab.sessionId ?? ""} agentId={tab.agentId} />
                  )}
                  {tab.kind === "terminal" && (
                    <Suspense
                      fallback={
                        <div className="flex h-full items-center justify-center text-[12px] text-muted">
                          {t("正在加载终端…", "Loading terminal…")}
                        </div>
                      }
                    >
                      <TerminalView cwd={cwd} active={on} />
                    </Suspense>
                  )}
                </div>
              );
            })}
            {renderStartPage("a")}
            {splitActive && renderStartPage("b")}
          </div>
        )}
      </aside>
    </>
  );
}
