// 左侧栏功能区的入口清单与「固定 / 取消固定」偏好（对齐 DSH：插件 / MCP /
// 技能中心 / 自动化任务 / 历史记录都在「新对话」与工作区之间的功能区里）。
//
// 偏好只缓存**本机**（localStorage），不进 settings.json：和主题、侧栏视图偏好
// 一样，换设备各自决定。
//
// 存的是**隐藏名单**而不是固定名单：以后新增入口默认出现在侧栏上，
// 而不是让老用户的侧栏永远少几项。

export type FeatureKey = "plugins" | "mcp" | "skills" | "schedules" | "history";

/** 功能区与「更多」菜单的顺序。 */
export const FEATURE_KEYS: readonly FeatureKey[] = ["plugins", "mcp", "skills", "schedules", "history"];

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
