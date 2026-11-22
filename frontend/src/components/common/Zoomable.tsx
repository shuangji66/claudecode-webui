// 图片缩放：操作条 + 可缩放的图片容器。
//
// 正文灯箱与右侧栏文件预览共用同一份控件与同一组常量——两处各写一套的话，
// 步进、上下限、按钮文案迟早会漂。缩放状态由调用方持有（两处的复位时机不同：
// 灯箱按 src 换图，侧栏按选中的文件路径）。

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "./Button";
import { IconMinus, IconPlus } from "./Icons";
import { useT } from "../../lib/i18n";

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;
export const ZOOM_STEP = 0.25;
/**
 * 滚轮每一格的缩放倍数。
 *
 * 不用 `ZOOM_STEP` 那种加法：滚轮的 deltaY 是连续量（触控板一次滑动就是几十个
 * 小事件），加法在触控板上会瞬间冲到上下限，乘法才有「一点点推近」的手感。
 * 10%（≈1.1）/ 格在鼠标滚轮上一格刚好能看出变化。
 */
export const WHEEL_ZOOM_FACTOR = 1.1;

/** 夹到 [MIN_ZOOM, MAX_ZOOM]。滚轮给的是连续值，走这里；按钮也复用。 */
export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** 按步进增减并夹到 [MIN_ZOOM, MAX_ZOOM]；用 toFixed 抹掉浮点尾巴。 */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const next = Number((zoom + direction * ZOOM_STEP).toFixed(2));
  return clampZoom(next);
}

/** 图片相对容器中心的偏移（px）：`{0,0}` = 居中。 */
export interface Pan {
  x: number;
  y: number;
}

/**
 * 把平移量夹进「图片边缘不离开容器边缘」的范围。
 *
 * 图片比容器小时两个方向的上限都是 0，也就是强制居中——否则缩小回去之后
 * 那张小图会歪在角落里，看起来像是拖动把它甩飞了。
 */
export function clampPan(
  pan: Pan,
  size: { w: number; h: number },
  box: { w: number; h: number },
): Pan {
  const maxX = Math.max(0, (size.w - box.w) / 2);
  const maxY = Math.max(0, (size.h - box.h) / 2);
  // `+ 0` 把 `-0` 归一成 `0`：上限为 0 时 `Math.max(-0, 负值)` 会得到 `-0`，
  // 它写进 transform 是 `-0px`（无害），但会让「有没有被夹过」的比较变得别扭。
  return {
    x: Math.min(maxX, Math.max(-maxX, pan.x)) + 0,
    y: Math.min(maxY, Math.max(-maxY, pan.y)) + 0,
  };
}

/** 底部操作条：百分比 + 缩小 / 重置 / 放大。 */
export function ZoomBar({
  zoom,
  onChange,
  className = "",
}: {
  zoom: number;
  onChange: (zoom: number) => void;
  className?: string;
}) {
  const t = useT();
  return (
    <div
      className={`flex shrink-0 items-center justify-between gap-2 border-t border-line px-3 py-1.5 ${className}`}
    >
      <span className="tabular-nums text-[11px] text-muted">{Math.round(zoom * 100)}%</span>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("缩小", "Zoom out")}
          disabled={zoom <= MIN_ZOOM}
          onClick={() => onChange(stepZoom(zoom, -1))}
        >
          <IconMinus size={14} />
        </Button>
        <Button variant="ghost" size="sm" disabled={zoom === 1} onClick={() => onChange(1)}>
          {t("重置", "Reset")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("放大", "Zoom in")}
          disabled={zoom >= MAX_ZOOM}
          onClick={() => onChange(stepZoom(zoom, 1))}
        >
          <IconPlus size={14} />
        </Button>
      </div>
    </div>
  );
}

/**
 * 计算图片在窗口里的显示尺寸。
 *
 * 基准不是"填满窗口"，而是「`min(原始尺寸, 适应窗口)`」——小图按原始像素显示（放大只会糊），
 * 大图按长边缩到窗口内；`zoom` 再在这个基准上等比放大。
 * 这样 zoom=1 永远不糊，zoom>1 也有明确含义（相对这个基准）。
 *
 * @param natural - 图片原始像素尺寸；未知时传 0。
 * @param box - 窗口内容区尺寸；未知时传 0。
 * @param zoom - 1 = 基准，>1 放大。
 * @returns 显示宽高；任一输入未知时返回 0（调用方退回 CSS 自适应）。
 */
export function fitSize(
  natural: { w: number; h: number },
  box: { w: number; h: number },
  zoom: number,
): { w: number; h: number } {
  if (natural.w <= 0 || natural.h <= 0 || box.w <= 0 || box.h <= 0) return { w: 0, h: 0 };
  const fit = Math.min(1, box.w / natural.w, box.h / natural.h);
  const scale = fit * zoom;
  return { w: natural.w * scale, h: natural.h * scale };
}

/**
 * 可缩放的图片。
 *
 * 尺寸靠 JS 算而不是纯 CSS：要「小图不放大、大图按长边缩小」，就得同时知道
 * 原始像素和窗口尺寸，`object-fit` 里没有这个语义（`scale-down` 会在 zoom>1 时
 * 锁死原始尺寸，缩放就失效了）。
 *
 * 两种取景方式：
 * - 默认：根节点固定 `h-full w-full` 供测量，滚动交给调用方的 `overflow-auto`
 *   （放大后由它出现滚动条）。
 * - `pannable`：自己接管取景，滚轮缩放 + 拖动平移（灯箱与右侧栏文件预览）。这一层是
 *   `overflow-hidden`，图片用 `transform` 平移而不是滚动——放大后要能在两个方向上
 *   一起挪，滚动条那套在两个轴上都溢出时很难用（拖不出来，只能去抠角落里的滑块）。
 *   调用方这一层也必须是不设滚动的容器，否则放大后还会多出一条横向滚动条。
 */
export function ZoomableImage({
  src,
  alt,
  zoom,
  imgClassName = "",
  onImgClick,
  onZoomChange,
  pannable = false,
}: {
  src: string;
  alt: string;
  zoom: number;
  /** 追加到 <img> 上的样式（圆角/边框这类由调用方决定）。 */
  imgClassName?: string;
  onImgClick?: (() => void) | undefined;
  /** 滚轮缩放要回写父级的 `zoom`（缩放条上的百分比跟着变）；不给就不吃滚轮。 */
  onZoomChange?: ((zoom: number) => void) | undefined;
  /** 滚轮缩放 + 拖动平移。灯箱与右侧栏文件预览都开。 */
  pannable?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  /** 一次拖动的起点：记下按下时的指针位置与当时的平移量。 */
  const drag = useRef<{ startX: number; startY: number; origin: Pan; pointerId: number } | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (el === null) return;
    const read = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 命中缓存时 onLoad 不一定会再触发，挂载时补一次。
  useEffect(() => {
    const img = imgRef.current;
    if (img !== null && img.complete && img.naturalWidth > 0) {
      setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    }
  }, [src]);

  const size = fitSize(natural, box, zoom);
  const sized = size.w > 0;
  // 渲染用夹过的值（拖动/缩放都会写回，这里再夹一次兜住「夹完又被外部改了尺寸」）。
  const shown = clampPan(pan, size, box);

  // 尺寸一变（换图 / 缩放 / 容器被拖动改变），旧的平移量可能已经越界：
  // 缩回 1 倍时图片比容器小，两个上限都是 0，会自己回到居中。
  useEffect(() => {
    setPan((p) => {
      const next = clampPan(p, size, box);
      return next.x === p.x && next.y === p.y ? p : next;
    });
  }, [size.w, size.h, box.w, box.h]);

  // 滚轮缩放。必须走原生监听：React 17 起 root 上的 wheel 是 passive 的，
  // preventDefault() 会被忽略（页面在背后一起滚，或者整页缩放）。
  useEffect(() => {
    if (!pannable || onZoomChange === undefined) return;
    const el = boxRef.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent) => {
      // Ctrl + 滚轮是浏览器/系统的捏合缩放，抢过来就放不大了。
      if (e.ctrlKey || e.deltaY === 0) return;
      e.preventDefault();
      const next = clampZoom(zoom * (e.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR));
      if (next === zoom) return;
      // 以光标为锚点：锚点下面的那块像素在缩放前后停在原处，否则内容会「跑掉」，
      // 想放大看角落的细节时每次都要重新拖回来。
      const rect = el.getBoundingClientRect();
      const at = {
        x: e.clientX - rect.left - box.w / 2,
        y: e.clientY - rect.top - box.h / 2,
      };
      const ratio = next / zoom;
      setPan((p) =>
        clampPan(
          { x: at.x - (at.x - p.x) * ratio, y: at.y - (at.y - p.y) * ratio },
          fitSize(natural, box, next),
          box,
        ),
      );
      onZoomChange(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [pannable, onZoomChange, zoom, box.w, box.h, natural.w, natural.h]);

  // 只有图片真的超出窗口时才有可拖的东西；否则给个抓手光标会让人以为拖得动。
  const canPan = sized && (size.w > box.w || size.h > box.h);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // 图没超出窗口时拖不出任何变化，别去抢指针（那会顺手吃掉文字选中与点击）。
    if (!canPan || e.button !== 0) return;
    drag.current = { startX: e.clientX, startY: e.clientY, origin: shown, pointerId: e.pointerId };
    setDragging(true);
    // 指针移出面板时仍要继续收到 move：不捕获的话拖到边缘就断了。
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d === null || d.pointerId !== e.pointerId) return;
    setPan(
      clampPan(
        { x: d.origin.x + (e.clientX - d.startX), y: d.origin.y + (e.clientY - d.startY) },
        size,
        box,
      ),
    );
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d === null || d.pointerId !== e.pointerId) return;
    // `pointercancel` 时捕获已经被浏览器收回，再释放会抛 InvalidPointerId。
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      /* 已经没了，忽略 */
    }
    drag.current = null;
    setDragging(false);
  };

  if (pannable) {
    return (
      <div
        ref={boxRef}
        className={`relative h-full w-full overflow-hidden ${canPan ? (dragging ? "cursor-grabbing" : "cursor-grab") : ""}`}
        // 触屏默认把单指拖动当成页面滚动，不关掉的话 pointermove 根本不发过来。
        // 只关单指平移、留 `pinch-zoom`：两指捏合是手机上唯一原生的缩放手势，
        // 一起禁掉的话放大/缩小就只能去点底部那两颗小按钮。
        style={{ touchAction: "pinch-zoom" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          onClick={onImgClick}
          // 关掉浏览器自带的图片拖拽：它会把 <img> 拖成一个幽灵副本，还盖住我们的平移手势。
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget;
            setNatural({ w: img.naturalWidth, h: img.naturalHeight });
          }}
          style={{
            // transform 一直在：尺寸未知（图还没 load 完）时也要靠它把图挪到正中，
            // 否则 `<img>` 的左上角会停在容器的中心点上。
            transform: `translate(calc(-50% + ${shown.x}px), calc(-50% + ${shown.y}px))`,
            ...(sized ? { width: size.w, height: size.h } : {}),
          }}
          className={`absolute left-1/2 top-1/2 select-none object-contain ${sized ? "max-w-none" : "max-h-full max-w-full"} ${imgClassName}`}
        />
      </div>
    );
  }

  return (
    <div ref={boxRef} className="h-full w-full">
      <div className="flex min-h-full min-w-full p-2">
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          onClick={onImgClick}
          onLoad={(e) => {
            const img = e.currentTarget;
            setNatural({ w: img.naturalWidth, h: img.naturalHeight });
          }}
          style={sized ? { width: size.w, height: size.h } : undefined}
          className={`m-auto object-contain ${sized ? "max-w-none" : "max-h-full max-w-full"} ${imgClassName}`}
        />
      </div>
    </div>
  );
}
