// 「轮」的切分：侧栏/对话区的轮次刻度与跳转都靠它（纯函数，可单测）。
//
// 我们的消息流里没有显式的 turn 字段，但每一轮都以一条用户消息开头
// （本地插入的那条，或 CLI 回显去重后的那条），所以「用户消息」就是轮的锚点。

import { isTurnHead, wakeLabel } from "./model";
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
    // 插话并进当前回合，不单独占一刻度（刻度是「跳到某一轮」的入口，插话不是一轮）。
    // **唤醒通知要占一刻度**：CLI 把它算作新的一轮，不占的话底下「1 轮」与刻度格数
    // 又会和收起行对不上（一段对话里被唤醒三次就是三轮）。
    // 回合**进行中**被吸收的通知不会走到这里——它压根不造 `wake`
    // （见 `normalize.applyTaskEvent`）。
    if (!isTurnHead(item)) return;
    const label =
      item.kind === "wake"
        ? wakeLabel(item)
        : item.kind === "user"
          ? firstLine(item.text)
          : "";
    out.push({ index, id: item.id, seq: item.seq, label: label || `#${index + 1}` });
  });
  return out;
}

/**
 * 「只渲染最近一批」的窗口起点（按条数切，但**不切在轮中间**）。
 *
 * 切点绝不能落在某一轮的过程里：一轮的工具调用与思考轻松超过 80 条，按条数直接切
 * 会把这一轮的用户消息整个切出去，界面上只剩一屏「正在分析请求」——用户看到的就是
 * 「我刚发的话不见了，只剩思考过程」，而且内容塌成两三行、下面大片空白。
 *
 * 规则与 `turnsOf` 一致：**每条用户消息是一轮的起点**（一次发送里的图片与附件是
 * 同一条消息里的多个 content block，不是多条 user 行）。
 *
 *   ① 当前这一轮整轮保留（无论多少条）；
 *   ② 原始切点落在某一轮中间时，往回退到那一轮的用户消息。
 *
 * 返回的是起点下标，同时也是「被隐藏的条数」。
 */
export function windowStart(items: Item[], limit: number): number {
  const raw = items.length - limit;
  if (raw <= 0) return 0;

  // 当前这一轮的开头。没有用户消息时没有「轮」，按条数切。
  let lastUser = -1;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (isTurnHead(items[i])) {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return raw;
  // 切点落在当前这一轮里（或更靠后）：整轮保留，从这一轮的轮头开始。
  if (raw > lastUser) return lastUser;

  // 否则往回退到既不早于 0、也是某一轮起点的那一条。
  let cut = raw;
  while (cut > 0 && !isTurnHead(items[cut])) cut -= 1;
  return cut;
}

/**
 * 当前视口顶部落在哪一轮：最后一个「顶部已滚过阈值」的轮。
 *
 * tops 与 turns 一一对应（元素相对滚动容器的顶部距离）；都还没滚到时返回第一轮。
 *
 * `atBottom` 为真时直接取最后一轮：**贴底说明用户在看最新进展**。贴底那一刻视口顶部
 * 通常还停在上一轮的正文里（一轮的末尾可能就是整屏），按 top 算会一直亮着上一轮，
 * 看上去「滚到底了刻度却没走到最后一个」。
 */
export function activeTurnIndex(tops: number[], scrollTop: number, threshold = 24, atBottom = false): number {
  if (tops.length === 0) return -1;
  if (atBottom) return tops.length - 1;
  let active = 0;
  for (let i = 0; i < tops.length; i += 1) {
    if (tops[i] <= scrollTop + threshold) active = i;
    else break;
  }
  return active;
}
