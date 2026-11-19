// 统一的下拉选择：自绘触发器 + Portal 列表，替代原生 <select>。
//
// 原生 <select> 的展开面板由操作系统绘制，深浅色、圆角、字号都不受页面控制；
// 在飞牛桌面 iframe 里点开还会盖到宿主 UI 上。这里用 role=listbox + 自绘面板，
// 并补齐键盘操作（↑↓/Home/End/Enter/Esc）。

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { POPUP_PANEL, PORTAL_ATTR, useAnchoredPosition, useDismiss } from "./Menu";
import { IconCheck, IconChevronDown } from "./Icons";

export interface SelectOption {
  value: string;
  label: ReactNode;
  /** 危险选项：菜单项与选中后的触发器都用红色（权限模式里的「跳过权限」等）。 */
  danger?: boolean;
}

interface Props {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  /** 没有选中项时触发器显示的内容。 */
  placeholder?: ReactNode;
  /** field = 设置页表单样式；pill = 设置行右侧的选择胶囊（对齐 DSH 的 selector）；
   *  ghost = 输入框工具条上的紧凑胶囊。 */
  variant?: "field" | "pill" | "ghost";
  /** 触发器左侧图标（ghost 变体常用）。 */
  leading?: ReactNode;
  /** 完全覆盖触发器内容（例如右侧还要跟一个「图片」徽标）。 */
  trigger?: ReactNode;
  /** 当前值文本的额外类：窄屏折叠文本时用（`@max-[460px]:hidden`，需要祖先带 `@container`）。 */
  labelClassName?: string;
  className?: string;
  menuWidth?: number;
}

const TRIGGER_VARIANT: Record<NonNullable<Props["variant"]>, string> = {
  field:
    "flex w-full items-center gap-1.5 rounded-lg border border-line-strong bg-canvas px-2.5 py-1.5 text-left text-[12.5px] text-ink outline-none hover:bg-panel-strong focus-visible:border-brand/60 disabled:cursor-not-allowed disabled:opacity-50",
  // 宽度跟着当前值走（inline-flex + 内容宽度），所以设置行右侧的控件不会占死半行。
  // 深色下 bg-panel 只比画布亮一档，再抬一级才看得出这是一颗胶囊。
  pill:
    "inline-flex h-8 max-w-full items-center gap-1.5 rounded-lg bg-panel px-2.5 text-left text-[12.5px] text-ink outline-none hover:bg-panel-strong focus-visible:bg-panel-strong disabled:cursor-not-allowed disabled:opacity-50 dark:bg-panel-strong dark:hover:bg-line",
  ghost:
    "flex min-w-0 shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] text-muted outline-none hover:bg-panel-strong hover:text-ink focus-visible:bg-panel-strong disabled:cursor-not-allowed disabled:opacity-40",
};

const ITEM_HEIGHT = 30;

export function Select({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  placeholder,
  variant = "field",
  leading,
  trigger,
  labelClassName = "",
  className = "",
  menuWidth,
}: Props) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const open$ = open && Boolean(anchor);
  const listId = useId();

  const selectedIndex = options.findIndex((o) => o.value === value);
  const current = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const width = Math.max(
    menuWidth ?? 0,
    168,
    anchor ? Math.round(anchor.getBoundingClientRect().width) : 0,
  );
  const pos = useAnchoredPosition(anchor, open$, width, Math.min(options.length * ITEM_HEIGHT + 8, 328), "start");
  useDismiss(open$, listRef, anchor, () => setOpen(false));

  const openList = () => {
    if (disabled) return;
    setAnchor(buttonRef.current);
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  };

  useEffect(() => {
    if (!open$) return;
    listRef.current?.focus();
  }, [open$]);

  const commit = (index: number) => {
    const option = options[index];
    setOpen(false);
    if (option && option.value !== value) onChange(option.value);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // 触发器上用 ↓ / Enter / 空格打开。
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openList();
    }
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      commit(active);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const last = Math.max(options.length - 1, 0);
      const next =
        e.key === "Home" ? 0
          : e.key === "End" ? last
            : e.key === "ArrowDown" ? Math.min(active + 1, last)
              : Math.max(active - 1, 0);
      setActive(next);
    }
  };

  const danger = current?.danger === true;
  // pill 变体的宽度由内容决定（自动宽度的 flex 容器），`flex-1` 会把文字挤成 0 宽。
  const triggerContent = trigger ?? (
    <span className={`min-w-0 truncate ${variant === "pill" ? "" : "flex-1"} ${labelClassName}`}>
      {current?.label ?? placeholder ?? ""}
    </span>
  );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open$}
        aria-controls={open$ ? listId : undefined}
        className={`${TRIGGER_VARIANT[variant]} ${danger ? "text-danger" : ""} ${className}`}
      >
        {leading}
        {triggerContent}
        <IconChevronDown size={variant === "field" ? 14 : variant === "pill" ? 13 : 11} className="shrink-0 opacity-60" />
      </button>

      {open$ && pos
        ? createPortal(
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label={ariaLabel}
              {...{ [PORTAL_ATTR]: "" }}
              tabIndex={-1}
              onKeyDown={onListKeyDown}
              style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxHeight }}
              className={`${POPUP_PANEL} overflow-y-auto dsh-scroll outline-none`}
            >
              {options.length === 0 && (
                <p className="px-2.5 py-2 text-[11.5px] text-faint">{placeholder ?? ""}</p>
              )}
              {options.map((option, index) => {
                const isSelected = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => commit(index)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] ${
                      index === active ? "bg-panel-strong" : ""
                    } ${option.danger ? "text-danger" : "text-ink"} ${isSelected ? "font-medium" : ""}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {isSelected && <IconCheck size={13} className="shrink-0 text-brand" />}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
