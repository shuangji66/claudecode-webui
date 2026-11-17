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

export function sortByRecent(conversations: ConversationInfo[]): ConversationInfo[] {
  return [...conversations].sort((a, b) => (b.last_active ?? "").localeCompare(a.last_active ?? ""));
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
