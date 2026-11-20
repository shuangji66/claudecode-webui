// 左侧栏的视图偏好：分组方式 / 排序方式 / 归档筛选（对齐 DSH 的「工作区」菜单）。
//
// 这里全是纯函数：三种分组 × 两种排序 × 三种筛选的组合都能单测，
// 组件只负责把结果画出来、把选择存进 localStorage。

import { belongs, sortByRecent } from "./conversations";
import type { ConversationInfo, WorkspaceEntry } from "../transport/types";

export type GroupMode = "workspace" | "tree" | "flat";
export type SortMode = "recent" | "manual";
export type ArchiveFilter = "hide" | "all" | "only";

export interface SidebarView {
  group: GroupMode;
  sort: SortMode;
  archive: ArchiveFilter;
}

export const DEFAULT_VIEW: SidebarView = { group: "workspace", sort: "recent", archive: "hide" };

/** 单列表模式在手动顺序表里的键。 */
export const FLAT_KEY = "__flat__";
/** 「其他对话」（不在任何授权目录里）在手动顺序表里的键。 */
export const OTHER_KEY = "__other__";

/**
 * 一个工作区最多先露几条会话（对齐 DSH）：超过就折叠成「展开其余 N 个会话」。
 *
 * 侧栏是导航，不是清单——一个跑了几十轮对话的目录会把下面几个工作区全挤出视口。
 * 收起的是**排好序之后**的尾部，所以「最近更新的先露出来」这条在折叠状态下照样成立。
 */
export const SESSION_GROUP_LIMIT = 5;

const GROUPS: GroupMode[] = ["workspace", "tree", "flat"];
const SORTS: SortMode[] = ["recent", "manual"];
const FILTERS: ArchiveFilter[] = ["hide", "all", "only"];

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** 从 localStorage 里读回来的东西不可信：非法值一律回落默认。 */
export function parseView(raw: unknown): SidebarView {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    group: pick(v.group, GROUPS, DEFAULT_VIEW.group),
    sort: pick(v.sort, SORTS, DEFAULT_VIEW.sort),
    archive: pick(v.archive, FILTERS, DEFAULT_VIEW.archive),
  };
}

/** 归档筛选：hide 只要未归档，only 只要已归档，all 全要。 */
export function matchArchive(c: ConversationInfo, filter: ArchiveFilter): boolean {
  if (filter === "hide") return !c.archived;
  if (filter === "only") return c.archived;
  return true;
}

/**
 * 手动顺序：order 里出现过的按 order 排，没出现过的按最近更新排在后面。
 *
 * 这样新对话不会插到中间，用户拖过的位置也不会因为「最近更新」被冲掉。
 */
export function applyOrder(list: ConversationInfo[], order: string[]): ConversationInfo[] {
  const index = new Map(order.map((id, i) => [id, i]));
  const known = list
    .filter((c) => index.has(c.id))
    .sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0));
  const rest = sortByRecent(list.filter((c) => !index.has(c.id)));
  return [...known, ...rest];
}

/** 当前列表的 id 顺序（按已生效的排序）。 */
function idsOf(order: string[], list: ConversationInfo[]): string[] {
  return applyOrder(list, order).map((c) => c.id);
}

/** 拖拽落点：落在目标行的上半 = 插到它前面，下半 = 插到它后面。 */
export type DropHalf = "before" | "after";

/**
 * 指针落在目标行的哪一半（对齐 DSH 的 rowHalf）。
 *
 * 只认中线：没有这一层，往「下一行」拖永远只能落到它前面，
 * 想放到列表末尾就得先拖到再下一行，最后一格永远够不着。
 */
export function dropHalf(clientY: number, rect: { top: number; height: number }): DropHalf {
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

/**
 * 能不能把 dragged 落到 target 上。
 *
 * 三条都必须满足：同一组（跨工作区的拖拽没有落点）、不是自己、置顶状态一致——
 * `pinnedFirst` 是最后一道排序，把一条未置顶的拖到置顶项中间会被拉回去，
 * 与其落位后位置「跳」一下，不如干脆不给提示线。
 */
export function canDrop(
  dragged: { id: string; groupKey: string; pinned: boolean },
  target: { id: string; pinned?: boolean },
  groupKey: string,
): boolean {
  return dragged.groupKey === groupKey && dragged.id !== target.id && dragged.pinned === Boolean(target.pinned);
}

/**
 * 把 fromId 挪到 toId 的前面或后面。
 *
 * 找不到 id（跨组拖拽、并发删除）时返回当前完整顺序而不是原数组：
 * 调用方拿到的永远是一份可以直接落盘的完整顺序。
 */
export function moveTo(
  order: string[],
  list: ConversationInfo[],
  fromId: string,
  toId: string,
  half: DropHalf,
): string[] {
  const ids = idsOf(order, list);
  const from = ids.indexOf(fromId);
  if (from < 0 || ids.indexOf(toId) < 0 || fromId === toId) return ids;
  // 先摘掉自己再找落点：否则往下拖时要多减一格，往上拖时又会少一格。
  const next = [...ids];
  next.splice(from, 1);
  const to = next.indexOf(toId);
  next.splice(to + (half === "after" ? 1 : 0), 0, fromId);
  return next;
}

/** 插到 toId 前面（moveTo 的简写）。 */
export function moveBefore(
  order: string[],
  list: ConversationInfo[],
  fromId: string,
  toId: string,
): string[] {
  return moveTo(order, list, fromId, toId, "before");
}

/** 上移 / 下移一格（触屏没有拖拽，用菜单里的这两项）。 */
export function moveStep(
  order: string[],
  list: ConversationInfo[],
  id: string,
  delta: number,
): string[] {
  const ids = idsOf(order, list);
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return ids;
  const next = [...ids];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** 工作区按路径包含关系排成「父 → 子」的扁平顺序，depth 用来缩进。 */
export function flattenWorkspaceTree(workspaces: WorkspaceEntry[]): { workspace: WorkspaceEntry; depth: number }[] {
  const sorted = [...workspaces].sort((a, b) => a.path.localeCompare(b.path));
  const children = new Map<string, WorkspaceEntry[]>();
  const roots: WorkspaceEntry[] = [];
  for (const w of sorted) {
    const parent = sorted
      .filter((p) => p.path !== w.path && belongs(w.path, p.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (parent) children.set(parent.path, [...(children.get(parent.path) ?? []), w]);
    else roots.push(w);
  }
  const out: { workspace: WorkspaceEntry; depth: number }[] = [];
  const walk = (w: WorkspaceEntry, depth: number) => {
    out.push({ workspace: w, depth });
    for (const child of children.get(w.path) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return out;
}

const VIEW_KEY = "ccweb-sidebar-view";
const ORDER_KEY = "ccweb-session-order";

/** 读视图偏好（localStorage 不可用时回落默认）。 */
export function loadView(): SidebarView {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    return raw ? parseView(JSON.parse(raw)) : DEFAULT_VIEW;
  } catch {
    return DEFAULT_VIEW;
  }
}

export function saveView(view: SidebarView): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    /* 隐私模式 */
  }
}

/** 读手动顺序表：{ 工作区路径（或 __flat__）: [会话 id…] }。 */
export function loadOrder(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) out[key] = value.filter((v): v is string => typeof v === "string");
    }
    return out;
  } catch {
    return {};
  }
}

export function saveOrder(order: Record<string, string[]>): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
    /* 隐私模式 */
  }
}
