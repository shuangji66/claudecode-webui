import { describe, expect, it } from "vitest";
import {
  endedElapsed,
  runningSubagents,
  subagentElapsed,
  subagentEntries,
  subagentLabel,
  subagentLastAction,
  subagentProgressLine,
  subagentTokensUsed,
  type SubagentEntry,
} from "./subagents";
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

describe("subagentElapsed（列表里的运行时间）", () => {
  const entry = (over: Partial<SubagentEntry>): SubagentEntry => ({
    agentId: "a",
    taskId: "a",
    label: "a",
    status: "running",
    ...over,
  });

  it("运行中按墙钟算：CLI 的 duration_ms 不会每帧都来，只认它会停住", () => {
    const e = entry({ status: "running", startedAt: 1_000, usage: { totalTokens: 10, toolUses: 1, durationMs: 2_000 } });
    expect(subagentElapsed(e, 9_000)).toBe(8_000);
  });

  it("结束后优先用 CLI 的 usage.durationMs", () => {
    const e = entry({
      status: "completed",
      startedAt: 1_000,
      finishedAt: 9_000,
      usage: { totalTokens: 10, toolUses: 1, durationMs: 5_000 },
    });
    expect(subagentElapsed(e, 20_000)).toBe(5_000);
  });

  it("没有 usage 时退回收尾 - 启动（转录回放只有这两个时间戳）", () => {
    const e = entry({ status: "completed", startedAt: 1_000, finishedAt: 6_500 });
    expect(subagentElapsed(e, 20_000)).toBe(5_500);
  });

  it("什么都没有时不编一个数", () => {
    expect(subagentElapsed(entry({ status: "stopped" }), 20_000)).toBeUndefined();
  });

  // 后台子代理的 tool_result 只是启动回执：doneAt 几乎等于启动时刻。
  // 拿它算会得到「0s」，那是个假耗时（截图复现过）。
  it("后台子代理没有真实收尾时刻时宁可不显示，也不给 0s", () => {
    const e = entry({ status: "completed", background: true, startedAt: 1_000, finishedAt: 1_005 });
    expect(subagentElapsed(e, 99_000)).toBeUndefined();
  });

  it("恢复出转录里的收尾时刻后按它算（重启后）", () => {
    const e = entry({
      status: "completed",
      background: true,
      startedAt: 1_000,
      finishedAt: 1_005,
      endedAt: 28_000,
      usage: { totalTokens: 47_200 },
    });
    expect(subagentElapsed(e, 99_000)).toBe(27_000);
  });
});

describe("subagentEntries 回放兜底", () => {
  // 重启后回放主转录：没有 task_started，description 只能从 Agent 的入参里取。
  it("subagent 没有描述时回落 tool_use 入参的 description / subagent_type", () => {
    const replayed: Item[] = [
      {
        id: "r1",
        seq: 0,
        ts: 0,
        kind: "tool",
        toolUseId: "tu9",
        name: "Agent",
        input: { description: "加权随机待办生成器", prompt: "p", subagent_type: "general-purpose" },
        result: "agentId: a9 (use SendMessage)",
        subagent: { taskId: "a9", agentId: "a9", status: "completed" },
      },
    ];
    const [entry] = subagentEntries(replayed);
    expect(entry.label).toBe("加权随机待办生成器");
    expect(entry.type).toBe("general-purpose");
  });

  it("入参也没有描述时才回落到 agent id", () => {
    const bare: Item[] = [
      {
        id: "r2",
        seq: 0,
        ts: 0,
        kind: "tool",
        toolUseId: "tu10",
        name: "Agent",
        input: {},
        subagent: { taskId: "a10", agentId: "a10", status: "completed" },
      },
    ];
    expect(subagentEntries(bare)[0].label).toBe("a10");
  });
});

// 工具卡片（`AgentCard`）没有「现在几点」，它只算「已结束的耗时」：同一个口径必须和
// 页头那个列表一致，否则同一条子代理在两处显示两个数。
describe("endedElapsed（已结束的耗时，卡片与列表共用）", () => {
  it("CLI 的 durationMs 优先：那是它自己的计时口径", () => {
    expect(endedElapsed({ totalTokens: 1, durationMs: 5_000 }, 1_000, 9_000)).toBe(5_000);
  });

  it("没有 durationMs 时用收尾时刻 - 启动时刻（重启后只有这两个数）", () => {
    expect(endedElapsed({ totalTokens: 47_200 }, 1_000, 28_000)).toBe(27_000);
  });

  it("缺一头就不编一个数（0s 是假耗时）", () => {
    expect(endedElapsed(undefined, 1_000, undefined)).toBeUndefined();
    expect(endedElapsed({ totalTokens: 1 }, undefined, 28_000)).toBeUndefined();
    // durationMs 为 0 也不算数（流式中间态上报的 0）。
    expect(endedElapsed({ totalTokens: 1, durationMs: 0 }, 1_000, undefined)).toBeUndefined();
  });
});

// 「此刻在做什么」一行字：三条来源（模型摘要 / CLI 的活动描述 / 子代理自己的最后一次
// 工具调用），后两档才是多数环境下真正会动的。
describe("subagentProgressLine（行内进度）", () => {
  it("有模型摘要时用它，不再叠工具名", () => {
    expect(subagentProgressLine({ taskId: "t", status: "running", summary: "Reading runAgent.ts", progressText: "Read a.txt", progressTool: "Read" })).toBe(
      "Reading runAgent.ts",
    );
  });

  // 实测 2.1.330 + 自建中转：模型无视 "Do not use tools"，摘要一次都没产出。
  // 那时 `task_progress.description` 就是唯一会变的一行。
  it("没有摘要时退回 CLI 的活动描述，并带上工具名", () => {
    expect(subagentProgressLine({ taskId: "t", status: "running", progressText: "Reading b.txt", progressTool: "Read" })).toBe("Read · Reading b.txt");
  });

  // CLI 的进度帧是 `description: lastActivity?.activityDescription ?? 派发描述`，
  // 而 MCP / WebFetch 没有活动描述解析器 —— 那个字段每次都等于派发时那句话。
  // 拿它当「当前活动」显示的话，列表从派发之后就定住到结束（截图复现过）。
  it("description 只是派发描述的半截回显时不算进度，让位给最后一次工具调用", () => {
    const sub = {
      taskId: "t",
      status: "running" as const,
      description: "查找一篇新闻",
      progressText: "查找一篇新闻",
      progressTool: "mcp__ccweb-web__web_fetch",
    };
    expect(subagentProgressLine(sub, "web_fetch · 新闻：某地暴雨")).toBe("web_fetch · 新闻：某地暴雨");
    // 没有第三档时也不摆那句派发描述——它不是「在做什么」。
    expect(subagentProgressLine(sub)).toBeUndefined();
  });

  it("两者都没有时不摆一行占位", () => {
    expect(subagentProgressLine({ taskId: "t", status: "running" })).toBeUndefined();
    expect(subagentProgressLine(undefined)).toBeUndefined();
    expect(subagentProgressLine({ taskId: "t", status: "running", summary: "   " })).toBeUndefined();
  });
});

describe("subagentLastAction（子代理自己最近一步）", () => {
  const frame = (over: Partial<ToolItem>): ToolItem => ({
    id: `i${Math.random()}`,
    seq: 0,
    ts: 0,
    kind: "tool",
    toolUseId: "tu1",
    name: "Read",
    input: {},
    ...over,
  });

  it("取最后一次工具调用，MCP 名只留最后一段", () => {
    const items: Item[] = [
      frame({ name: "Read", input: { file_path: "a.ts" } }),
      frame({ name: "mcp__ccweb-web__web_fetch", input: { url: "https://example.com/news" } }),
    ];
    expect(subagentLastAction(items)).toBe("web_fetch · https://example.com/news");
  });

  it("没有摘要时只给工具名，不返回空串", () => {
    expect(subagentLastAction([frame({ name: "Bash", input: {} })])).toBe("Bash");
  });

  it("还没有工具调用 / 没有实时流时返回 undefined", () => {
    expect(subagentLastAction([])).toBeUndefined();
    expect(subagentLastAction(undefined)).toBeUndefined();
    expect(subagentLastAction([{ id: "a", seq: 0, ts: 0, kind: "assistant", text: "hi", streaming: false }])).toBeUndefined();
  });
});

// 界面报的是「消耗」：CLI 的 totalTokens 是最后一次请求的窗口大小。
describe("subagentTokensUsed（累计消耗）", () => {
  it("优先累计值", () => {
    expect(subagentTokensUsed({ totalTokens: 232_346, consumedTokens: 16_363_498 })).toBe(16_363_498);
  });

  it("没有累计值时退回单次值（有数字总比空着好）", () => {
    expect(subagentTokensUsed({ totalTokens: 47_200 })).toBe(47_200);
  });

  it("一个都没有时不编数字", () => {
    expect(subagentTokensUsed(undefined)).toBeUndefined();
    expect(subagentTokensUsed({ totalTokens: 0 })).toBeUndefined();
    expect(subagentTokensUsed({ totalTokens: 0, consumedTokens: 0 })).toBeUndefined();
  });
});
