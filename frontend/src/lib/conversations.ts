// 对话与工作区的归属规则（纯函数，便于单测）。
import type { ConversationInfo, WorkspaceEntry } from "../transport/types";

/** cwd 是否等于 root 或位于其下（POSIX 路径，忽略尾部斜杠）。 */
export function belongs(cwd: string, root: string): boolean {
  const clean = (p: string) => p.replace(/\/+$/, "");
  const c = clean(cwd);
  const r = clean(root);
  return c === r || c.startsWith(`${r}/`);
}

/** 找到 cwd 所属的最长授权工作区；没有则返回空串。 */
export function workspaceFor(cwd: string, workspaces: WorkspaceEntry[]): string {
  return (
    workspaces
      .filter((w) => belongs(cwd, w.path))
      .sort((a, b) => b.path.length - a.path.length)[0]?.path ?? ""
  );
}

/**
 * 时间戳解析成毫秒；解析不了按 0（最旧）算。
 *
 * **不能拿字符串比大小**：后端给的是 Go 的 RFC3339，时区偏移跟着时间值的 Location 走
 * （转录里解析出来的时间戳带 `+08:00`、`conversation.Touch` 用的是本机时区），
 * 前端乐观更新写的却是 `new Date().toISOString()`（永远是 `Z`）。`localeCompare` 比的是
 * 字面量，`2026-01-05T10:00:00+08:00` 会排在 `2026-01-05T02:00:00Z` 之后——
 * 同一时刻的两条对话就此定死了一个错误顺序，这就是「最近更新排序偶尔不生效」的来源。
 */
export function timeValue(iso: string | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

export function sortByRecent(conversations: ConversationInfo[]): ConversationInfo[] {
  return [...conversations].sort((a, b) => timeValue(b.last_active) - timeValue(a.last_active));
}

/**
 * 置顶的排在最前，组内保持传入顺序。
 *
 * 两种排序模式（最近更新 / 手动）都要先过它：置顶是「钉在上面」的显式意图，
 * 不该被最近更新或拖拽顺序盖掉。`sort` 是稳定排序，所以组内顺序不会被打乱。
 */
export function pinnedFirst(conversations: ConversationInfo[]): ConversationInfo[] {
  return [...conversations].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
}

/** cwd 下最近活跃、未归档的对话；没有返回 null。 */
export function latestConversation(cwd: string, conversations: ConversationInfo[]): ConversationInfo | null {
  return sortByRecent(conversations.filter((c) => !c.archived && belongs(c.cwd, cwd)))[0] ?? null;
}

/**
 * 侧栏一行该画什么状态标记（对齐 DSH 的 sessionStatuses 优先级）：
 * 待审批 > 进行中 > 完成未看 > 活跃（不画点）> 未运行（灰点）。
 *
 * 「完成未看」只在结果到达时会话不是当前打开的那条时置位，打开即清除；
 * 否则一轮结束后会永远挂着绿点，反倒成了噪音。
 */
export type ConversationStatus = "approval" | "ongoing" | "done" | "active" | "off";

export function conversationStatus(input: {
  /** 该会话待处理的审批条数。 */
  pending: number;
  /** 是否有常驻进程。 */
  live: boolean;
  /** 进程状态：busy / starting / ready …（live 为 false 时无意义）。 */
  state?: string;
  /** 完成但用户还没看过。 */
  done: boolean;
}): ConversationStatus {
  if (input.pending > 0) return "approval";
  if (input.live && (input.state === "busy" || input.state === "starting")) return "ongoing";
  if (input.done) return "done";
  return input.live ? "active" : "off";
}
