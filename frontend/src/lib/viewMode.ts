// 「过程展示」偏好：工具调用与思考在对话里显示多少、什么时候收起。
//
// 这是**每台设备**的显示偏好（和主题一样的理由：手机要挤、桌面可以宽松），
// 所以只存 localStorage，不进 settings.json，也不经过后端。
//
// 展示口径对齐 DSH 的「工作步骤展示」三档：
//   - concise（简洁）：整段过程只留一行组头，点开才看每一步；不显示推理预览；
//   - standard（标准）：组头带实时在做什么与思考首行，点开看每一步；
//   - detailed（详细）：运行中直接铺开每一步的卡片，回答一出现自动收起成组头。
//
// 收起时机是**另一条轴**（DSH 的「过程收起时机」），与展示档位互不影响：
//   - onComplete（完成时收起，默认）：回答一出现就把过程折回一行；
//   - onNextSend（下次发送时收起）：最新一轮的过程在回答出现后仍然展开（详细模式保持平铺），
//     等你发出下一条消息才收起。
import { useSyncExternalStore } from "react";

export const PROCESS_VIEWS = ["concise", "standard", "detailed"] as const;
export type ProcessView = (typeof PROCESS_VIEWS)[number];

export const COLLAPSE_TIMINGS = ["onComplete", "onNextSend"] as const;
export type CollapseTiming = (typeof COLLAPSE_TIMINGS)[number];

const VIEW_KEY = "ccweb-process-view";
const TIMING_KEY = "ccweb-collapse-timing";

/** 默认「标准」：过程收成一行组头，仍能看到正在做什么（对齐 DSH 的桌面默认值）。 */
export const DEFAULT_PROCESS_VIEW: ProcessView = "standard";
/** 默认「完成时收起」。 */
export const DEFAULT_COLLAPSE_TIMING: CollapseTiming = "onComplete";

/** 旧版本写下的值：`compact`/`grouped` 都按「标准」显示，磁盘上的值不改写。 */
const LEGACY_VIEWS: Record<string, ProcessView> = {
  compact: "standard",
  grouped: "standard",
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
    return (raw && legacy?.[raw]) || fallback;
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

export function useProcessView(): ProcessView {
  return useSyncExternalStore(views.subscribe, views.read, views.read);
}

export function useCollapseTiming(): CollapseTiming {
  return useSyncExternalStore(timings.subscribe, timings.read, timings.read);
}
