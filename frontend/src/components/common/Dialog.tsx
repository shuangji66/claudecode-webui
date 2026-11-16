// 统一的对话框外壳：遮罩、面板、标题区、滚动内容区、底部操作区。
//
// 所有模态（添加授权目录 / 历史记录 / 确认 / 输入）共用这一份结构，
// 保证移动端底部安全区、遮罩层级、圆角与阴影一致；不要再各写一遍
// `fixed inset-0 ... rounded-t-2xl`，那边改一处这边就会落后。

import { useEffect, useRef, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { IconClose } from "./Icons";

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
  closeOnBackdrop?: boolean;
  hideClose?: boolean;
}

// 对话框栈：同时打开多个（例如在「添加授权目录」上再弹确认框）时，
// Esc 只关最上面那个，不能一次全关掉。
const dialogStack: symbol[] = [];

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
  closeOnBackdrop = true,
  hideClose = false,
}: Props) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const token = Symbol("dialog");
    dialogStack.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (dialogStack[dialogStack.length - 1] !== token) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    // 打开期间锁住背景滚动，避免移动端遮罩后面还在滚。
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      const index = dialogStack.indexOf(token);
      if (index >= 0) dialogStack.splice(index, 1);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/35 md:items-center md:p-6"
      onMouseDown={(e) => {
        if (!closeOnBackdrop) return;
        if (panelRef.current?.contains(e.target as Node)) return;
        onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`flex w-full flex-col overflow-hidden rounded-t-2xl bg-canvas shadow-2xl md:rounded-2xl ${WIDTH[size]} ${
          sheet ? "h-[90dvh] md:h-auto md:max-h-[84vh]" : "max-h-[88dvh] md:max-h-[84vh]"
        } ${panelClassName}`}
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
