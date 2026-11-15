import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useT } from "../../lib/i18n";
import { useSidebarStore } from "../../store/useSidebarStore";
import { FilesPanel } from "./FilesPanel";
import { GitPanel } from "./GitPanel";
import { IconClose, IconFolder, IconGitBranch, IconPanel, IconTerminal } from "../common/Icons";

const TerminalPanel = lazy(() => import("./TerminalPanel"));

export type RightTab = "files" | "git" | "terminal";

interface Props {
  cwd: string;
  activeTab: RightTab;
  onTab: (tab: RightTab) => void;
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

/** 右侧栏：文件树 / Git / 内置终端，桌面停靠、移动端全屏抽屉。 */
export function RightSidebar({ cwd, activeTab, onTab, onClose }: Props) {
  const t = useT();
  const setCwd = useSidebarStore((s) => s.setCwd);
  const [width, setWidth] = useState(readWidth);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  // 工作区切换/侧栏重开只在这里触发一次；三个面板都读同一份 store。
  useEffect(() => {
    void setCwd(cwd);
  }, [cwd, setCwd]);

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

  const tabs: { id: RightTab; label: string; icon: typeof IconFolder }[] = [
    { id: "files", label: t("文件", "Files"), icon: IconFolder },
    { id: "git", label: t("Git", "Git"), icon: IconGitBranch },
    { id: "terminal", label: t("终端", "Terminal"), icon: IconTerminal },
  ];

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
          <div className="flex min-w-0 flex-1 items-center gap-0.5">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onTab(tab.id)}
                  aria-pressed={active}
                  className={`relative flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] transition ${
                    active ? "bg-panel-strong font-medium text-ink" : "text-muted hover:bg-black/[0.03] hover:text-ink"
                  }`}
                >
                  <Icon size={14} />
                  {tab.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink"
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
            <div className={activeTab === "files" ? "absolute inset-0" : "hidden"}>
              <FilesPanel cwd={cwd} active={activeTab === "files"} />
            </div>
            <div className={activeTab === "git" ? "absolute inset-0" : "hidden"}>
              <GitPanel cwd={cwd} active={activeTab === "git"} />
            </div>
            {/* 终端首次打开后才创建 PTY；切到别的页签只隐藏，不杀进程。 */}
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
          </div>
        )}
      </aside>
    </>
  );
}
