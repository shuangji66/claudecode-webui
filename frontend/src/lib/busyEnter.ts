// 「繁忙时的发送行为」偏好：回合进行中按 Enter / 点发送按钮，是排队还是插话。
//
// 对齐 DSH 的「繁忙时的发送行为」（设置 → 通用里那一行）：Enter 与右下角发送按钮
// **共用同一档**，`Ctrl/⌘+Enter` 永远用**另一档**。两档的含义：
//   - queue（排队发送，默认）：只入 `store.queued`，本轮正常结束后自动发出；
//   - steer（插话发送）：立刻写进 stdin（`priority: "now"`），CLI 在下一个工具边界
//     并入本轮——不带 priority 的话它按 next 处理，看起来和排队一样。
//
// 只存本机（和主题、过程展示同一类偏好）：这是输入手感，不是会话行为，不进
// `settings.json`，换台设备各调各的。
import { useSyncExternalStore } from "react";

export const BUSY_ENTER_BEHAVIORS = ["queue", "steer"] as const;
export type BusyEnterBehavior = (typeof BUSY_ENTER_BEHAVIORS)[number];

const KEY = "ccweb-busy-enter";

/** 默认「排队发送」：与加入这条偏好之前的行为一致。 */
export const DEFAULT_BUSY_ENTER_BEHAVIOR: BusyEnterBehavior = "queue";

/** localStorage 是不可信输入：不认识的值一律折回默认档。 */
export function parseBusyEnter(raw: string | null | undefined): BusyEnterBehavior {
  return BUSY_ENTER_BEHAVIORS.includes(raw as BusyEnterBehavior)
    ? (raw as BusyEnterBehavior)
    : DEFAULT_BUSY_ENTER_BEHAVIOR;
}

/** 与偏好相反的那一档：`Ctrl/⌘+Enter` 走它。 */
export function otherBusyEnter(behavior: BusyEnterBehavior): BusyEnterBehavior {
  return behavior === "queue" ? "steer" : "queue";
}

/** 这一次提交该怎么投递（纯函数，方便在测试里钉住规则）。 */
export type BusySubmitMode = "send" | "queue" | "steer";

/**
 * 解析一次提交的投递方式。
 *
 * - 加速手势（`Ctrl/⌘+Enter`）永远是「现在就发」：忙时它是偏好之外的另一档，空闲时
 *   它越过待发送队列直接发——队列里压着被中断后暂停的消息时，用户明说要立刻发，
 *   还往队尾塞就等于把这条也一起押后。
 * - 不忙：直接发（首条消息没有「本轮」可并入）；**但队列里还压着消息时照旧排队尾**，
 *   否则新消息会插到前面那条之前（store 随后会立刻把队首发出去，顺序不变）。
 * - 忙：主手势走偏好。
 */
export function resolveBusySubmit(
  behavior: BusyEnterBehavior,
  opts: { busy: boolean; accelerated: boolean; queued: number },
): BusySubmitMode {
  if (opts.accelerated) return opts.busy ? otherBusyEnter(behavior) : "send";
  if (opts.busy) return behavior;
  return opts.queued > 0 ? "queue" : "send";
}

let cached: BusyEnterBehavior | null = null;
const listeners = new Set<() => void>();

export function busyEnter(): BusyEnterBehavior {
  if (cached !== null) return cached;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null; // 隐私模式 / 配额异常：当没设置过
  }
  cached = parseBusyEnter(raw);
  return cached;
}

export function setBusyEnter(next: BusyEnterBehavior): void {
  const value = parseBusyEnter(next);
  cached = value;
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // 写不进去只影响「下次打开」，当前会话照常生效
  }
  for (const fn of listeners) fn();
}

export function subscribeBusyEnter(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useBusyEnter(): BusyEnterBehavior {
  return useSyncExternalStore(subscribeBusyEnter, busyEnter, busyEnter);
}

/** 仅测试用：清掉模块缓存（`localStorage.clear()` 之后必须调它才读得到新值）。 */
export function resetBusyEnterCache(): void {
  cached = null;
}
