// 从消息流里收集子代理，供页头「子智能体 N」与审批归属使用（纯函数）。

import type { Item, SubagentInfo } from "./model";

export interface SubagentEntry {
  /** claude 的 agentId（= taskId），打开对话用它。 */
  agentId: string;
  taskId: string;
  /** 描述优先，其次类型，最后回落到 id。 */
  label: string;
  type?: string;
  /** task_type：`local_agent` 才是子代理，其余是后台操作（见 lib/backgroundTasks）。 */
  taskType?: string;
  status: SubagentInfo["status"];
  usage?: SubagentInfo["usage"];
  /** 后台子代理：它的 tool_result 只是启动回执，`finishedAt` 因此不是真正的结束时刻。 */
  background?: boolean;
  /**
   * 启动 / 收尾时刻（工具卡片的 `ts` / `doneAt`）。
   *
   * 运行中的子代理靠 `startedAt` 走墙钟：`usage.durationMs` 只在 `task_progress` 到达时
   * 刷新，两次工具调用之间可能几十秒没有新帧。结束之后才轮到 `usage.durationMs` 说话
   * （见 `subagentElapsed`）。
   */
  startedAt?: number;
  finishedAt?: number;
  /** 从子代理转录尾部恢复的收尾时刻（见 `SubagentInfo.endedAt`）。 */
  endedAt?: number;
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * 按出现顺序（= 启动顺序）列出本会话的子代理，同一个 agent 只保留一条。
 *
 * 标题的兜底顺序很重要：`subagent.description` 只在实时 task_started 里才有，
 * 重启后回放主转录时拿不到（转录里没有 task_* 行）。但 Agent 的 tool_use 入参
 * 一直带着 `description` / `subagent_type`，所以必须回落到那里，
 * 否则菜单里只剩一串 agent id。
 */
export function subagentEntries(items: Item[]): SubagentEntry[] {
  const out: SubagentEntry[] = [];
  for (const it of items) {
    if (it.kind !== "tool" || !it.subagent) continue;
    const sub = it.subagent;
    const agentId = sub.agentId ?? sub.taskId;
    if (!agentId || out.some((e) => e.agentId === agentId)) continue;
    const input = (it.input ?? {}) as Record<string, unknown>;
    const description = sub.description || text(input.description);
    const type = sub.type || text(input.subagent_type);
    out.push({
      agentId,
      taskId: sub.taskId,
      label: description || type || agentId,
      type,
      taskType: sub.taskType,
      status: sub.status,
      usage: sub.usage,
      ...(sub.background ? { background: true } : {}),
      startedAt: it.ts,
      ...(it.doneAt !== undefined ? { finishedAt: it.doneAt } : {}),
      ...(sub.endedAt !== undefined ? { endedAt: sub.endedAt } : {}),
    });
  }
  return out;
}

/** 按 agentId 找展示名（审批面板标「来自子代理 X」用）。 */
export function subagentLabel(items: Item[], agentId: string): string | undefined {
  return subagentEntries(items).find((e) => e.agentId === agentId)?.label;
}

/** 正在跑的子代理数量（页头触发器用强调色）。 */
export function runningSubagents(entries: SubagentEntry[]): number {
  return entries.filter((e) => e.status === "running").length;
}

/**
 * 一个子代理跑了多久（毫秒），没数据时返回 undefined。
 *
 * - **运行中**：按墙钟算（`now - startedAt`）。CLI 的 `usage.duration_ms` 只在
 *   `task_progress` 到达时刷新，两个工具调用之间可能几十秒没有新帧——只看它，秒数会停住。
 * - **已结束**：优先用 CLI 的 `usage.durationMs`（结束通知里的权威值，含它自己的计时口径），
 *   没有再退回「收尾时刻 - 启动时刻」（转录回放只有这两个时间戳）。
 */
export function subagentElapsed(entry: SubagentEntry, now: number): number | undefined {
  const usageMs = entry.usage?.durationMs;
  if (entry.status === "running" && entry.startedAt !== undefined) {
    return Math.max(0, now - entry.startedAt);
  }
  if (usageMs !== undefined && usageMs > 0) return usageMs;
  // 后台子代理的 `finishedAt` 是**启动回执**到达的时刻（几乎等于启动时刻），拿它算会
  // 得到「0s」——那是个假的耗时，宁可不显示。真实收尾时刻只有子代理转录里才有
  // （重启后由 settleSubagents 回填成 endedAt）。
  const end = entry.endedAt ?? (entry.background ? undefined : entry.finishedAt);
  if (entry.startedAt !== undefined && end !== undefined) {
    return Math.max(0, end - entry.startedAt);
  }
  return undefined;
}
