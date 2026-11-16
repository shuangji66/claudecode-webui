import { describe, expect, it } from "vitest";
import { activeTurnIndex, turnsOf } from "./turns";
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
});

describe("activeTurnIndex", () => {
  it("取最后一个已滚过的轮", () => {
    const tops = [0, 500, 1200];
    expect(activeTurnIndex(tops, 0)).toBe(0);
    expect(activeTurnIndex(tops, 460)).toBe(0);
    expect(activeTurnIndex(tops, 520)).toBe(1);
    expect(activeTurnIndex(tops, 2000)).toBe(2);
  });

  it("空刻度返回 -1", () => {
    expect(activeTurnIndex([], 100)).toBe(-1);
  });
});
