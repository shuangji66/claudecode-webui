import { describe, expect, it } from "vitest";
import { activeTurnIndex, turnsOf, windowStart } from "./turns";
import type { Item } from "./model";

function user(id: string, text: string, seq: number): Item {
  return { id, seq, ts: 0, kind: "user", text };
}
function assistant(id: string, seq: number): Item {
  return { id, seq, ts: 0, kind: "assistant", text: "ok", streaming: false };
}

describe("turnsOf", () => {
  it("每条用户消息算一轮，标签取首行", () => {
    const items: Item[] = [
      user("u1", "第一个问题\n附带说明", 0),
      assistant("a1", 1),
      { id: "t1", seq: 2, ts: 0, kind: "tool", toolUseId: "tu", name: "Bash", input: {} },
      user("u2", "   \n第二个问题", 3),
      assistant("a2", 4),
    ];
    const turns = turnsOf(items);
    expect(turns.map((t) => t.index)).toEqual([0, 3]);
    expect(turns[0].label).toBe("第一个问题");
    expect(turns[1].label).toBe("第二个问题");
  });

  it("没有用户消息时没有刻度", () => {
    expect(turnsOf([assistant("a1", 0)])).toEqual([]);
  });

  it("长标签截断", () => {
    const turns = turnsOf([user("u1", "x".repeat(80), 0)]);
    expect(turns[0].label).toHaveLength(41); // 40 + 省略号
  });

  it("插话不占刻度：它不是一轮，跳转列表里不该多一条", () => {
    const items: Item[] = [
      { id: "u1", seq: 0, ts: 0, kind: "user", text: "第一问" },
      { id: "a1", seq: 1, ts: 0, kind: "assistant", text: "回答", streaming: false },
      { id: "i1", seq: 2, ts: 0, kind: "user", text: "插一句", interjected: true },
      { id: "a2", seq: 3, ts: 0, kind: "assistant", text: "继续", streaming: false },
    ];
    expect(turnsOf(items).map((t) => t.id)).toEqual(["u1"]);
  });
});

describe("activeTurnIndex", () => {
  it("取最后一个已滚过的轮", () => {
    const tops = [0, 500, 1200];
    expect(activeTurnIndex(tops, 0)).toBe(0);
    expect(activeTurnIndex(tops, 460)).toBe(0);
    expect(activeTurnIndex(tops, 520)).toBe(1);
    expect(activeTurnIndex(tops, 2000)).toBe(2);
  });

  // 回归：贴底那一刻视口顶部往往还停在上一轮的正文里（一轮的末尾可能就是整屏），
  // 按 top 算会一直亮着上一轮——看起来「滚到底了刻度却没走到最后一个」。
  it("贴底时直接取最后一轮", () => {
    const tops = [0, 500, 1200];
    expect(activeTurnIndex(tops, 900, undefined, true)).toBe(2);
    expect(activeTurnIndex([0, 500], 120, undefined, true)).toBe(1);
  });

  it("空刻度返回 -1", () => {
    expect(activeTurnIndex([], 100)).toBe(-1);
    expect(activeTurnIndex([], 100, undefined, true)).toBe(-1);
  });
});

describe("windowStart（只渲染最近一批）", () => {
  /**
   * 一轮的过程很容易超过 80 条（一次工具调用就是好几行）：按条数硬切会把这一轮的
   * 用户消息整个切出去，界面上只剩「正在分析请求」——用户看到的就是「刚发的话不见
   * 了，只剩思考过程」，内容还塌成两三行、下面大片空白。
   */
  function turn(userId: string, seq: number, tools: number): Item[] {
    const out: Item[] = [user(userId, `问题 ${userId}`, seq)];
    for (let i = 0; i < tools; i += 1) {
      out.push({ id: `${userId}-t${i}`, seq: seq + i + 1, ts: 0, kind: "tool", toolUseId: `${userId}-tu${i}`, name: "Bash", input: {} } as Item);
    }
    // 每条用户消息后面跟一句回答，模拟真实转录（否则相邻 user 行会被当成同一次发送）。
    out.push({ id: `${userId}-a`, seq: seq + tools + 1, ts: 0, kind: "assistant", text: "ok", streaming: false });
    return out;
  }

  it("条数够少时全部显示", () => {
    const items = Array.from({ length: 10 }, (_, i) => user(`u${i}`, `问题 ${i}`, i));
    expect(windowStart(items, 80)).toBe(0);
  });

  it("切点不落在轮中间：窗口从那一轮的用户消息开始", () => {
    // 第 1 轮 1 条 + 第 2 轮 100 条：limit=80 的原始切点在第二轮中间。
    const items = [...turn("a", 0, 0), ...turn("b", 2, 99)];
    const start = windowStart(items, 80);
    expect(items[start].kind).toBe("user");
    expect((items[start] as { id: string }).id).toBe("b");
  });

  it("当前这一轮无论多长都整轮保留", () => {
    // 最后一轮 300 条，前面还有两轮：窗口必须覆盖整条最后一轮。
    const items = [...turn("a", 0, 0), ...turn("b", 2, 0), ...turn("c", 4, 299)];
    const start = windowStart(items, 80);
    expect((items[start] as { id: string }).id).toBe("c");
  });

  it("没有用户消息时按条数切", () => {
    const items: Item[] = [];
    for (let i = 0; i < 200; i += 1) {
      items.push({ id: `x${i}`, seq: i, ts: 0, kind: "thinking", text: "t" });
    }
    expect(windowStart(items, 80)).toBe(120);
  });
});
