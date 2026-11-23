// 工作区的展开 / 收起状态：本机偏好，**两个侧栏实例共用一份**，并且落 localStorage。
//
// 为什么不能留在组件的 `useState` 里：
//   - 移动端抽屉是 `{sidebarOpen && <Sidebar/>}`，关一次就卸载，展开状态跟着归零，
//     下次打开只剩「当前对话所在的那一个」——用户刚展开的另一组白白没了；
//   - 桌面常驻实例与抽屉实例同时挂载，各持一份就会互相打架（一边展开了，
//     另一边画出的是收起的文件夹图）。
//
// 做法与 `lib/sidebarFeatures` 完全一致：模块级快照 + 订阅者集合 + 跨标签页同步
// + localStorage。**只存本机**（与主题、视图偏好同一条规矩），不进 settings.json。
import { useSyncExternalStore } from "react";

/** 存的是**展开**的工作区路径数组（空数组 = 全部收起）。 */
const EXPANDED_KEY = "ccweb-workspace-expanded";

/** localStorage 里的东西不可信：只收非空字符串，其余一律忽略。 */
export function parseExpandedWorkspaces(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === "string" && value.length > 0);
}

/**
 * 磁盘上有没有这份偏好（`false` = 从没存过，可以按默认值播种）。
 *
 * 「用户全收了」（`[]`）与「从没存过」必须分开：只看集合空不空的话，
 * 每次打开侧栏都会把当前工作区又撑开一个——收起变成关不掉的东西。
 */
export function hasStoredExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) !== null;
  } catch {
    // 隐私模式读不到、也写不进：当「已有」处理，别每次挂载都播种一遍。
    return true;
  }
}

export function loadExpandedWorkspaces(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    return new Set(raw ? parseExpandedWorkspaces(JSON.parse(raw)) : []);
  } catch {
    return new Set();
  }
}

export function saveExpandedWorkspaces(paths: Iterable<string>): void {
  try {
    // 排序后写：同一份集合不会因为插入顺序不同写出不同的字符串（免得 storage
    // 事件在另一个标签页里凭空触发一次）。
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...paths].sort()));
  } catch {
    /* 隐私模式：偏好存不下，当前会话里照常生效 */
  }
}

// ── 模块级共享快照 ────────────────────────────────────────────────────────────

/** `null` = 还没读过盘。getSnapshot 每次返回新 Set 会无限重渲染，所以缓存一份。 */
let cached: Set<string> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 当前展开的工作区（只读快照，调用方不要就地修改）。 */
export function expandedSnapshot(): Set<string> {
  if (!cached) cached = loadExpandedWorkspaces();
  return cached;
}

/** 整体替换并落盘。 */
export function setExpandedWorkspaces(paths: Iterable<string>): void {
  cached = new Set(paths);
  saveExpandedWorkspaces(cached);
  emit();
}

/** 展开 / 收起某一组（工作区行点击的入口）。 */
export function toggleWorkspaceExpanded(path: string): void {
  const next = new Set(expandedSnapshot());
  if (next.has(path)) next.delete(path);
  else next.add(path);
  setExpandedWorkspaces(next);
}

/**
 * 确保某一组是展开的（当前对话换了工作区时用）。
 *
 * 已经是展开态就**什么都不写**：每次调用都重写一遍会让所有订阅者重渲染，
 * 还会把一次「打开抽屉」变成一次 localStorage 写入。
 */
export function ensureWorkspaceExpanded(path: string): void {
  if (!path) return;
  const current = expandedSnapshot();
  if (current.has(path)) return;
  setExpandedWorkspaces(new Set(current).add(path));
}

/**
 * 上一次「看见」的当前工作区路径。**模块级**而不是组件里的 ref：移动端抽屉
 * 关一次就整个卸载，ref 跟着没了；抽屉里点开另一组的对话（抽屉随即关上、
 * 当前工作区换成新的）之后再打开抽屉，组件级 ref 会以为「一直是这个工作区、
 * 什么都没变」，而用户看到的是自己刚进去的那一组收着。
 */
let seenWorkspace: string | null = null;

/**
 * 侧栏挂载 / 当前工作区变化时调一次：要不要自动展开某一组。
 *
 * 三条规则，缺一条都出问题：
 *   - **第一次打开**（盘上还没有这份偏好）→ 播种成「只展开当前对话那一组」。
 *     这是老行为，也是第一次用的人最可能想看到的；
 *   - **盘上已有偏好**（哪怕是被用户收空的 `[]`）→ 不再自动撑开任何东西，
 *     否则「全部收起」变成一个关不掉的开关；
 *   - **会话中换了工作区** → 展开新那一组：点开另一组的对话却看不见它在哪，
 *     比收起状态本身更让人迷惑。原来那一组不动（用户没收起它，凭什么替人收）。
 */
export function syncCurrentWorkspace(path: string): void {
  if (!path) return;
  const changed = seenWorkspace !== null && seenWorkspace !== path;
  seenWorkspace = path;
  if (changed || !hasStoredExpanded()) ensureWorkspaceExpanded(path);
}

function subscribeExpanded(listener: () => void): () => void {
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
  if (event.key !== null && event.key !== EXPANDED_KEY) return;
  cached = loadExpandedWorkspaces();
  emit();
}

/** 组件里读展开状态（跨实例、跨标签页一致）。 */
export function useExpandedWorkspaces(): Set<string> {
  return useSyncExternalStore(subscribeExpanded, expandedSnapshot);
}

/**
 * 丢掉模块级缓存，下一次读取重新从 localStorage 解析。
 *
 * 只给测试用：`localStorage.clear()` 清的是磁盘，清不掉这个模块里的快照，
 * 上一个用例留下的展开状态会带进下一个用例。
 */
export function resetExpandedCache(): void {
  cached = null;
  seenWorkspace = null;
  emit();
}
