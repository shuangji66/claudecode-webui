import { describe, expect, it } from "vitest";
import { applyCLI } from "./normalize";
import type { Item } from "./model";
import { formatSpanMs, spanGeometry, traceTurns } from "./trace";

/** 先按时间顺序拼一份 Item 列表：seq 只影响稳定排序，这里用下标即可。 */
function list(...items: Item[]): Item[] {
  return items.map((it, i) => ({ ...it, seq: i } as Item));
}

const user = (id: string, ts: number, text = "把这件事做了"): Item => ({ id, seq: 0, ts, kind: "user", text });

const assistant = (id: string, ts: number, text: string, model?: string): Item => ({
  id,
  seq: 0,
  ts,
  kind: "assistant",
  text,
  streaming: false,
  ...(model ? { model } : {}),
});

const tool = (id: string, ts: number, doneAt?: number, extra: Partial<Item> = {}): Item =>
  ({
    id,
    seq: 0,
    ts,
    kind: "tool",
    toolUseId: `tu-${id}`,
    name: "Bash",
    input: { command: "git status" },
    ...(doneAt !== undefined ? { doneAt } : {}),
    ...extra,
  }) as Item;

describe("traceTurns", () => {
  it("把一轮折成「请求 → 工具 → 请求」并按真实边界收边", () => {
    const turns = traceTurns(
      list(
        user("u1", 1_000),
        assistant("a1", 2_000, "我先看一下", "claude-sonnet-4-5"),
        tool("t1", 2_000, 7_000),
        assistant("a2", 12_000, "好了", "claude-sonnet-4-5"),
      ),
      false,
    );
    expect(turns).toHaveLength(1);
    const turn = turns[0];
    expect(turn.start).toBe(1_000);
    expect(turn.end).toBe(12_000);
    expect(turn.toolCount).toBe(1);
    expect(turn.model).toBe("claude-sonnet-4-5");
    // 请求段从用户消息结束开始，到消息落盘为止；工具段就是 tool_use → tool_result。
    expect(turn.spans.map((s) => [s.lane, s.start, s.end])).toEqual([
      ["model", 1_000, 2_000],
      ["tool", 2_000, 7_000],
      ["model", 7_000, 12_000],
    ]);
    expect(turn.spans[2].start).toBe(7_000);
  });

  it("只回了 tool_use 的请求同样占一段模型时间（工具循环里很常见）", () => {
    const turns = traceTurns(list(user("u1", 1_000), tool("t1", 2_000, 4_000)), false);
    expect(turns[0].spans.map((s) => [s.lane, s.start, s.end])).toEqual([
      ["model", 1_000, 2_000],
      ["tool", 2_000, 4_000],
    ]);
  });

  it("task 事件先造的占位卡不算一次请求边界（时间戳来自 task 事件）", () => {
    const placeholder = {
      id: "t0",
      seq: 0,
      ts: 1_200,
      kind: "tool",
      toolUseId: "tu-a",
      name: "Agent",
      input: { description: "后台任务" },
      subagent: { taskId: "task-1", status: "running" },
      placeholder: true,
    } as Item;
    const turns = traceTurns(list(user("u1", 1_000), placeholder, assistant("a1", 2_000, "派了一个")), true, 2_500);
    // 占位卡自己是子代理段（还在跑，顶到现在），但它不推进 cursor——
    // 模型请求仍然从上一次活动结束（占位卡那一秒）算起。
    expect(turns[0].spans.map((s) => [s.lane, s.start, s.end])).toEqual([
      ["model", 1_200, 2_000],
      ["subagent", 1_200, 2_500],
      // 占位卡不阻塞主循环：回答之后这一刻仍在等上游，补一条进行中的请求段。
      ["model", 2_000, 2_500],
    ]);
  });

  it("还在跑的轮次把末尾拉到「此刻」，并标成进行中", () => {
    const turns = traceTurns(list(user("u1", 1_000), assistant("a1", 3_000, "想一下", "m")), true, 8_000);
    const turn = turns[0];
    expect(turn.finished).toBe(false);
    const last = turn.spans[turn.spans.length - 1];
    expect(last.lane).toBe("model");
    expect(last.running).toBe(true);
    expect(last.end).toBe(8_000);
    expect(turn.end).toBe(8_000);
  });

  it("还在跑的工具顶到此刻；有工具在跑时不再补一条假的请求段", () => {
    const turns = traceTurns(list(user("u1", 1_000), assistant("a1", 2_000, "跑一下"), tool("t1", 2_000)), true, 9_000);
    const spans = turns[0].spans;
    expect(spans.filter((s) => s.lane === "model")).toHaveLength(1);
    const running = spans.find((s) => s.lane === "tool")!;
    expect(running.running).toBe(true);
    expect(running.end).toBe(9_000);
  });

  it("后台子代理的时长以 task 用量为准，而不是那条启动回执", () => {
    const turns = traceTurns(
      list(
        user("u1", 1_000),
        assistant("a1", 2_000, "派一个"),
        tool("t1", 2_000, 2_100, {
          name: "Agent",
          toolUseId: "tu-agent",
          input: { description: "查依赖" },
          subagent: {
            taskId: "task-1",
            agentId: "agent-1",
            status: "completed",
            type: "Explore",
            description: "查依赖",
            usage: { totalTokens: 1_000, toolUses: 3, durationMs: 9_000 },
          },
        }),
      ),
      false,
    );
    const span = turns[0].spans.find((s) => s.lane === "subagent")!;
    expect(span.end).toBe(11_000);
    expect(span.detail).toContain("3 次工具");
    expect(span.agentId).toBe("agent-1");
    expect(turns[0].subagentCount).toBe(1);
  });

  // 重启后 stdout 上那条 task 通知已经不在：CLI 的 duration_ms 没了，磁盘上只剩
  // 子代理自己转录的收尾时刻。不认 endedAt 的话，跑了十分钟的后台子代理在泳道上
  // 只占启动回执那么一根线（看起来像「什么也没干」）。
  it("重启后用转录恢复的收尾时刻收边", () => {
    const turns = traceTurns(
      list(
        user("u1", 1_000),
        assistant("a1", 2_000, "派一个"),
        tool("t1", 2_000, 2_100, {
          name: "Agent",
          toolUseId: "tu-agent",
          input: { description: "查依赖" },
          subagent: {
            taskId: "task-1",
            agentId: "agent-1",
            status: "stopped",
            background: true,
            endedAt: 32_000,
            // 恢复出来的用量只有 token 数：工具次数与耗时不在这里。
            usage: { totalTokens: 47_200 },
          },
        }),
      ),
      false,
    );
    const span = turns[0].spans.find((s) => s.lane === "subagent")!;
    expect(span.end).toBe(32_000);
  });

  it("系统事件画成零时长的标记（压缩、报错不会凭空占一段时间）", () => {
    const turns = traceTurns(
      list(
        user("u1", 1_000),
        { id: "s1", seq: 0, ts: 5_000, kind: "system", subtype: "compact_boundary", text: "上下文已压缩" },
        assistant("a1", 6_000, "继续"),
      ),
      false,
    );
    const ev = turns[0].spans.find((s) => s.lane === "event")!;
    expect(ev.start).toBe(5_000);
    expect(ev.end).toBe(5_000);
    expect(ev.label).toContain("上下文已压缩");
  });

  it("一轮里有多条 result 时用量相加（插话把一轮拆成几个子回合）", () => {
    const usage = (turnInputTokens: number, outputTokens: number) => ({
      contextTokens: 0,
      turnInputTokens,
      outputTokens,
    });
    const turns = traceTurns(
      list(
        user("u1", 1_000),
        assistant("a1", 2_000, "第一段"),
        { id: "r1", seq: 0, ts: 2_000, kind: "result", durationMs: 1_000, usage: usage(100, 10) },
        { ...(user("u2", 3_000, "补一句") as Extract<Item, { kind: "user" }>), interjected: true },
        assistant("a2", 4_000, "第二段"),
        { id: "r2", seq: 0, ts: 4_000, kind: "result", durationMs: 1_000, usage: usage(200, 20) },
      ),
      false,
    );
    // 插话不切轮：仍是同一轮，两段用量相加。
    expect(turns).toHaveLength(1);
    expect(turns[0].inputTokens).toBe(300);
    expect(turns[0].outputTokens).toBe(30);
  });

  it("空列表与没有用户消息的片段都不炸", () => {
    expect(traceTurns([], false)).toEqual([]);
    const turns = traceTurns(list(assistant("a1", 1_000, "只有回答")), false);
    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe("");
  });
});

describe("spanGeometry", () => {
  it("按这一轮的起止换算比例", () => {
    const turn = traceTurns(list(user("u1", 1_000), assistant("a1", 2_000, "答")), false)[0];
    const span = turn.spans[0];
    const g = spanGeometry(span, turn);
    expect(g.left).toBeCloseTo(0, 5);
    expect(g.width).toBeCloseTo(1, 5);
    const mid = spanGeometry({ ...span, start: 1_500, end: 2_000 }, turn);
    expect(mid.left).toBeCloseTo(0.5, 5);
    expect(mid.width).toBeCloseTo(0.5, 5);
  });
});

describe("formatSpanMs", () => {
  it("亚秒给 ms，十秒内留一位小数，再长用 mm:ss", () => {
    expect(formatSpanMs(820)).toBe("820ms");
    expect(formatSpanMs(1_240)).toBe("1.2s");
    expect(formatSpanMs(12_400)).toBe("00:12");
    expect(formatSpanMs(-5)).toBe("0ms");
  });
});

describe("normalize 为轨迹补的两个字段", () => {
  it("tool_result 回填 doneAt（工具耗时靠它）", () => {
    let items = applyCLI([], {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }],
      },
    }, 1_000);
    items = applyCLI(items, {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
    }, 4_000);
    const card = items.find((it) => it.kind === "tool");
    expect(card).toMatchObject({ toolUseId: "tu1", doneAt: 4_000 });
  });

  it("assistant 消息带上模型名（同一轮换过模型时泳道才分得开）", () => {
    const items = applyCLI([], {
      type: "assistant",
      message: { role: "assistant", model: "claude-opus-4-1", content: [{ type: "text", text: "hi" }] },
    });
    expect(items[0]).toMatchObject({ kind: "assistant", model: "claude-opus-4-1" });
  });
});
