import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useT } from "../../lib/i18n";
import { useSidebarStore } from "../../store/useSidebarStore";
import { FilesPanel } from "./FilesPanel";
import { GitPanel } from "./GitPanel";
import { Menu, type MenuItem } from "../common/Menu";
import { IconClose, IconFolder, IconGitBranch, IconPanel, IconPlus, IconSpark, IconTerminal } from "../common/Icons";
import { SubagentPanel } from "./SubagentPanel";
import { useAppStore } from "../../store/useAppStore";

const TerminalView = lazy(() => import("./TerminalView"));

/** 一个标签页；终端每个会话各占一个，子代理对话按 agentId 各占一个。 */
type TabKind = "files" | "git" | "terminal" | "subagent";

interface Tab {
  id: string;
  kind: TabKind;
  label: string;
  /** 子代理标签：打开时的会话 id 与 agent id（切换对话后仍指向原来那个子代理）。 */
  sessionId?: string;
  agentId?: string;
}

interface Props {
  cwd: string;
  onClose: () => void;
}

const WIDTH_KEY = "ccweb-right-width";
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

/**
 * 右侧栏：顶部一排标签页（文件 / Git / 每个终端各一个），桌面停靠、移动端全屏抽屉。
 *
 * 参照 DSH：没有「启动页 + 返回」那种切换，标签本身就是入口与关闭按钮，`+` 打开新标签。
 * **标签切走不卸载**：终端里挂着 PTY，卸载等于杀 shell；关掉标签才结束进程。
 */
export function RightSidebar({ cwd, onClose }: Props) {
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
  // 初始停在开始页：不自动开「文件」标签，由用户点卡片或 + 决定。
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState("");
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const termSeq = useRef(0);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const subagentView = useAppStore((s) => s.subagentView);
  const activeSession = useAppStore((s) => s.activeId);
  const handledSubagent = useRef(0);

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

  // 工作区切换/侧栏重开只在这里触发一次；所有面板都读同一份 store。
  //
  // 换工作区时必须**结束**终端与子代理标签：旧 shell 的 cwd 已经不成立，
  // 而 TerminalView 的建连 effect 依赖 cwd，留着标签只会让它静默重启一个新 shell ——
  // scrollback 全丢，连隐藏的标签也会起一个用户没要求的新进程。
  const firstCwd = useRef(true);
  useEffect(() => {
    if (firstCwd.current) {
      firstCwd.current = false;
      void setCwd(cwd);
      return;
    }
    termSeq.current = 0;
    let fallback = "";
    setTabs((prev) => {
      const kept = prev.filter((tab) => tab.kind === "files" || tab.kind === "git");
      fallback = kept[0]?.id ?? "";
      return kept;
    });
    setActive((prev) => (prev && (prev.startsWith("files") || prev.startsWith("git")) ? prev : fallback));
    void setCwd(cwd);
  }, [cwd, setCwd]);

  const applyWidth = (next: number) => {
    const value = clampWidth(next, viewport);
    setPreferredWidth(value);
    try {
      localStorage.setItem(WIDTH_KEY, String(value));
    } catch {
      /* 隐私模式 */
    }
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

  /** 打开标签：文件/Git 是单例（已开就切过去），终端每次都新建一个。 */
  const openTab = (kind: TabKind) => {
    if (kind !== "terminal") {
      const existing = tabs.find((tab) => tab.kind === kind);
      if (existing) {
        setActive(existing.id);
        return;
      }
      const label = kind === "files" ? t("文件", "Files") : t("Git", "Git");
      setTabs((prev) => [...prev, { id: kind, kind, label }]);
      setActive(kind);
      return;
    }
    if (tabs.filter((tab) => tab.kind === "terminal").length >= MAX_TERMINALS) return;
    termSeq.current += 1;
    const n = termSeq.current;
    const id = `term-${n}`;
    // 第一个叫 bash，之后编号；序号单调递增，关掉中间那个也不会重排。
    setTabs((prev) => [...prev, { id, kind: "terminal", label: n === 1 ? "bash" : `bash ${n}` }]);
    setActive(id);
  };

  const handledOpenFile = useRef(0);
  /**
   * 正文灯箱「在右侧栏打开」的目标路径。
   *
   * 这里是**唯一**的消费者：往下透传给 FilesPanel。让 FilesPanel 自己订阅 store
   * 会踩到「先开标签、面板后挂载」的时序——两个消费方各读一个 seq，先挂载的那个
   * 把它用掉，后挂载的就永远看不到请求（首次进入前端时只开标签、不进预览）。
   */
  const [pendingOpen, setPendingOpen] = useState<{ path: string; seq: number } | null>(null);
  useEffect(() => {
    const req = openRequest;
    if (!req || req.seq <= handledOpenFile.current) return;
    handledOpenFile.current = req.seq;
    setPendingOpen(req);
    openTab("files");
    // 请求只消费一次：**由 store 记「已处理」，不靠组件内的 ref**。关掉侧栏再打开
    // 会重新挂载，ref 归零，留着请求就会重放（又开一个「文件」标签、又预览那张图）。
    consumeOpenFile();
    // openTab 只依赖 tabs 与 setState；seq 已保证同一个请求只处理一次，
    // 放进依赖数组反而会在标签变化时重复触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest]);

  /** 打开某个子代理的对话：同一个 agent 只占一个标签。 */
  const openSubagentTab = (sessionId: string, agentId: string, label: string) => {
    const id = `sub-${sessionId}-${agentId}`;
    setTabs((prev) =>
      prev.some((tab) => tab.id === id)
        ? prev
        : [...prev, { id, kind: "subagent", label: label || t("子代理", "Subagent"), sessionId, agentId }],
    );
    setActive(id);
  };

  const closeTab = (id: string) => {
    // 「文件」面板关掉后 pending 就没意义了：再打开标签时面板会重新挂载、
    // 消费用的 ref 归零，留着它就会自动跳进上次那个文件的预览。
    if (id === "files") setPendingOpen(null);
    setTabs((prev) => {
      const index = prev.findIndex((tab) => tab.id === id);
      const next = prev.filter((tab) => tab.id !== id);
      setActive((cur) => (cur === id ? (next[index]?.id ?? next[index - 1]?.id ?? "") : cur));
      return next;
    });
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

  const terminals = tabs.filter((tab) => tab.kind === "terminal").length;
  const openItems: MenuItem[] = [
    { id: "files", group: t("打开", "Open"), label: t("文件", "Files"), icon: <IconFolder size={13} />, onSelect: () => openTab("files") },
    { id: "git", label: t("Git", "Git"), icon: <IconGitBranch size={13} />, onSelect: () => openTab("git") },
    {
      id: "terminal",
      label: t("终端", "Terminal"),
      hint: "bash",
      icon: <IconTerminal size={13} />,
      disabled: terminals >= MAX_TERMINALS,
      onSelect: () => openTab("terminal"),
    },
  ];

  const style = { "--right-w": `${width}px` } as CSSProperties;

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
          docked
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
          className={`absolute inset-y-0 -left-1 w-2 cursor-col-resize hover:bg-brand/30 ${docked ? "" : "hidden"}`}
          title={t("拖动调整宽度，双击复位", "Drag to resize, double-click to reset")}
        />

        <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line px-1.5">
          <div className="dsh-scroll flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            {tabs.length === 0 && <span className="shrink-0 px-1.5 text-[12.5px] font-medium text-ink">{t("开始", "Start")}</span>}
            {tabs.map((tab) => {
              const Icon = KIND_ICON[tab.kind];
              const on = tab.id === active;
              return (
                <span
                  key={tab.id}
                  className={`flex shrink-0 items-center rounded-lg text-[12px] ${
                    on ? "bg-panel-strong font-medium text-ink" : "text-muted hover:bg-black/[0.03] hover:text-ink"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setActive(tab.id)}
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
            <button
              type="button"
              onClick={(e) => {
                const anchor = e.currentTarget;
                setMenuAnchor((prev) => (prev ? null : anchor));
              }}
              className="ml-0.5 shrink-0 rounded-md p-1 text-muted hover:bg-black/5 hover:text-ink"
              aria-label={t("新建标签", "New tab")}
              aria-haspopup="menu"
              aria-expanded={menuAnchor !== null}
              title={t("新建标签", "New tab")}
            >
              <IconPlus size={15} />
            </button>
            <Menu open={menuAnchor !== null} anchor={menuAnchor} items={openItems} onClose={() => setMenuAnchor(null)} width={180} align="start" />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink"
            aria-label={t("关闭右侧栏", "Close right sidebar")}
            title={t("关闭", "Close")}
          >
            <IconClose size={16} />
          </button>
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
        ) : tabs.length === 0 ? (
          // 开始页：三张功能卡片，点哪张就开哪个标签。
          //
          // 列数按**容器宽度**切（`@container`），不是视口：右侧栏宽度由拖动与停靠规则决定，
          // 跟 viewport 无关。窄的时候排成一列（对齐 DSH）——两列塞不下时描述会被折成
          // 「浏览工作区文 / 件」这种断字，很难看。
          <div className="@container dsh-scroll flex min-h-0 flex-1 flex-col justify-center overflow-y-auto px-3 py-6">
            <div className="grid grid-cols-1 gap-2 @min-[21rem]:grid-cols-2">
              {startCards.map((card) => {
                const Icon = card.icon;
                return (
                  <button
                    key={card.kind}
                    type="button"
                    onClick={() => openTab(card.kind)}
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
        ) : (
          <div className="relative min-h-0 flex-1">
            {/* 标签切走只隐藏：终端里挂着 PTY，卸载等于杀 shell。 */}
            {tabs.map((tab) => (
              <div key={tab.id} className={tab.id === active ? "absolute inset-0" : "hidden"}>
                {tab.kind === "files" && <FilesPanel cwd={cwd} active={tab.id === active} pending={pendingOpen} />}
                {tab.kind === "git" && <GitPanel cwd={cwd} active={tab.id === active} />}
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
                    <TerminalView cwd={cwd} active={tab.id === active} />
                  </Suspense>
                )}
              </div>
            ))}
          </div>
        )}
      </aside>
    </>
  );
}
