// 「过程展示」偏好：工具调用与思考在对话里显示多少、什么时候收起。
//
// 这是**每台设备**的显示偏好（和主题一样的理由：手机要挤、桌面可以宽松），
// 所以只存 localStorage，不进 settings.json，也不经过后端。
//
// 展示口径三档（**只决定「展开之后每一步怎么画」**）：
//   - concise（简洁）：连续的过程折成一行组头（人话摘要），点开才看每一步；
//   - standard（标准）：不分组，每一步各自一行（工具卡片折成一行，点开看正文）；
//   - detailed（详细）：每一步都是完整卡片，直接铺开。
//
// **收起是另一条轴，而且是轮级的**（对齐 DSH）：一轮结束就把整轮的过程收进轮首一行
// （「已完成，用时 19 分 52 秒」），只留正文输出；点开那一行才按上面三档把思维链与
// 工具调用还原回原位。以前把「收起」做在档位里（详细=运行中平铺、结束后折回），
// 结果是同一件事由两条轴各说一遍，组级与轮级还互相打架。
//
//   - onComplete（完成时收起，默认）：这一轮一结束就收；
//   - onNextSend（下次发送时收起）：最新一轮结束后仍保持展开，等用户发出下一条消息才收。
//
// 第三条轴是「收起后显示的回复」（对齐 DSH 的 `foldedReplies`）：
//   - all（全部回复，默认）：阶段回复与最终答案都保留，只收起过程；
//   - final（仅最终回答）：被折叠的轮次只留最后一条回答，阶段回复随过程一起隐藏。
import { useSyncExternalStore } from "react";

export const PROCESS_VIEWS = ["concise", "standard", "detailed"] as const;
export type ProcessView = (typeof PROCESS_VIEWS)[number];

export const COLLAPSE_TIMINGS = ["onComplete", "onNextSend"] as const;
export type CollapseTiming = (typeof COLLAPSE_TIMINGS)[number];

export const FOLDED_REPLIES = ["all", "final"] as const;
export type FoldedReplies = (typeof FOLDED_REPLIES)[number];

const VIEW_KEY = "ccweb-process-view";
const TIMING_KEY = "ccweb-collapse-timing";
const REPLIES_KEY = "ccweb-folded-replies";

/** 默认「标准」：不分组，一步一行，工具操作折成一行等用户点开（对齐 DSH 的桌面默认值）。 */
export const DEFAULT_PROCESS_VIEW: ProcessView = "standard";
/** 默认「完成时收起」。 */
export const DEFAULT_COLLAPSE_TIMING: CollapseTiming = "onComplete";
/** 默认「全部回复」：只收起过程，阶段回复照常可见。 */
export const DEFAULT_FOLDED_REPLIES: FoldedReplies = "all";

/**
 * 旧版本写下的值：`compact`/`grouped` 当年就是「把过程收成一行组头」，
 * 也就是今天的「简洁」；按它读能保住用户当时的观感。磁盘上的值不改写。
 */
const LEGACY_VIEWS: Record<string, ProcessView> = {
  compact: "concise",
  grouped: "concise",
};

/**
 * 一条「存在 localStorage 里的枚举偏好」：模块内缓存快照 + 订阅者集合。
 * 缓存是必需的：useSyncExternalStore 的 getSnapshot 每次返回新值会无限重渲染。
 */
function prefStore<T extends string>(key: string, values: readonly T[], fallback: T, legacy?: Record<string, T>) {
  let cached: T | null = null;
  const listeners = new Set<() => void>();

  const parse = (raw: string | null | undefined): T => {
    if (values.includes(raw as T)) return raw as T;
    // localStorage 是不可信输入：直接 `legacy[raw]` 会让 "__proto__" / "toString"
    // 命中 Object.prototype，返回值不再是 T（类型上悄悄骗过所有人）。
    if (raw && legacy && Object.prototype.hasOwnProperty.call(legacy, raw)) return legacy[raw];
    return fallback;
  };

  const read = (): T => {
    if (cached) return cached;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      raw = null; // 隐私模式 / 配额异常：当没设置过
    }
    cached = parse(raw);
    return cached;
  };

  const set = (value: T): void => {
    cached = value;
    try {
      localStorage.setItem(key, value);
    } catch {
      // 写不进去只影响「下次打开」，当前会话照常生效
    }
    for (const fn of listeners) fn();
  };

  const subscribe = (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };

  return { parse, read, set, subscribe, reset: () => { cached = null; } };
}

const views = prefStore<ProcessView>(VIEW_KEY, PROCESS_VIEWS, DEFAULT_PROCESS_VIEW, LEGACY_VIEWS);
const timings = prefStore<CollapseTiming>(TIMING_KEY, COLLAPSE_TIMINGS, DEFAULT_COLLAPSE_TIMING);
const replies = prefStore<FoldedReplies>(REPLIES_KEY, FOLDED_REPLIES, DEFAULT_FOLDED_REPLIES);

export const parseProcessView = views.parse;
export const processView = views.read;
export const setProcessView = views.set;
export const subscribeProcessView = views.subscribe;
/** 仅测试用：清掉模块缓存。 */
export const resetProcessViewCache = views.reset;

export const parseCollapseTiming = timings.parse;
export const collapseTiming = timings.read;
export const setCollapseTiming = timings.set;
export const subscribeCollapseTiming = timings.subscribe;
/** 仅测试用：清掉模块缓存。 */
export const resetCollapseTimingCache = timings.reset;

export const parseFoldedReplies = replies.parse;
export const foldedReplies = replies.read;
export const setFoldedReplies = replies.set;
export const subscribeFoldedReplies = replies.subscribe;
/** 仅测试用：清掉模块缓存。 */
export const resetFoldedRepliesCache = replies.reset;

export function useProcessView(): ProcessView {
  return useSyncExternalStore(views.subscribe, views.read, views.read);
}

export function useCollapseTiming(): CollapseTiming {
  return useSyncExternalStore(timings.subscribe, timings.read, timings.read);
}

export function useFoldedReplies(): FoldedReplies {
  return useSyncExternalStore(replies.subscribe, replies.read, replies.read);
}
