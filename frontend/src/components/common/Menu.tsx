// 统一的浮层原语：Portal 渲染、视口内定位、点外部 / Esc 关闭。
//
// 为什么不用原生 <select> / window.confirm：宿主的主题令牌（深浅色、陶土色强调、
// 圆角与阴影）只对自绘浮层生效；原生控件由操作系统画，深浅色和字号都跟页面脱节，
// 在飞牛桌面 iframe 里尤其突兀。

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** 所有浮层共用的面板外观（菜单、下拉选择）。 */
export const POPUP_PANEL = "fixed z-[80] rounded-xl border border-line bg-canvas p-1 shadow-soft";

// Portal 弹层必须带这个标记：React 的事件按组件树冒泡，弹层虽然挂在 body 上，
// mousedown 仍会冒到 Dialog 的遮罩层，而遮罩层用 DOM 包含关系判断「点在外面」，
// 于是点一下下拉项就把整个弹窗关掉。Dialog 见到该标记就放行。
export const PORTAL_ATTR = "data-dsh-portal";

/** 浮层与视口边缘的最小间距。 */
const VIEWPORT_MARGIN = 8;

export interface AnchoredPosition {
  left: number;
  top: number;
}

/** 按触发元素的位置算浮层坐标：默认贴右侧对齐（桌面下拉习惯），并夹在视口内。 */
export function anchoredPosition(
  anchor: HTMLElement,
  width: number,
  estimatedHeight: number,
  align: "start" | "end" = "end",
  offset = 4,
): AnchoredPosition {
  const rect = anchor.getBoundingClientRect();
  const rawLeft = align === "end" ? rect.right - width : rect.left;
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);

  // 下方放不下时翻到触发器上方：输入框工具条贴着视口底部，
  // 不翻的话面板会盖住输入区（虽然夹在视口内，但观感很差）。
  const spaceBelow = window.innerHeight - rect.bottom - offset - VIEWPORT_MARGIN;
  const spaceAbove = rect.top - offset - VIEWPORT_MARGIN;
  const below = rect.bottom + offset;
  const above = rect.top - estimatedHeight - offset;
  const top = spaceBelow >= estimatedHeight || spaceAbove < spaceBelow ? below : above;

  return {
    left: Math.min(Math.max(VIEWPORT_MARGIN, rawLeft), maxLeft),
    top: Math.min(Math.max(VIEWPORT_MARGIN, top), Math.max(VIEWPORT_MARGIN, window.innerHeight - estimatedHeight - VIEWPORT_MARGIN)),
  };
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

/** 点浮层外部或按 Esc 时关闭；触发元素自身不算外部（否则点击会被「关了又开」）。 */
export function useDismiss(
  open: boolean,
  layer: React.RefObject<HTMLElement | null>,
  anchor: HTMLElement | null,
  onClose: () => void,
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
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, layer, anchor, onClose]);
}

export interface MenuItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
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
 * 统一的「更多」下拉菜单。
 *
 * 关闭逻辑收在组件里：调用方只需要维护 open + anchor，
 * 不用再各写一套 document mousedown 监听（以前三个菜单各写一份，容易漏）。
 */
export function Menu({ open, anchor, items, onClose, width = 176, align = "end" }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPosition(anchor, open, width, items.length * 30 + 8, align);
  useDismiss(open, ref, anchor, onClose);

  if (!open || !pos) return null;
  return createPortal(
    <div ref={ref} role="menu" {...{ [PORTAL_ATTR]: "" }} style={{ left: pos.left, top: pos.top, width }} className={POPUP_PANEL}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] disabled:opacity-40 ${
            item.danger ? "text-danger hover:bg-danger/[0.06]" : "text-ink hover:bg-panel-strong"
          }`}
        >
          {item.icon}
          <span className="truncate">{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
