// 左侧栏功能区的入口清单与「固定 / 取消固定」偏好（对齐 DSH：模型 / 插件 / MCP /
// 技能中心 / 自动化任务 / 历史记录都在「新对话」与工作区之间的功能区里）。
//
// 偏好只缓存**本机**（localStorage），不进 settings.json：和主题、侧栏视图偏好
// 一样，换设备各自决定。
//
// 存的是**隐藏名单**而不是固定名单：以后新增入口默认出现在侧栏上，
// 而不是让老用户的侧栏永远少几项。
import { useSyncExternalStore } from "react";

export type FeatureKey = "models" | "plugins" | "mcp" | "skills" | "schedules" | "history";

/** 功能区与「更多」菜单的顺序。 */
export const FEATURE_KEYS: readonly FeatureKey[] = ["models", "plugins", "mcp", "skills", "schedules", "history"];

/** 取消固定的偏好键（值是被隐藏的入口 id 数组）。 */
const HIDDEN_KEY = "ccweb-sidebar-feature-hidden";

export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === "string" && (FEATURE_KEYS as readonly string[]).includes(value);
}

/** localStorage 里的东西不可信：只收认识的 id，其余一律忽略。 */
export function parseHiddenFeatures(raw: unknown): FeatureKey[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isFeatureKey);
}

export function loadHiddenFeatures(): Set<FeatureKey> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    return new Set(raw ? parseHiddenFeatures(JSON.parse(raw)) : []);
  } catch {
    return new Set();
  }
}

export function saveHiddenFeatures(hidden: Iterable<FeatureKey>): void {
  try {
    // 按固定顺序写，同一个集合不会因为插入顺序不同写出不同的字符串。
    const list = FEATURE_KEYS.filter((key) => new Set(hidden).has(key));
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式：偏好存不下，按默认（全固定）显示 */
  }
}

export function toggleFeature(hidden: Iterable<FeatureKey>, key: FeatureKey): Set<FeatureKey> {
  const next = new Set(hidden);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

// ── 模块级共享快照 ────────────────────────────────────────────────────────────
//
// 偏好必须放在**组件之外**：侧栏同时存在两个实例（桌面常驻的 + 移动端抽屉里的），
// 各自 `useState` 一份的话，在抽屉里取消固定「插件」之后，桌面实例手上还是挂载时
// 那份旧集合，下一次改动会用自己的旧集合整体回写，把抽屉里的选择抹掉。
//
// 与 lib/viewMode.ts 同一个做法：缓存快照（getSnapshot 每次返回新对象会无限重渲染）
// + 订阅者集合 + 跨标签页同步。

let cached: Set<FeatureKey> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 当前被取消固定的入口（只读快照，调用方不要就地修改）。 */
export function hiddenFeaturesSnapshot(): Set<FeatureKey> {
  if (!cached) cached = loadHiddenFeatures();
  return cached;
}

/** 整体替换隐藏名单并落盘。 */
export function setHiddenFeatures(hidden: Iterable<FeatureKey>): void {
  cached = new Set(hidden);
  saveHiddenFeatures(cached);
  emit();
}

/** 切换某一项的固定状态。 */
export function toggleHiddenFeature(key: FeatureKey): void {
  setHiddenFeatures(toggleFeature(hiddenFeaturesSnapshot(), key));
}

function subscribeHiddenFeatures(listener: () => void): () => void {
  listeners.add(listener);
  // 别的标签页改了偏好：storage 事件只在**其它**标签页触发，正好用来刷新本地缓存。
  if (typeof window !== "undefined" && listeners.size === 1) {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== HIDDEN_KEY) return;
  cached = loadHiddenFeatures();
  emit();
}

/** 组件里读隐藏名单（跨实例、跨标签页一致）。 */
export function useHiddenFeatures(): Set<FeatureKey> {
  return useSyncExternalStore(subscribeHiddenFeatures, hiddenFeaturesSnapshot);
}

/**
 * 丢掉模块级缓存，下一次读取重新从 localStorage 解析。
 *
 * 只给测试用：`localStorage.clear()` 清的是磁盘，清不掉这个模块里的快照，
 * 上一个用例留下的隐藏名单会带进下一个用例。
 */
export function resetHiddenFeaturesCache(): void {
  cached = null;
  emit();
}
