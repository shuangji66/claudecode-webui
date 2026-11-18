// 会话里的任务列表：从消息流现算，不额外存状态（同 lib/subagents.ts 的口径）。
//
// 为什么从 tool_use / tool_result 算、而不是去读 claude 的 ~/.claude/tasks/*.json：
// 面板要回答的是「这条对话在做什么」，回放转录时拿到的也是同一批 tool 消息，
// 不需要给前端再加一条读磁盘的接口（那条路还会把别的对话留下的任务一起翻出来）。
//
// 两种来源（claude 2.1.327 实测）：
//   - Tasks API：TaskCreate / TaskUpdate / TaskList，任务落盘、带 blockedBy 依赖；
//   - TodoWrite：整份快照 todos: [{ content, status, activeForm }]，只在会话内存里。
//
// 结果文案是 CLI 自己的格式，界面解析它俩当兜底（tool_use_result 里的结构化字段优先）：
//   `Task #<id> created successfully: <subject>`
//   `Updated task #<id> updated fields`
//   TaskList 一行一条：`#1 [pending] 写后端 fsapi [blocked by #1, #2]`
import type { Item } from "./model";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskEntry {
  /** claude 的任务 id（TodoWrite 没 id，用 `todo-<序号>`）。 */
  id: string;
  subject: string;
  status: TaskStatus;
  /** 进行中的展示文案（claude 的 activeForm，例如「正在写后端 fsapi」）。 */
  activeForm?: string;
  /** 依赖的任务 id；界面上只标「等待 #1」，不重排顺序。 */
  blockedBy: string[];
}

export interface TaskCounts {
  total: number;
  inProgress: number;
  pending: number;
  completed: number;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

const STATUSES: TaskStatus[] = ["pending", "in_progress", "completed"];

/** 归一化状态；不认识的（含 TaskUpdate 的 deleted）一律返回 undefined。 */
export function taskStatus(v: unknown): TaskStatus | undefined {
  return STATUSES.includes(v as TaskStatus) ? (v as TaskStatus) : undefined;
}

const CREATED_ID = /^Task #(\S+) created successfully/m;
const UPDATED_ID = /^Updated task #(\S+)/m;
const LIST_LINE = /^#(\S+)\s+\[(pending|in_progress|completed)\]\s+(.+?)(?:\s+\[blocked by ([^\]]*)\])?\s*$/;

function blockedIds(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.replace(/^#/, "").trim())
    .filter(Boolean);
}

function upsert(list: TaskEntry[], next: TaskEntry): void {
  const i = list.findIndex((e) => e.id === next.id);
  if (i >= 0) list[i] = { ...list[i], ...next };
  else list.push(next);
}

/** 把一条 TaskCreate 变成任务条目；拿不到 id（还没结果 / 被拒）时返回 null。 */
function createdEntry(it: Extract<Item, { kind: "tool" }>): TaskEntry | null {
  const input = rec(it.input) ?? {};
  const subject = str(input.subject) || str(input.description);
  if (!subject) return null;
  const id = str(rec(it.structured)?.taskId) || (it.result ?? "").match(CREATED_ID)?.[1] || "";
  if (!id) return null;
  const blockedBy = Array.isArray(input.blockedBy) ? input.blockedBy.map((v) => str(v)).filter(Boolean) : [];
  return {
    id,
    subject,
    status: "pending",
    activeForm: str(input.activeForm) || undefined,
    blockedBy,
  };
}

/** TodoWrite 是整份快照：直接替换列表（它没有 id，位置就是身份）。 */
function todoEntries(it: Extract<Item, { kind: "tool" }>): TaskEntry[] | null {
  const todos = rec(it.input)?.todos;
  if (!Array.isArray(todos)) return null;
  const out: TaskEntry[] = [];
  todos.forEach((todo, i) => {
    const t = rec(todo);
    if (!t) return;
    const subject = str(t.content) || str(t.activeForm);
    if (!subject) return;
    out.push({
      id: `todo-${i}`,
      subject,
      status: taskStatus(t.status) ?? "pending",
      activeForm: str(t.activeForm) || undefined,
      blockedBy: [],
    });
  });
  return out;
}

/**
 * 按消息顺序重放，得到这份对话当前的任务列表。
 *
 * 幂等：同一条消息重复到达（重连回放、CLI 重试）不会多出条目。
 * 删除走 TaskUpdate 的 `status: "deleted"`，不是自己发明的状态。
 */
export function taskEntries(items: Item[]): TaskEntry[] {
  let list: TaskEntry[] = [];
  for (const it of items) {
    if (it.kind !== "tool") continue;

    if (it.name === "TodoWrite") {
      const snapshot = todoEntries(it);
      if (snapshot && snapshot.length > 0) list = snapshot;
      continue;
    }

    if (it.name === "TaskCreate") {
      const entry = createdEntry(it);
      if (entry) upsert(list, entry);
      continue;
    }

    if (it.name === "TaskUpdate") {
      const input = rec(it.input) ?? {};
      const id = str(input.taskId) || str(rec(it.structured)?.taskId) || (it.result ?? "").match(UPDATED_ID)?.[1] || "";
      if (!id) continue;
      if (str(input.status) === "deleted") {
        list = list.filter((e) => e.id !== id);
        continue;
      }
      const existing = list.find((e) => e.id === id);
      const status = taskStatus(input.status) ?? taskStatus(rec(rec(it.structured)?.statusChange)?.to);
      const subject = str(input.subject) || existing?.subject || "";
      if (!subject) continue;
      upsert(list, {
        id,
        subject,
        status: status ?? existing?.status ?? "pending",
        activeForm: str(input.activeForm) || existing?.activeForm,
        blockedBy: existing?.blockedBy ?? [],
      });
      continue;
    }

    if (it.name === "TaskList") {
      // TaskList 是快照视图：逐行 upsert，不删本地多出来的（可能是别的列表 id）。
      for (const line of (it.result ?? "").split("\n")) {
        const m = line.trim().match(LIST_LINE);
        if (!m) continue;
        upsert(list, {
          id: m[1],
          subject: m[3].trim(),
          status: m[2] as TaskStatus,
          blockedBy: blockedIds(m[4] ?? ""),
        });
      }
    }
  }
  return list;
}

export function taskCounts(entries: TaskEntry[]): TaskCounts {
  let inProgress = 0;
  let pending = 0;
  let completed = 0;
  for (const e of entries) {
    if (e.status === "in_progress") inProgress += 1;
    else if (e.status === "completed") completed += 1;
    else pending += 1;
  }
  return { total: entries.length, inProgress, pending, completed };
}
