import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useT } from "../../lib/i18n";
import { useSidebarStore } from "../../store/useSidebarStore";
import { FilesPanel } from "./FilesPanel";
import { GitPanel } from "./GitPanel";
import { IconChevronLeft, IconClose, IconFolder, IconGitBranch, IconPanel, IconTerminal } from "../common/Icons";

const TerminalPanel = lazy(() => import("./TerminalPanel"));

export type RightTab = "files" | "git" | "terminal";

interface Props {
  cwd: string;
  /** null = 停在启动页（三个入口卡片），不是常驻标签栏。 */
  activeTab: RightTab | null;
  onTab: (tab: RightTab | null) => void;
  onClose: () => void;
}

const WIDTH_KEY = "ccweb-right-width";
export const RIGHT_MIN_WIDTH = 300;
const RIGHT_MAX_WIDTH = 680;
const RIGHT_DEFAULT_WIDTH = 380;

function readWidth(): number {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= RIGHT_MIN_WIDTH) return Math.min(raw, RIGHT_MAX_WIDTH);
  } catch {
    /* 隐私模式 */
  }
  return RIGHT_DEFAULT_WIDTH;
}

function clampWidth(width: number): number {
  const viewportMax = typeof window === "undefined" ? RIGHT_MAX_WIDTH : Math.max(RIGHT_MIN_WIDTH, window.innerWidth * 0.7);
  return Math.round(Math.min(Math.max(width, RIGHT_MIN_WIDTH), Math.min(RIGHT_MAX_WIDTH, viewportMax)));
}

/**
 * 右侧栏：启动页 + 按需打开的面板（文件树 / Git / 终端），桌面停靠、移动端全屏抽屉。
 *
 * 参照 DSH 的右侧栏：没有常驻标签栏，先进「开始」页，点卡片才打开对应面板，
 * 面板头部有关闭按钮回到开始页。
 *
 * **面板一旦打开过就不卸载**，只切 `hidden`：终端里挂着 PTY，卸载等于杀 shell；
 * 文件树与 Git 也借这一条避免每次切换都重拉。
 */
export function RightSidebar({ cwd, activeTab, onTab, onClose }: Props) {
  const t = useT();
  const setCwd = useSidebarStore((s) => s.setCwd);
  const [width, setWidth] = useState(readWidth);
  const [opened, setOpened] = useState<Set<RightTab>>(new Set());
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  // 工作区切换/侧栏重开只在这里触发一次；三个面板都读同一份 store。
  useEffect(() => {
    void setCwd(cwd);
  }, [cwd, setCwd]);

  useEffect(() => {
    if (!activeTab) return;
    setOpened((prev) => (prev.has(activeTab) ? prev : new Set(prev).add(activeTab)));
  }, [activeTab]);

  const applyWidth = (next: number) => {
    const value = clampWidth(next);
    setWidth(value);
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

  const tabs: { id: RightTab; label: string; title: string; desc: string; icon: typeof IconFolder; tone: string }[] = [
    {
      id: "files",
      label: t("工作区文件", "Workspace files"),
      title: t("文件", "Files"),
      desc: t("浏览会话工作区的文件", "Browse files in the workspace"),
      icon: IconFolder,
      tone: "text-warn",
    },
    {
      id: "git",
      label: t("Git", "Git"),
      title: t("Git", "Git"),
      desc: t("查看变更、提交历史与分支", "Changes, commit history and branches"),
      icon: IconGitBranch,
      tone: "text-ok",
    },
    {
      id: "terminal",
      label: t("新建终端", "New terminal"),
      // 卡片是动作（新建），面板标题是名词。
      title: t("终端", "Terminal"),
      desc: t("在会话工作区运行命令，可多开", "Run commands in the workspace; open as many as you need"),
      icon: IconTerminal,
      tone: "text-brand",
    },
  ];

  const current = tabs.find((tab) => tab.id === activeTab) ?? null;
  const style = { "--right-w": `${width}px` } as CSSProperties;

  return (
    <>
      <button
        type="button"
        aria-label={t("关闭右侧栏", "Close right sidebar")}
        className="fixed inset-0 z-40 bg-black/35 md:hidden"
        onClick={onClose}
      />
      <aside
        className="safe-top fixed inset-y-0 right-0 z-50 flex h-[100dvh] w-full max-w-[460px] flex-col border-l border-line bg-canvas shadow-2xl md:relative md:z-auto md:h-full md:max-w-none md:shadow-none md:w-[var(--right-w)]"
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
          className="absolute inset-y-0 -left-1 hidden w-2 cursor-col-resize hover:bg-brand/30 md:block"
          title={t("拖动调整宽度，双击复位", "Drag to resize, double-click to reset")}
        />

        <div className="flex h-[52px] shrink-0 items-center gap-1 border-b border-line px-2">
          {current ? (
            <button
              type="button"
              onClick={() => onTab(null)}
              className="flex min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1.5 text-[12.5px] font-medium text-ink hover:bg-black/[0.04]"
              aria-label={t("返回", "Back")}
              title={t("返回开始页", "Back to start")}
            >
              <IconChevronLeft size={15} className="shrink-0 text-muted" />
              <current.icon size={14} className={`shrink-0 ${current.tone}`} />
              <span className="truncate">{current.title}</span>
            </button>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 px-1.5 text-[12.5px] font-medium text-ink">
              <IconPanel size={15} className="shrink-0 text-muted" />
              {t("工作区", "Workspace")}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink"
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
        ) : (
          <div className="relative min-h-0 flex-1">
            {!activeTab && (
              <div className="dsh-scroll h-full space-y-2 overflow-y-auto p-2.5">
                {tabs.map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => onTab(tab.id)}
                      className="flex w-full items-start gap-3 rounded-2xl border border-line bg-canvas px-3.5 py-3 text-left transition hover:border-line-strong hover:bg-panel/60"
                    >
                      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-panel-strong">
                        <Icon size={16} className={tab.tone} />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-ink">{tab.label}</span>
                        <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">{tab.desc}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {opened.has("files") && (
              <div className={activeTab === "files" ? "absolute inset-0" : "hidden"}>
                <FilesPanel cwd={cwd} active={activeTab === "files"} />
              </div>
            )}
            {opened.has("git") && (
              <div className={activeTab === "git" ? "absolute inset-0" : "hidden"}>
                <GitPanel cwd={cwd} active={activeTab === "git"} />
              </div>
            )}
            {/* 终端首次打开后才创建 PTY；之后切面板只隐藏，不杀进程。 */}
            {opened.has("terminal") && (
              <div className={activeTab === "terminal" ? "absolute inset-0" : "hidden"}>
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center text-[12px] text-muted">
                      {t("正在加载终端…", "Loading terminal…")}
                    </div>
                  }
                >
                  <TerminalPanel cwd={cwd} active={activeTab === "terminal"} />
                </Suspense>
              </div>
            )}
          </div>
        )}
      </aside>
    </>
  );
}
