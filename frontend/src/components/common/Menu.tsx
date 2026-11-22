// 统一的浮层原语：Portal 渲染、视口内定位、点外部 / Esc 关闭。
//
// 为什么不用原生 <select> / window.confirm：宿主的主题令牌（深浅色、陶土色强调、
// 圆角与阴影）只对自绘浮层生效；原生控件由操作系统画，深浅色和字号都跟页面脱节，
// 在飞牛桌面 iframe 里尤其突兀。

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconChevronRight, IconStop } from "./Icons";

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

/** 贴住某个元素展开时与它之间的缝隙（对齐 DSH 的 `calc(100% + 4px)`）。 */
const ATTACH_GAP = 4;

/**
 * 贴附面板的高度上限：通用上限的一半。
 *
 * 它贴在输入卡上方，按通用上限（80vh / 560px）开满就等于把整块对话区盖掉——
 * 手机上刚好是整屏。只给一半，命令多时在面板内部滚动，剩下的对话仍然看得见。
 */
const ATTACH_MAX_HEIGHT_RATIO = 0.5;

/**
 * 贴住某个元素（输入卡）展开时，顶部至少给它上方的表头留出的空间。
 *
 * 与对话区表头的 `h-14`（56px）对齐：菜单再长也不要压到表头上，内容在面板内部滚动。
 */
const ATTACH_TOP_MARGIN = 64;

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

/**
 * 贴住某个元素展开（输入框的添加菜单）：宽度与它一致、左右边缘对齐、朝上长。
 *
 * 与 anchoredPosition 的区别是**不按触发按钮定位**：按 `+` 按钮定位时面板底边只到按钮
 * 上沿，会把输入框正文盖住；而宽度按 320 固定又和输入卡对不齐。这里整块贴在输入卡上方
 * （对齐 DSH 的 `left:0; right:0; bottom:calc(100% + 4px)`），高度只给通用上限的一半。
 */
export function attachedPosition(rect: DOMRect, preferredHeight: number): AnchoredPosition {
  const width = Math.max(160, Math.min(rect.width, window.innerWidth - VIEWPORT_MARGIN * 2));
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
  const left = Math.min(Math.max(VIEWPORT_MARGIN, rect.left), maxLeft);

  const height = Math.min(
    preferredHeight,
    Math.round(panelMaxHeight() * ATTACH_MAX_HEIGHT_RATIO),
  );
  const spaceAbove = rect.top - ATTACH_GAP - ATTACH_TOP_MARGIN;
  const spaceBelow = window.innerHeight - rect.bottom - ATTACH_GAP - VIEWPORT_MARGIN;
  // 默认朝上（不盖住输入卡）；只有上面确实塞不下、下面更宽裕时才翻到下面。
  const above = spaceAbove >= MIN_PANEL_HEIGHT || spaceAbove >= spaceBelow;
  const maxHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(height, above ? spaceAbove : spaceBelow));

  return above
    ? { left, width, bottom: window.innerHeight - rect.top + ATTACH_GAP, maxHeight }
    : { left, width, top: rect.bottom + ATTACH_GAP, maxHeight };
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

/** 贴在某个元素上展开的浮层位置：跟随它的尺寸与滚动（添加菜单用）。 */
export function useAttachedPosition(
  target: HTMLElement | null,
  open: boolean,
  preferredHeight: number,
): AnchoredPosition | null {
  const [pos, setPos] = useState<AnchoredPosition | null>(null);

  const update = useCallback(() => {
    if (!target) return;
    setPos(attachedPosition(target.getBoundingClientRect(), preferredHeight));
  }, [target, preferredHeight]);

  useLayoutEffect(() => {
    if (!open || !target) {
      setPos(null);
      return;
    }
    update();
  }, [open, target, update]);

  useEffect(() => {
    if (!open || !target) return;
    window.addEventListener("resize", update);
    // 捕获阶段：输入卡自己在滚动容器里（新对话页），列表滚动时也要跟着走。
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, target, update]);

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
    const onDown = (e: Event) => {
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
    // pointerdown **和** mousedown 都听，但同一次按下只处理第一条：
    //   - 拖拽手柄（右侧栏分隔线）在 pointerdown 里 preventDefault 挡住文字选中，
    //     取消 pointerdown 会连带吞掉浏览器合成的兼容 mousedown —— 只听 mousedown 时
    //     点/拖分隔线浮层既不关也不跟随，卡片变宽了菜单还停在旧坐标上；
    //   - 反过来只听 pointerdown 也不够：老 WebKit 没有 PointerEvent，只能收到 mousedown。
    // 两条都注册时浏览器的一次点击会先后派发 pointerdown 与 mousedown，不去重的话
    // onClose 跑两次（ModelMenu 这类关闭逻辑还带着父级状态同步）。
    // 兼容的 mousedown 与 pointerdown 在同一个输入任务里同步派发，所以用 0ms 定时器标记
    // 「这次按下已经处理过」——定时器在下一次按下之前早就跑完了，不会误吞。
    let handledPress = false;
    const onPointerDown = (e: Event) => {
      handledPress = true;
      window.setTimeout(() => {
        handledPress = false;
      }, 0);
      onDown(e);
    };
    const onMouseDown = (e: Event) => {
      if (handledPress) return;
      onDown(e);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, layer, anchor, onClose, onEscape]);
}

export interface MenuItem {
  id: string;
  label: ReactNode;
  /**
   * 标题下面的第二行小字（类型 / 状态这类补充）。
   *
   * 单行菜单项放不下的信息不要硬塞进 `hint`：`hint` 只占 42% 宽度，长一点就截断，
   * 而 `meta` 吃的是整行宽度。设了它这一项会变成两行（`menuHeight` 按两行估算）。
   */
  meta?: ReactNode;
  icon?: ReactNode;
  /** 右侧灰色小字：命令别名、参数提示等（对齐 DSH 的菜单样式）。 */
  hint?: ReactNode;
  /**
   * 点这一项**不关菜单**（就地切换 `expanded`，展开 `detail`）。
   *
   * 后台操作的列表就是这种：点一下在原地下钻看详情，菜单关掉再点开就看不到刚才那条了。
   */
  keepOpen?: boolean;
  /** 与 `keepOpen` 配套的展开态；有 `detail` 时行尾会画一颗方向箭头。 */
  expanded?: boolean;
  /** 展开后渲染在这一行下面的详情块（`keepOpen` 的菜单项用）。 */
  detail?: ReactNode;
  /** 分组标题：只在同组第一项前渲染一次。 */
  group?: string;
  /**
   * 单选项的选中态（分组方式、排序方式这类）。
   * 设置后这一项变成 role="menuitemradio"，右侧自动画对勾。
   */
  checked?: boolean;
  danger?: boolean;
  /**
   * 用主题色（陶土色）画标题与悬停底色：会话生命周期这类「对正在跑的进程动手」的项
   * 靠它从一堆灰条目里跳出来（重启 / 结束进程）。
   */
  brand?: boolean;
  disabled?: boolean;
  /**
   * 行尾的一颗独立图标按钮（例如「更多」里把功能固定回侧栏）。
   * 它在主按钮之外，所以不会顺带触发 `onSelect`，也不关菜单。
   */
  trailing?: {
    label: string;
    icon: ReactNode;
    /**
     * 二次确认的文案：设了之后第一下只把行尾那颗按钮换成它，第二下才真正执行。
     *
     * 确认态**就地**换按钮，不另开弹窗：浮层里再叠一层确认框要处理焦点、层级与
     * 点外部关闭，而「中止一个后台命令」这种动作只需要多一次点击的缓冲。
     * 确认态在关闭菜单、或换到另一行时复位——不会带着上一行的确认状态留着。
     */
    confirmLabel?: string;
    onSelect: () => void;
  };
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
  /**
   * 贴在这个元素上展开（输入卡）：宽度与它一致、左右对齐、朝上长，不盖住它。
   * 设置后 `width` / `align` 不再参与定位（触发按钮只负责开合与「点外部」判定）。
   */
  attachTo?: HTMLElement | null;
}

/**
 * 菜单的估算高度（用于决定向下/向上展开，以及给出的 maxHeight）。
 *
 * 必须把分组标题算进去：漏算时估算比真实内容矮，maxHeight 会把菜单裁出一条
 * 滚动条——「空间明明够却在滚」就是这个估算漏掉 group 的结果。行高按
 * `py-1.5 + 11.5px 字`（≈28px）与 `pt-1.5 + 10px 字 + pb-0.5`（≈23px）取整数。
 */
export function menuHeight(items: Pick<MenuItem, "group" | "meta">[]): number {
  const ITEM_H = 30;
  // 带 meta 的两行项：py-1.5 + 11.5px 主行 + 10px 次行 ≈ 44px。
  const ITEM_META_H = 44;
  const GROUP_H = 23;
  const rows = items.reduce(
    (h, item, i) => h + (item.meta ? ITEM_META_H : ITEM_H) + (item.group && item.group !== items[i - 1]?.group ? GROUP_H : 0),
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
export function Menu({
  open,
  anchor,
  items,
  onClose,
  width = 176,
  align = "end",
  attachTo = null,
}: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  /**
   * 首选高度：决定向上还是向下展开，同时是 `maxHeight` 的上限。
   *
   * 有可展开的详情（`MenuItem.detail`）时不能再用折叠态的估算封顶：那块内容的真实高度
   * 只有渲染之后才知道（命令原文能有两三行、还可能带进度说明），按 30px/行 估出来的
   * 值又被 `MIN_PANEL_HEIGHT` 抬到 120px——点开一行就只能在那条 120px 的窗口里滚动，
   * 详情被裁成一条缝。面板本身没有固定高度（高度由内容决定，`maxHeight` 只是上限），
   * 所以这里放宽到通用上限不会留下空白。
   */
  const height = items.some((it) => it.detail !== undefined)
    ? Math.max(menuHeight(items), panelMaxHeight())
    : menuHeight(items);
  // 正在等第二下确认的那一行（`trailing.confirmLabel` 的行尾按钮）。
  const [confirming, setConfirming] = useState<string | null>(null);
  // 两个定位 hook 都调用（hook 不能条件调用），没在用的那个收到 open=false 只返回 null。
  const attached = useAttachedPosition(attachTo, open && attachTo !== null, height);
  const anchored = useAnchoredPosition(anchor, open && attachTo === null, width, height, align);
  const pos = attachTo === null ? anchored : attached;
  useDismiss(open, ref, anchor, onClose);

  // 已经没有可显示的东西——列表清空，或触发元素自己随列表清空被卸载了。
  //
  // 后一种是页头「后台操作」的常态：跑完最后一个任务，按钮与它的 anchor 一起从
  // DOM 消失，但 state 里的 anchor 还握着那个游离元素。`getBoundingClientRect()`
  // 对游离元素返回全 0，`align="end"` 于是算出 left=8——面板飞到视口左上角；
  // 条目又是空的，只剩一个 `p-1 + border` 的空框留在那里。而下次有新任务时
  // 按钮回来、open 还是 true，列表就在错过的位置「自己弹出来」。所以这里按
  // 「已经关闭」处理并回调 onClose，让调用方把 anchor 真正清掉。
  const stale = open && (items.length === 0 || (anchor !== null && !anchor.isConnected));
  useEffect(() => {
    if (stale) onClose();
  }, [stale, onClose]);

  // 菜单一关就复位确认态：重新打开时不该有一个已经在等第二下的按钮，
  // 也不该让它带着上一轮的「确认中止」继续。
  useEffect(() => {
    if (!open) setConfirming(null);
  }, [open]);
  // 那一行自己消失了（任务跑完 / 被别处中止）也要复位，否则同一个 id 万一回来
  // 就直接是确认态。
  useEffect(() => {
    if (confirming !== null && !items.some((item) => item.id === confirming)) setConfirming(null);
  }, [confirming, items]);

  if (!open || stale || !pos) return null;
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
                aria-expanded={item.detail === undefined ? undefined : Boolean(item.expanded)}
                disabled={item.disabled}
                onClick={() => {
                  // `keepOpen` 的项（后台操作）就地展开详情：关掉菜单再点开就看不到刚才那条了。
                  if (!item.keepOpen) onClose();
                  item.onSelect();
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] disabled:opacity-40 ${
                  // 行尾有按钮时给主按钮留出位置；确认态那颗更宽（图标 + 两三个字），
                  // 留窄了标题会钻到它下面。
                  item.trailing ? (confirming === item.id ? "pr-[86px]" : "pr-7") : ""
                } ${
                  item.danger
                    ? "text-danger hover:bg-danger/[0.06]"
                    : item.brand
                      ? "text-brand hover:bg-brand/10"
                      : "text-ink hover:bg-panel-strong"
                }`}
              >
                {item.icon}
                {/* 两行项的标题容器自己不再是 truncate：两层都截断才各自生效，
                    把 truncate 留在外层会让第二行被 `white-space: nowrap` 一起压掉。 */}
                {item.meta === undefined ? (
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                ) : (
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{item.label}</span>
                    <span className="block truncate text-[10px] text-faint">{item.meta}</span>
                  </span>
                )}
                {/* 参数提示可能很长（[low|medium|high] [--fix]…）：限宽截断，别把标签挤没。 */}
                {item.hint && (
                  <span className="max-w-[42%] shrink-0 truncate pl-2 font-mono text-[10px] text-faint" title={typeof item.hint === "string" ? item.hint : undefined}>
                    {item.hint}
                  </span>
                )}
                {item.checked && <IconCheck size={13} className="shrink-0 text-brand" />}
                {/* 方向箭头是「这一行能展开」的唯一可见提示：只靠点一下有反应太隐晦。 */}
                {item.detail !== undefined && (
                  <IconChevronRight
                    size={12}
                    className={`shrink-0 text-faint transition-transform ${item.expanded ? "rotate-90" : ""}`}
                  />
                )}
              </button>
              {item.trailing && (
                <button
                  type="button"
                  role="menuitem"
                  aria-label={confirming === item.id ? item.trailing.confirmLabel : item.trailing.label}
                  title={confirming === item.id ? item.trailing.confirmLabel : item.trailing.label}
                  onClick={(e) => {
                    e.stopPropagation();
                    // 带二次确认的：第一下只换成确认按钮，第二下才执行。
                    // 换的是**这一行**的确认态，点别的行会把它收回。
                    if (item.trailing?.confirmLabel && confirming !== item.id) {
                      setConfirming(item.id);
                      return;
                    }
                    setConfirming(null);
                    item.trailing?.onSelect();
                  }}
                  className={
                    confirming === item.id
                      ? "absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-md bg-danger px-1.5 py-1 text-[10.5px] font-medium text-white hover:brightness-95"
                      : "absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1 text-faint hover:bg-black/5 hover:text-ink"
                  }
                >
                  {confirming === item.id ? (
                    <>
                      <IconStop size={11} />
                      {item.trailing.confirmLabel}
                    </>
                  ) : (
                    item.trailing.icon
                  )}
                </button>
              )}
            </div>
            {/* 详情块**不在** `relative` 那一层里：行尾的中止按钮是
                `absolute top-1/2` 定位的，把详情塞进同一个相对容器会让它掉到
                展开块的正中间（看起来像停错了行）。 */}
            {item.detail !== undefined && item.expanded && (
              <div className="mb-1 rounded-lg bg-panel-strong/60 px-2.5 py-2 text-[10.5px] leading-relaxed text-ink-2">
                {item.detail}
              </div>
            )}
          </Fragment>
        ))}
      </div>
    </div>,
    document.body,
  );
}
