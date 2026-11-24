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
  /** 「此刻在做什么」的来源（见 `subagentProgressLine`）：模型摘要与 CLI 的活动描述。 */
  summary?: string;
  progressText?: string;
  progressTool?: string;
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
      ...(sub.summary ? { summary: sub.summary } : {}),
      ...(sub.progressText ? { progressText: sub.progressText } : {}),
      ...(sub.progressTool ? { progressTool: sub.progressTool } : {}),
      startedAt: it.ts,
      ...(it.doneAt !== undefined ? { finishedAt: it.doneAt } : {}),
      ...(sub.endedAt !== undefined ? { endedAt: sub.endedAt } : {}),
    });
  }
  return out;
}

/**
 * 子代理**此刻在做什么**的一行字（页头列表的第二行、卡片上那句摘要）。
 *
 * 两条来源，优先模型摘要、其次 CLI 自己的活动描述：
 *   - `summary`：initialize 的 `agentProgressSummaries` 让 CLI 生成的摘要。语义最好，
 *     但它要花一次额外的模型请求（CLI 把整份子代理上下文 fork 进去），而自建中转上的
 *     模型常常无视提示词里的 "Do not use tools" 直接调工具——那一次白花，`summary`
 *     一个子代理跑到底一条都没有（实测 2.1.330 四次尝试全空）。
 *   - `progressText` / `progressTool`：`task_progress` 自带的 `description` 与
 *     `last_tool_name`，每次工具调用都变、不花请求、从不缺席。多数环境下真正会动的
 *     就是这一份。
 *
 * 两者都没有时返回 undefined（不摆一行空占位）。
 */
export function subagentProgressLine(sub: SubagentInfo | undefined | null): string | undefined {
  if (!sub) return undefined;
  const activity = sub.summary?.trim() || sub.progressText?.trim();
  if (!activity) return undefined;
  const tool = sub.progressTool?.trim();
  // 工具名只在没有模型摘要时当前缀：摘要已经说清在干什么，再叠一个工具名是噪音。
  if (tool && !sub.summary?.trim()) return `${tool} · ${activity}`;
  return activity;
}

/**
 * 这个子代理**消耗**了多少 token。
 *
 * 只认累计值（`consumedTokens`）：CLI 的 `totalTokens` 是「最后一次请求的上下文有多大」，
 * 拿它当消耗会小看一到两个数量级（实测 97 次请求的审查子代理：232K 对 16.4M）。
 * 累计值有两个来源、同口径：实时由后端扫子代理转录（重启后），或 `settleSubagents`
 * 从同一条旁路恢复。两者都没有时才退回 `totalTokens`——那时界面上至少有个数字，
 * 但它是「最近一次请求」，不是消耗。
 */
export function subagentTokensUsed(usage: SubagentInfo["usage"] | undefined): number | undefined {
  if (!usage) return undefined;
  if (usage.consumedTokens !== undefined && usage.consumedTokens > 0) return usage.consumedTokens;
  return usage.totalTokens > 0 ? usage.totalTokens : undefined;
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
