// 从消息流里收集子代理，供页头「子智能体 N」与审批归属使用（纯函数）。

import type { Item, SubagentInfo } from "./model";

export interface SubagentEntry {
  /** claude 的 agentId（= taskId），打开对话用它。 */
  agentId: string;
  taskId: string;
  /** 描述优先，其次类型，最后回落到 id。 */
  label: string;
  type?: string;
  status: SubagentInfo["status"];
  usage?: SubagentInfo["usage"];
}

/** 按出现顺序（= 启动顺序）列出本会话的子代理，同一个 agent 只保留一条。 */
export function subagentEntries(items: Item[]): SubagentEntry[] {
  const out: SubagentEntry[] = [];
  for (const it of items) {
    if (it.kind !== "tool" || !it.subagent) continue;
    const sub = it.subagent;
    const agentId = sub.agentId ?? sub.taskId;
    if (!agentId || out.some((e) => e.agentId === agentId)) continue;
    out.push({
      agentId,
      taskId: sub.taskId,
      label: sub.description || sub.type || agentId,
      type: sub.type,
      status: sub.status,
      usage: sub.usage,
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
