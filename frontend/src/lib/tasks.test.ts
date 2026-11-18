import { describe, expect, it } from "vitest";
import type { Item, ToolItem } from "./model";
import { taskCounts, taskEntries, taskStatus } from "./tasks";

function tool(over: Partial<ToolItem> = {}): ToolItem {
  return {
    id: "i1",
    seq: 0,
    ts: 0,
    kind: "tool",
    toolUseId: "tu1",
    name: "TaskCreate",
    input: {},
    ...over,
  };
}

let seq = 0;
function t(over: Partial<ToolItem> = {}): ToolItem {
  seq += 1;
  return tool({ id: `i${seq}`, seq, toolUseId: `tu${seq}`, ...over });
}

describe("taskEntries", () => {
  it("TaskCreate 从结果文本里取 id，未返回结果的不显示", () => {
    const items: Item[] = [
      t({ input: { subject: "写后端 fsapi" }, result: "Task #1 created successfully: 写后端 fsapi" }),
      t({ input: { subject: "还没建好" } }),
    ];
    expect(taskEntries(items)).toEqual([
      { id: "1", subject: "写后端 fsapi", status: "pending", activeForm: undefined, blockedBy: [] },
    ]);
  });

  it("tool_use_result 的结构化字段优先于结果文案", () => {
    const items: Item[] = [
      t({ input: { subject: "写后端" }, structured: { success: true, taskId: "7" }, result: "Task #7 created successfully" }),
    ];
    expect(taskEntries(items)[0].id).toBe("7");
  });

  it("TaskUpdate 改状态与标题，deleted 就移除", () => {
    const items: Item[] = [
      t({ input: { subject: "写后端" }, result: "Task #1 created successfully" }),
      t({ input: { subject: "写前端" }, result: "Task #2 created successfully" }),
      t({ name: "TaskUpdate", input: { taskId: "1", status: "in_progress" }, result: "Updated task #1 status" }),
      t({ name: "TaskUpdate", input: { taskId: "2", status: "deleted" }, structured: { success: true, taskId: "2" } }),
    ];
    expect(taskEntries(items)).toEqual([
      { id: "1", subject: "写后端", status: "in_progress", activeForm: undefined, blockedBy: [] },
    ]);
  });

  it("statusChange 兜底：入参没写状态时取结构化结果里的新值", () => {
    const items: Item[] = [
      t({ input: { subject: "写后端" }, result: "Task #1 created successfully" }),
      t({
        name: "TaskUpdate",
        input: { taskId: "1" },
        structured: { success: true, taskId: "1", statusChange: { from: "pending", to: "completed" } },
      }),
    ];
    expect(taskEntries(items)[0].status).toBe("completed");
  });

  it("TaskList 的结果是快照视图，按行合并", () => {
    const items: Item[] = [
      t({ name: "TaskList", result: "#1 [in_progress] 写后端\n#2 [pending] 写前端 [blocked by #1]" }),
    ];
    expect(taskEntries(items)).toEqual([
      { id: "1", subject: "写后端", status: "in_progress", blockedBy: [] },
      { id: "2", subject: "写前端", status: "pending", blockedBy: ["1"] },
    ]);
  });

  it("TodoWrite 是整份快照：替换列表并按序号生成 id", () => {
    const items: Item[] = [
      t({ input: { subject: "旧任务" }, result: "Task #1 created successfully" }),
      t({
        name: "TodoWrite",
        input: {
          todos: [
            { content: "读代码", status: "completed", activeForm: "读代码" },
            { content: "改实现", status: "in_progress", activeForm: "改实现" },
            { content: "跑测试", status: "pending", activeForm: "跑测试" },
          ],
        },
      }),
    ];
    expect(taskEntries(items).map((e) => [e.id, e.subject, e.status])).toEqual([
      ["todo-0", "读代码", "completed"],
      ["todo-1", "改实现", "in_progress"],
      ["todo-2", "跑测试", "pending"],
    ]);
  });

  // 模型收尾时会用一条 `todos: []` 的 TodoWrite 把列表清空：空数组是有效快照，
  // 当成无效输入的话，任务早就做完了面板上还挂着旧清单。
  it("TodoWrite 的空快照会清空列表", () => {
    const items: Item[] = [
      t({
        name: "TodoWrite",
        input: { todos: [{ content: "读代码", status: "in_progress" }] },
      }),
      t({ name: "TodoWrite", input: { todos: [] } }),
    ];
    expect(taskEntries(items)).toEqual([]);
  });

  it("幂等：同一条消息重复到达不会多出条目", () => {
    const one = t({ input: { subject: "只建一次" }, result: "Task #3 created successfully" });
    expect(taskEntries([one, one, one])).toHaveLength(1);
  });

  it("认不出的工具与坏入参一律跳过", () => {
    const items: Item[] = [
      t({ name: "Bash", input: { command: "ls" } }),
      t({ input: null }),
      t({ input: { subject: "  " } }),
      t({ name: "TaskUpdate", input: { status: "completed" } }),
    ];
    expect(taskEntries(items)).toEqual([]);
  });
});

describe("taskCounts", () => {
  it("按状态计数", () => {
    const items: Item[] = [
      t({ name: "TaskList", result: "#1 [in_progress] a\n#2 [pending] b\n#3 [pending] c\n#4 [completed] d" }),
    ];
    expect(taskCounts(taskEntries(items))).toEqual({ total: 4, inProgress: 1, pending: 2, completed: 1 });
  });

  it("空列表全是 0", () => {
    expect(taskCounts([])).toEqual({ total: 0, inProgress: 0, pending: 0, completed: 0 });
  });
});

describe("taskStatus", () => {
  it("只认三个已知状态，deleted 返回 undefined", () => {
    expect(taskStatus("pending")).toBe("pending");
    expect(taskStatus("in_progress")).toBe("in_progress");
    expect(taskStatus("completed")).toBe("completed");
    expect(taskStatus("deleted")).toBeUndefined();
    expect(taskStatus(undefined)).toBeUndefined();
  });
});
