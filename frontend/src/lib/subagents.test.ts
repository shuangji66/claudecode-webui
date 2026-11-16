import { describe, expect, it } from "vitest";
import { runningSubagents, subagentEntries, subagentLabel } from "./subagents";
import type { Item, ToolItem } from "./model";

function tool(over: Partial<ToolItem>): ToolItem {
  return {
    id: "i1",
    seq: 0,
    ts: 0,
    kind: "tool",
    toolUseId: "tu1",
    name: "Agent",
    input: {},
    ...over,
  };
}

const items: Item[] = [
  tool({
    id: "i1",
    toolUseId: "tu1",
    subagent: { taskId: "t1", agentId: "a1", description: "先看代码", type: "Explore", status: "completed" },
  }),
  tool({
    id: "i2",
    toolUseId: "tu2",
    subagent: { taskId: "t2", agentId: "a2", type: "general-purpose", status: "running" },
  }),
  // 同一个 agent 的重复卡片不重复列出。
  tool({
    id: "i3",
    toolUseId: "tu3",
    subagent: { taskId: "t1", agentId: "a1", description: "先看代码", status: "completed" },
  }),
  { id: "i4", seq: 4, ts: 0, kind: "user", text: "hi" },
];

describe("subagentEntries", () => {
  it("按启动顺序列出、去重、缺描述时回落类型", () => {
    const entries = subagentEntries(items);
    expect(entries.map((e) => e.agentId)).toEqual(["a1", "a2"]);
    expect(entries[0].label).toBe("先看代码");
    expect(entries[1].label).toBe("general-purpose");
  });

  it("没有子代理时返回空数组", () => {
    expect(subagentEntries([{ id: "u", seq: 0, ts: 0, kind: "user", text: "hi" }])).toEqual([]);
  });

  it("按 id 找标签，找不到返回 undefined", () => {
    expect(subagentLabel(items, "a2")).toBe("general-purpose");
    expect(subagentLabel(items, "nope")).toBeUndefined();
  });

  it("统计运行中的数量", () => {
    expect(runningSubagents(subagentEntries(items))).toBe(1);
  });
});
