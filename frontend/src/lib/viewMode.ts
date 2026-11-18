// 「过程展示」偏好：工具调用与思考在对话里显示多少。
//
// 这是**每台设备**的显示偏好（和主题一样的理由：手机要挤、桌面可以宽松），
// 所以只存 localStorage，不进 settings.json，也不经过后端。
//
// 口径对齐 DSH 的「工作步骤展示」三档：
//   - concise（简洁）：整段过程只留一行组头，点开才看每一步；不显示推理预览；
//   - standard（标准）：组头带实时在做什么与思考首行，点开看每一步；
//   - detailed（详细）：运行中直接铺开每一步的卡片，回答一出现自动收起成组头。
import { useSyncExternalStore } from "react";

export const PROCESS_VIEWS = ["concise", "standard", "detailed"] as const;
export type ProcessView = (typeof PROCESS_VIEWS)[number];

const KEY = "ccweb-process-view";

/** 默认「标准」：过程收成一行组头，仍能看到正在做什么（对齐 DSH 的桌面默认值）。 */
export const DEFAULT_PROCESS_VIEW: ProcessView = "standard";

let cached: ProcessView | null = null;
const listeners = new Set<() => void>();

/** 旧版本写下的值：`compact`/`grouped` 都按「标准」显示，磁盘上的值不改写。 */
const LEGACY_VIEWS: Record<string, ProcessView> = {
  compact: "standard",
  grouped: "standard",
};

export function parseProcessView(raw: string | null | undefined): ProcessView {
  if (PROCESS_VIEWS.includes(raw as ProcessView)) return raw as ProcessView;
  return (raw && LEGACY_VIEWS[raw]) || DEFAULT_PROCESS_VIEW;
}

function read(): ProcessView {
  if (cached) return cached;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null; // 隐私模式 / 配额异常：当没设置过
  }
  cached = parseProcessView(raw);
  return cached;
}

export function processView(): ProcessView {
  return read();
}

/** 写偏好并通知所有订阅者（设置页与对话区是两棵子树）。 */
export function setProcessView(view: ProcessView): void {
  cached = view;
  try {
    localStorage.setItem(KEY, view);
  } catch {
    // 写不进去只影响「下次打开」，当前会话照常生效
  }
  for (const fn of listeners) fn();
}

export function subscribeProcessView(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 仅测试用：清掉模块缓存。 */
export function resetProcessViewCache(): void {
  cached = null;
}

export function useProcessView(): ProcessView {
  return useSyncExternalStore(subscribeProcessView, read, read);
}
