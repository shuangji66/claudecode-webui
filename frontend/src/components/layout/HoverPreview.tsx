import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { PORTAL_ATTR } from "../common/Menu";

const WIDTH = 320;
const HEIGHT_ESTIMATE = 200;
/** 卡片与侧栏之间的缝：整个卡片必须落在对话区域里，不能压到分隔线。 */
const PANE_GAP = 12;
/** 对话区域窄于这个值时没有地方放卡片（窄屏抽屉、被右侧栏挤扁）——宁可不弹。 */
const MIN_PANE_WIDTH = 200;

/**
 * 侧栏行的悬浮概览外壳：位置 + 卡片底色，内容由调用方给。
 *
 * 参照 DSH：卡片贴在侧栏右沿、也就是**对话区域**的左上角，纵向跟着悬停的那一行。
 * 位置从侧栏右沿算起而不是行的右沿：行在侧栏里还留着列表的 padding，
 * `rect.right + n` 会压在分隔线上、看起来像盖住了左边栏。
 *
 * 抽屉模式（`md` 以下）没有并排的对话区域，由调用方挡掉；卡片 `pointer-events-none`，
 * 不会挡住点击。
 */
export function HoverPreview({ anchor, children }: { anchor: HTMLElement; children: ReactNode }) {
  const rect = anchor.getBoundingClientRect();
  const paneLeft = anchor.closest("aside")?.getBoundingClientRect().right ?? rect.right;
  const available = window.innerWidth - paneLeft - PANE_GAP * 2;
  if (available < MIN_PANE_WIDTH) return null;
  const width = Math.min(WIDTH, available);
  const left = paneLeft + PANE_GAP;
  const top = Math.max(8, Math.min(rect.top - 8, window.innerHeight - HEIGHT_ESTIMATE - 8));

  return createPortal(
    <div
      role="tooltip"
      {...{ [PORTAL_ATTR]: "" }}
      style={{ left, top, width }}
      className="pointer-events-none fixed z-[70] rounded-xl border border-line bg-canvas p-3 shadow-soft"
    >
      {children}
    </div>,
    document.body,
  );
}
