// 「轮」的切分：侧栏/对话区的轮次刻度与跳转都靠它（纯函数，可单测）。
//
// 我们的消息流里没有显式的 turn 字段，但每一轮都以一条用户消息开头
// （本地插入的那条，或 CLI 回显去重后的那条），所以「用户消息」就是轮的锚点。

import type { Item } from "./model";

export interface Turn {
  /** 在 items 里的下标。 */
  index: number;
  /** 这条用户消息的 item id（定位 DOM 元素用）。 */
  id: string;
  /** 这条用户消息的 seq（稳定，不受窗口截断影响）。 */
  seq: number;
  /** 刻度悬停/无障碍用的短标签：用户消息首行。 */
  label: string;
}

const LABEL_MAX = 40;

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  const trimmed = line.trim();
  return trimmed.length > LABEL_MAX ? `${trimmed.slice(0, LABEL_MAX)}…` : trimmed;
}

/** 每条用户消息算一轮；没有用户消息时返回空数组（不画刻度）。 */
export function turnsOf(items: Item[]): Turn[] {
  const out: Turn[] = [];
  items.forEach((item, index) => {
    if (item.kind !== "user") return;
    out.push({ index, id: item.id, seq: item.seq, label: firstLine(item.text) || `#${index + 1}` });
  });
  return out;
}

/**
 * 当前视口顶部落在哪一轮：最后一个「顶部已滚过阈值」的轮。
 *
 * tops 与 turns 一一对应（元素相对滚动容器的顶部距离）；都还没滚到时返回第一轮。
 */
export function activeTurnIndex(tops: number[], scrollTop: number, threshold = 24): number {
  if (tops.length === 0) return -1;
  let active = 0;
  for (let i = 0; i < tops.length; i += 1) {
    if (tops[i] <= scrollTop + threshold) active = i;
    else break;
  }
  return active;
}
