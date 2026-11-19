// 后台操作：会话里还在后台跑、但不是子代理的那些任务（纯函数）。
//
// 为什么必须和子代理分开：两者都发 system/task_* 事件、都带 task_id 与 description，
// 但从用户角度看是两件事——子代理有自己的对话可查看（点开右侧栏标签），
// 后台命令（`Bash` 带 `run_in_background`、MCP 调用）没有转录，只能看结果或中止。
// 混在一个「子智能体 N」的列表里，会让页头显示几十条「Run full frontend tests」，
// 把真正的子代理淹掉。
//
// 判定依据是 `subagent.taskType`：`local_agent` 是子代理，其余（`local_bash` /
// `mcp_task` / 未来的类型）都归后台操作。**缺 taskType 时按子代理处理**——老版本
// CLI 与转录回放都拿不到它，此时宁可多列在子智能体里，也不要把子代理错当成后台
// 命令（那会连「查看对话」的入口一起丢掉）。
//
// **只列还在跑的**：这块是「现在有哪些后台活在跑、要不要中止」的控制面板，不是历史
// 记录。跑完就从列表里消失，全跑完后入口图标自动隐藏（与 DSH 一致）；已经结束的
// 后台命令仍留在对话正文里那张卡片上，不会丢信息。

import type { Item } from "./model";
import { subagentEntries, type SubagentEntry } from "./subagents";
import type { LiveTask } from "../transport/types";

/** 一次还在后台跑的操作（后台命令 / MCP 调用），不包含子代理。 */
export interface BackgroundTaskEntry {
  /** 中止用的 task_id；后端表里也没有时为空串（此时不给中止按钮）。 */
  taskId: string;
  /** 发起它的那次 tool_use。 */
  toolUseId: string;
  /** 一句话说明它在做什么。 */
  label: string;
  /** 工具名（`Bash` / MCP 工具名），用于图标与分类。 */
  toolName: string;
  /** 已跑秒数（实时 task_progress 给的；没有就不显示）。 */
  progress?: number;
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 这个任务是不是子代理（Agent 工具起的）。判定见文件头。 */
export function isSubagentTask(taskType: string | undefined): boolean {
  // 缺 taskType 一律当子代理：老 CLI / 转录回放给不出这个字段。
  return taskType === undefined || taskType === "" || taskType === "local_agent";
}

/**
 * 从消息流里挑出「还在跑的非子代理后台操作」，按出现顺序，同一个 task 只留一条。
 *
 * `live` 是后端随快照下发的任务表（`useAppStore.liveTasks[sid]`）。它在这里补的是
 * **`task_id`**：中途连上来的设备只有转录回放，没有 task_started，因此消息流里
 * 那条工具卡片根本不知道自己对应哪个 task——不靠这张表按 `tool_use_id` 回填，
 * 「中止」按钮就没有目标可发。表里也没有时 `taskId` 留空，界面据此不给按钮
 * （不好过点一下报错）。
 */
export function backgroundTasks(items: Item[], live: LiveTask[] = []): BackgroundTaskEntry[] {
  const byToolUse = new Map<string, LiveTask>();
  const byTaskId = new Map<string, LiveTask>();
  for (const t of live) {
    // ambient（不算活动的观察者之类）**也要进索引**：它的作用是在下面出列表时把这
    // 一条挡掉，索引里直接跳过就等于「查不到 → 当成普通任务照列」。两张索引都建：
    // 实时路径上卡片自己就带 taskId（不需要 live 回填），只按 tool_use_id 索引的话
    // `known` 会取不到。
    if (t.tool_use_id) byToolUse.set(t.tool_use_id, t);
    if (t.task_id) byTaskId.set(t.task_id, t);
  }
  const out: BackgroundTaskEntry[] = [];
  for (const it of items) {
    if (it.kind !== "tool" || !it.subagent) continue;
    const sub = it.subagent;
    // 卡片自己带 taskId 时也要认 live 那条：ambient 与 task_type 都只在那张表里，
    // 而实时路径下 `task_started` 已经把 taskId 写进了卡片。
    const known = byToolUse.get(it.toolUseId) ?? (sub.taskId ? byTaskId.get(sub.taskId) : undefined);
    // ambient（不算活动的观察者之类）不列。**必须在出列表时再挡一次**：索引里跳过它
    // 只保证「不回填」，卡片自己带着 taskId 时照样会走到这里（实时路径的常态）。
    if (known?.ambient) continue;
    // 类型以"消息流优先、后端表兜底"：转录回放里没有 task_started，卡片上没有
    // taskType，此时只有后端表能告诉我们它是后台命令还是子代理。
    const taskType = sub.taskType || known?.task_type;
    // 子代理归页头的「子智能体」，这里不重复列。
    if (isSubagentTask(taskType)) continue;
    // 只列还在跑的：跑完就从面板里消失（见文件头）。
    if (sub.status !== "running") continue;
    const taskId = sub.taskId || known?.task_id || "";
    if (out.some((e) => (taskId ? e.taskId === taskId : e.toolUseId === it.toolUseId))) continue;
    const input = (it.input ?? {}) as Record<string, unknown>;
    out.push({
      taskId,
      toolUseId: it.toolUseId,
      label: known?.description || sub.description || text(input.description) || text(it.name),
      toolName: it.name,
      progress: it.progress,
    });
  }
  return out;
}

/**
 * 只保留子代理的条目：页头「子智能体 N」用它。
 *
 * 直接在 `subagentEntries` 上过滤，而不是另写一份遍历——两处口径必须一致，
 * 不然同一件事会在两边都不出现，数量也对不上。
 */
export function subagentsOnly(items: Item[]): SubagentEntry[] {
  return subagentEntries(items).filter((e) => isSubagentTask(e.taskType));
}
