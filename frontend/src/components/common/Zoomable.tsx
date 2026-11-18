// 图片缩放：操作条 + 可缩放的图片容器。
//
// 正文灯箱与右侧栏文件预览共用同一份控件与同一组常量——两处各写一套的话，
// 步进、上下限、按钮文案迟早会漂。缩放状态由调用方持有（两处的复位时机不同：
// 灯箱按 src 换图，侧栏按选中的文件路径）。

import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { IconMinus, IconPlus } from "./Icons";
import { useT } from "../../lib/i18n";

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;
export const ZOOM_STEP = 0.25;

/** 按步进增减并夹到 [MIN_ZOOM, MAX_ZOOM]；用 toFixed 抹掉浮点尾巴。 */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const next = Number((zoom + direction * ZOOM_STEP).toFixed(2));
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
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
 * 根节点固定 `h-full w-full` 供测量，滚动交给调用方的 `overflow-auto`
 * （灯箱的正方形窗口、FilesPanel 的 `dsh-scroll`）——放大后由它出现滚动条。
 */
export function ZoomableImage({
  src,
  alt,
  zoom,
  imgClassName = "",
  onImgClick,
}: {
  src: string;
  alt: string;
  zoom: number;
  /** 追加到 <img> 上的样式（圆角/边框这类由调用方决定）。 */
  imgClassName?: string;
  onImgClick?: (() => void) | undefined;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });

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
