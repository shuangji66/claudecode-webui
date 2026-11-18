// 统一的浮层原语：Portal 渲染、视口内定位、点外部 / Esc 关闭。
//
// 为什么不用原生 <select> / window.confirm：宿主的主题令牌（深浅色、陶土色强调、
// 圆角与阴影）只对自绘浮层生效；原生控件由操作系统画，深浅色和字号都跟页面脱节，
// 在飞牛桌面 iframe 里尤其突兀。

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconCheck } from "./Icons";

/** 所有浮层共用的面板外观（菜单、下拉选择）。 */
export const POPUP_PANEL = "fixed z-[80] rounded-xl border border-line bg-canvas p-1 shadow-soft";

// Portal 弹层必须带这个标记：React 的事件按组件树冒泡，弹层虽然挂在 body 上，
// mousedown 仍会冒到 Dialog 的遮罩层，而遮罩层用 DOM 包含关系判断「点在外面」，
// 于是点一下下拉项就把整个弹窗关掉。Dialog 见到该标记就放行。
export const PORTAL_ATTR = "data-dsh-portal";

/** 浮层与视口边缘的最小间距。 */
const VIEWPORT_MARGIN = 8;

/**
 * 浮层高度上限：内容再多也只在这个高度内滚动（80vh 与 560px 取小）。
 *
 * 不要压回 60vh/420：真实的菜单经常只有 8~10 项，60vh 在手机竖屏（约 460px 高）
 * 只有 274px，比菜单本身还矮——明明下方空间够，却白白给出一根滚动条。
 * 最终高度仍由 anchoredPosition 的可用空间兜底，不会溢出视口。
 */
export function panelMaxHeight(): number {
  return Math.min(Math.round(window.innerHeight * 0.8), 560);
}

/** 向上/向下展开时都要留的最小高度，免得贴边时被压成一条缝。 */
const MIN_PANEL_HEIGHT = 120;

export interface AnchoredPosition {
  left: number;
  /** 实际使用的宽度（已按视口收窄）。 */
  width: number;
  /** 向下展开时的上边距。 */
  top?: number;
  /** 向上展开时的下边距：底边贴住触发器，而不是按估算高度往上顶。 */
  bottom?: number;
  maxHeight: number;
}

/**
 * 按触发元素的位置算浮层坐标：默认贴右侧对齐（桌面下拉习惯），并夹在视口内。
 *
 * 向上展开用 `bottom` 锚定底边，而不是 `top = 触发器顶 - 估算高度`：估算值一旦
 * 大于实际高度，面板就会飘到视口顶端、和按钮脱节（输入框 + 菜单踩过这个坑）。
 */
export function anchoredPosition(
  anchor: HTMLElement,
  width: number,
  preferredHeight: number,
  align: "start" | "end" = "end",
  offset = 4,
): AnchoredPosition {
  const rect = anchor.getBoundingClientRect();
  const w = Math.max(120, Math.min(width, window.innerWidth - VIEWPORT_MARGIN * 2));
  const rawLeft = align === "end" ? rect.right - w : rect.left;
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - w - VIEWPORT_MARGIN);
  const left = Math.min(Math.max(VIEWPORT_MARGIN, rawLeft), maxLeft);

  const spaceBelow = window.innerHeight - rect.bottom - offset - VIEWPORT_MARGIN;
  const spaceAbove = rect.top - offset - VIEWPORT_MARGIN;
  const height = Math.min(preferredHeight, panelMaxHeight());
  // 下方放得下（或上方更挤）就向下，否则贴着触发器向上长。
  const below = spaceBelow >= height || spaceAbove < spaceBelow;
  const maxHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(height, below ? spaceBelow : spaceAbove));

  return below
    ? { left, width: w, top: rect.bottom + offset, maxHeight }
    : { left, width: w, bottom: window.innerHeight - rect.top + offset, maxHeight };
}

/** 浮层在打开期间跟随触发元素：滚动/缩放时重新定位，而不是让面板飘走。 */
export function useAnchoredPosition(
  anchor: HTMLElement | null,
  open: boolean,
  width: number,
  estimatedHeight: number,
  align: "start" | "end" = "end",
): AnchoredPosition | null {
  const [pos, setPos] = useState<AnchoredPosition | null>(null);

  const update = useCallback(() => {
    if (!anchor) return;
    setPos(anchoredPosition(anchor, width, estimatedHeight, align));
  }, [anchor, width, estimatedHeight, align]);

  useLayoutEffect(() => {
    if (!open || !anchor) {
      setPos(null);
      return;
    }
    update();
  }, [open, anchor, update]);

  useEffect(() => {
    if (!open || !anchor) return;
    window.addEventListener("resize", update);
    // 捕获阶段：滚动容器（会话列表、设置页、输入区）里的滚动也要跟。
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, anchor, update]);

  return pos;
}

/** 高度会变化的浮层（两级菜单）：贴住触发元素的一侧，不因内容变高而整体上移。 */
export interface AnchoredPanelPosition {
  left: number;
  /** 向下展开时的上边距；向上展开时为空。 */
  top?: number;
  /** 向上展开时的下边距；向下展开时为空。 */
  bottom?: number;
  /** 允许的最大高度（px），由可用空间与首选高度取小。 */
  maxHeight: number;
  placement: "above" | "below";
}

/**
 * 计算会随内容变高的浮层位置。
 *
 * 与 useAnchoredPosition 的区别：向上展开时返回 bottom，让浮层底边贴住触发元素。
 * 否则内容从一级菜单切到二级菜单、高度变化时，top 会按新的估算高度整体上移，
 * 看起来像“飘到上面去了”。
 *
 * placement 按 preferredHeight 一次决定，打开期间不再因为内容变矮而翻边。
 */
export function useAnchoredPanel(
  anchor: HTMLElement | null,
  open: boolean,
  width: number,
  preferredHeight: number,
  align: "start" | "end" = "end",
  offset = 4,
): AnchoredPanelPosition | null {
  const [pos, setPos] = useState<AnchoredPanelPosition | null>(null);

  const update = useCallback(() => {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const rawLeft = align === "end" ? rect.right - width : rect.left;
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
    const left = Math.min(Math.max(VIEWPORT_MARGIN, rawLeft), maxLeft);
    const spaceBelow = window.innerHeight - rect.bottom - offset - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - offset - VIEWPORT_MARGIN;
    const below = spaceBelow >= preferredHeight || spaceAbove < spaceBelow;
    const maxHeight = Math.max(80, Math.min(preferredHeight, below ? spaceBelow : spaceAbove));
    setPos(
      below
        ? { left, top: rect.bottom + offset, maxHeight, placement: "below" }
        : { left, bottom: window.innerHeight - rect.top + offset, maxHeight, placement: "above" },
    );
  }, [anchor, width, preferredHeight, align, offset]);

  useLayoutEffect(() => {
    if (!open || !anchor) {
      setPos(null);
      return;
    }
    update();
  }, [open, anchor, update]);

  useEffect(() => {
    if (!open || !anchor) return;
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, anchor, update]);

  return pos;
}

/**
 * 点浮层外部或按 Esc 时关闭；触发元素自身不算外部（否则点击会被「关了又开」）。
 *
 * onEscape 返回 true 表示这次 Esc 已被内部处理（例如从二级菜单退回一级），
 * 不再关闭整个浮层。默认行为是直接关闭。
 */
export function useDismiss(
  open: boolean,
  layer: React.RefObject<HTMLElement | null>,
  anchor: HTMLElement | null,
  onClose: () => void,
  onEscape?: () => boolean,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (layer.current?.contains(target)) return;
      if (anchor?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (onEscape?.()) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, layer, anchor, onClose, onEscape]);
}

export interface MenuItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  /** 右侧灰色小字：命令别名、参数提示等（对齐 DSH 的菜单样式）。 */
  hint?: ReactNode;
  /** 分组标题：只在同组第一项前渲染一次。 */
  group?: string;
  /**
   * 单选项的选中态（分组方式、排序方式这类）。
   * 设置后这一项变成 role="menuitemradio"，右侧自动画对勾。
   */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /**
   * 行尾的一颗独立图标按钮（例如「更多」里把功能固定回侧栏）。
   * 它在主按钮之外，所以不会顺带触发 `onSelect`，也不关菜单。
   */
  trailing?: { label: string; icon: ReactNode; onSelect: () => void };
  onSelect: () => void;
}

interface MenuProps {
  open: boolean;
  /** 触发元素；菜单按它定位，点击它不算「点外部」。 */
  anchor: HTMLElement | null;
  items: MenuItem[];
  onClose: () => void;
  width?: number;
  align?: "start" | "end";
}

/**
 * 菜单的估算高度（用于决定向下/向上展开，以及给出的 maxHeight）。
 *
 * 必须把分组标题算进去：漏算时估算比真实内容矮，maxHeight 会把菜单裁出一条
 * 滚动条——「空间明明够却在滚」就是这个估算漏掉 group 的结果。行高按
 * `py-1.5 + 11.5px 字`（≈28px）与 `pt-1.5 + 10px 字 + pb-0.5`（≈23px）取整数。
 */
export function menuHeight(items: Pick<MenuItem, "group">[]): number {
  const ITEM_H = 30;
  const GROUP_H = 23;
  const rows = items.reduce(
    (h, item, i) => h + ITEM_H + (item.group && item.group !== items[i - 1]?.group ? GROUP_H : 0),
    0,
  );
  return rows + 8; // 面板 p-1 的上下内边距
}

/**
 * 统一的「更多」下拉菜单。
 *
 * 关闭逻辑收在组件里：调用方只需要维护 open + anchor，
 * 不用再各写一套 document mousedown 监听（以前三个菜单各写一份，容易漏）。
 */
export function Menu({ open, anchor, items, onClose, width = 176, align = "end" }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPosition(anchor, open, width, menuHeight(items), align);
  useDismiss(open, ref, anchor, onClose);

  if (!open || !pos) return null;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      {...{ [PORTAL_ATTR]: "" }}
      style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxHeight }}
      className={`${POPUP_PANEL} flex flex-col`}
    >
      {/* 命令列表可能几十条：高度由定位层给出上限，内部滚动。 */}
      <div className="dsh-scroll min-h-0 flex-1 overflow-y-auto">
        {items.map((item, index) => (
          <Fragment key={item.id}>
            {item.group && item.group !== items[index - 1]?.group && (
              <div className="px-2.5 pb-0.5 pt-1.5 text-[10px] text-faint">{item.group}</div>
            )}
            <div className="relative">
              <button
                type="button"
                role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={item.checked}
                disabled={item.disabled}
                onClick={() => {
                  onClose();
                  item.onSelect();
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] disabled:opacity-40 ${
                  item.trailing ? "pr-7" : ""
                } ${
                  item.danger ? "text-danger hover:bg-danger/[0.06]" : "text-ink hover:bg-panel-strong"
                }`}
              >
                {item.icon}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {/* 参数提示可能很长（[low|medium|high] [--fix]…）：限宽截断，别把标签挤没。 */}
                {item.hint && (
                  <span className="max-w-[42%] shrink-0 truncate pl-2 font-mono text-[10px] text-faint" title={typeof item.hint === "string" ? item.hint : undefined}>
                    {item.hint}
                  </span>
                )}
                {item.checked && <IconCheck size={13} className="shrink-0 text-brand" />}
              </button>
              {item.trailing && (
                <button
                  type="button"
                  role="menuitem"
                  aria-label={item.trailing.label}
                  title={item.trailing.label}
                  onClick={(e) => {
                    e.stopPropagation();
                    item.trailing?.onSelect();
                  }}
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1 text-faint hover:bg-black/5 hover:text-ink"
                >
                  {item.trailing.icon}
                </button>
              )}
            </div>
          </Fragment>
        ))}
      </div>
    </div>,
    document.body,
  );
}
