// 统一的对话框外壳：遮罩、面板、标题区、滚动内容区、底部操作区。
//
// 所有模态（添加授权目录 / 历史记录 / 确认 / 输入）共用这一份结构，
// 保证移动端底部安全区、遮罩层级、圆角与阴影一致；不要再各写一遍
// `fixed inset-0 ... rounded-t-2xl`，那边改一处这边就会落后。

import { useEffect, useRef, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { IconClose } from "./Icons";
import { PORTAL_ATTR } from "./Menu";

export type DialogSize = "sm" | "md" | "lg" | "xl";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 无障碍名称（读屏与测试用）；标题区另有可见标题。 */
  label: string;
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: DialogSize;
  /** 移动端铺成底部整页（内容长、要滚动时用）；桌面端始终居中。 */
  sheet?: boolean;
  bodyClassName?: string;
  /** 内容自己滚动时设 false（否则会出现嵌套滚动条）。 */
  bodyScroll?: boolean;
  /** 完全接管面板内的布局（设置页这种自带导航/分栏的模态）。 */
  bare?: boolean;
  /** 覆盖面板尺寸（例如设置页固定的宽高）。 */
  panelClassName?: string;
  /** 移动端铺满整个视口（设置页这类全屏模态），桌面端仍由 panelClassName 控制。 */
  fullScreen?: boolean;
  closeOnBackdrop?: boolean;
  hideClose?: boolean;
}

// 对话框栈：同时打开多个（例如在「添加授权目录」上再弹确认框）时，
// Esc 只关最上面那个，不能一次全关掉。
const dialogStack: symbol[] = [];

// 背景滚动用计数而不是「记下打开前的值再还原」：多层叠加时，下层先关会把
// overflow 还原成 ""，上层还开着背景却能滚。
let lockCount = 0;
let savedOverflow = "";

function lockScroll() {
  if (lockCount === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  lockCount += 1;
}

function unlockScroll() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) document.body.style.overflow = savedOverflow;
}

const WIDTH: Record<DialogSize, string> = {
  sm: "md:max-w-sm",
  md: "md:max-w-xl",
  lg: "md:max-w-2xl",
  xl: "md:max-w-4xl",
};

export function Dialog({
  open,
  onClose,
  label,
  title,
  description,
  icon,
  children,
  footer,
  size = "md",
  sheet = false,
  bodyClassName = "",
  bodyScroll = true,
  bare = false,
  panelClassName = "",
  fullScreen = false,
  closeOnBackdrop = true,
  hideClose = false,
}: Props) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);

  // onClose 进 ref：调用点几乎都传内联箭头，把它放进依赖会让 effect 每次渲染都
  // 重跑（先从栈里摘掉自己再压到栈顶），叠加弹窗时 Esc 会关错窗口。
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const token = Symbol("dialog");
    dialogStack.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (dialogStack[dialogStack.length - 1] !== token) return;
      e.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    // 打开期间锁住背景滚动，避免移动端遮罩后面还在滚。
    lockScroll();
    return () => {
      document.removeEventListener("keydown", onKey);
      const index = dialogStack.indexOf(token);
      if (index >= 0) dialogStack.splice(index, 1);
      unlockScroll();
    };
  }, [open]);

  if (!open) return null;

  // fullScreen 时不再套用默认的 max-h / 圆角：由调用方的 panelClassName 自己决定，
  // 否则 max-h-[88dvh] 会把 h-[100dvh] 截短，移动端顶部留出一条未覆盖的区域。
  const sizing = fullScreen
    ? ""
    : sheet
      ? "h-[90dvh] md:h-auto md:max-h-[84vh]"
      : "max-h-[88dvh] md:max-h-[84vh]";
  const rounding = fullScreen ? "" : "rounded-t-2xl md:rounded-2xl";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/35 md:items-center md:p-6"
      onMouseDown={(e) => {
        if (!closeOnBackdrop) return;
        if (panelRef.current?.contains(e.target as Node)) return;
        // Select / Menu 的弹层是挂在 body 上的 Portal，但 React 事件仍沿组件树冒泡到这里。
        // 不认这个标记的话，点一下下拉项就会把整个弹窗关掉。
        const el = e.target as Element | null;
        if (el && typeof el.closest === "function" && el.closest(`[${PORTAL_ATTR}]`)) return;
        onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`flex w-full flex-col overflow-hidden bg-canvas shadow-2xl ${rounding} ${WIDTH[size]} ${sizing} ${panelClassName}`}
      >
        {(title || description || icon) && (
          <header className="safe-top flex items-start gap-3 border-b border-line px-4 py-3.5 md:pt-3.5">
            {icon && <span className="mt-0.5 shrink-0 text-muted">{icon}</span>}
            <div className="min-w-0 flex-1">
              {title && <h2 className="truncate text-[15px] font-semibold text-ink">{title}</h2>}
              {description && <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{description}</p>}
            </div>
            {!hideClose && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink"
                aria-label={t("关闭", "Close")}
              >
                <IconClose size={18} />
              </button>
            )}
          </header>
        )}

        {bare ? (
          children
        ) : (
          <div className={`dsh-scroll min-h-0 flex-1 ${bodyScroll ? "overflow-y-auto" : "overflow-hidden"} ${bodyClassName}`}>
            {children}
          </div>
        )}

        {footer && (
          <footer className="safe-bottom shrink-0 border-t border-line px-4 pb-[calc(env(safe-area-inset-bottom,0px)+12px)] pt-3 md:pb-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
