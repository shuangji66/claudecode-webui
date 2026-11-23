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
 * 一个子代理**现在**是什么状态。
 *
 * **不能看 `item.result`**：后台子代理（`run_in_background`）的 `tool_result` 只是一条
 * 启动回执（`Async agent launched successfully.` + `agentId:`，没有 `<usage>`），
 * 它到达只说明「已经起来了」，`result !== undefined` 完全不代表跑完了。按它判的结果是
 * 卡片一出现就写「完成」，而子代理其实正在跑（截图复现过）。
 *
 * 子代理的结论只有两条来源：实时的 `system/task_*` 折进 `subagent.status`；回放靠
 * `<task-notification>`（`applyTaskNotification`）与 `settleSubagents`。缺 `subagent`
 * 时**按运行中算**——「还不知道」不能写成「完成了」，这与 `settleSubagents` 只把
 * running 收成 stopped 是同一条口径：拿不到结论时宁可留着进行中，也不给一个骗人的绿点。
 */
export function subagentStatusOf(sub: SubagentInfo | undefined | null): SubagentInfo["status"] {
  return sub?.status ?? "running";
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
 * **已结束**的子代理耗时：CLI 的 `usage.durationMs` 优先，其次「收尾时刻 - 启动时刻」。
 *
 * 两个来源的权威性不同：`duration_ms` 来自 CLI 的结束通知（它自己的计时口径）；
 * `endedAt` 是子代理转录最后一行的时刻，只有重启后从磁盘恢复时才拿得到（见
 * `history.subagentStates`）。调用方自己决定 `endedAt` 该取哪个字段——列表里
 * 后台子代理的 `finishedAt` 是**启动回执**到达的时刻（几乎等于启动时刻），拿它算会
 * 得到「0s」，所以那里传 undefined。
 */
export function endedElapsed(
  usage: SubagentInfo["usage"] | undefined,
  startedAt: number | undefined,
  endedAt: number | undefined,
): number | undefined {
  const usageMs = usage?.durationMs;
  if (usageMs !== undefined && usageMs > 0) return usageMs;
  if (startedAt === undefined || endedAt === undefined) return undefined;
  return Math.max(0, endedAt - startedAt);
}

/**
 * 一个子代理跑了多久（毫秒），没数据时返回 undefined。
 *
 * - **运行中**：按墙钟算（`now - startedAt`）。CLI 的 `usage.duration_ms` 只在
 *   `task_progress` 到达时刷新，两个工具调用之间可能几十秒没有新帧——只看它，秒数会停住。
 * - **已结束**：见 `endedElapsed`。
 */
export function subagentElapsed(entry: SubagentEntry, now: number): number | undefined {
  if (entry.status === "running" && entry.startedAt !== undefined) {
    return Math.max(0, now - entry.startedAt);
  }
  // 后台子代理的 `finishedAt` 是**启动回执**到达的时刻（几乎等于启动时刻），拿它算会
  // 得到「0s」——那是个假的耗时，宁可不显示。真实收尾时刻只有子代理转录里才有
  // （重启后由 settleSubagents 回填成 endedAt）。
  const end = entry.endedAt ?? (entry.background ? undefined : entry.finishedAt);
  return endedElapsed(entry.usage, entry.startedAt, end);
}
