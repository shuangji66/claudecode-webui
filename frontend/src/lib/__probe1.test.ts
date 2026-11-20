import { describe, expect, it } from "vitest";
import { runningTool, replyDividerIds } from "./process";
import { applyCLI } from "./normalize";
import type { Item } from "./model";

describe("probe: stale unfinished tool 跨轮污染 runningTool", () => {
  it("上一轮遗留的未完成工具（被中断）会让后面的每一轮都被判成「有工具在跑」", () => {
    const items: Item[] = [
      { id: "u1", seq: 0, ts: 1, kind: "user", text: "跑个长命令" },
      { id: "t1", seq: 1, ts: 2, kind: "tool", toolUseId: "tu1", name: "Bash", input: {} },
      { id: "r1", seq: 2, ts: 3, kind: "result", isError: true, subtype: "interrupt" },
      { id: "u2", seq: 3, ts: 4, kind: "user", text: "下一轮" },
      { id: "a2", seq: 4, ts: 5, kind: "assistant", text: "在想", streaming: true },
    ];
    expect(runningTool(items)).toBeDefined();
  });
});

describe("probe: 分隔线 + hidden reply", () => {
  it("仅最终回答档：最后一段之前的可见段", () => {
    const items: Item[] = [
      { id: "u1", seq: 0, ts: 0, kind: "user", text: "q" },
      { id: "a1", seq: 1, ts: 0, kind: "assistant", text: "过渡", streaming: false },
      { id: "t1", seq: 2, ts: 0, kind: "thinking", text: "想" },
      { id: "a2", seq: 3, ts: 0, kind: "assistant", text: "结论", streaming: false },
    ];
    // hidden = a1（被「仅最终回答」藏掉）
    const set = replyDividerIds(items, new Set(["a1"]), true);
    console.log("divider ids when a1 hidden:", [...set]);
  });
});

describe("probe: interrupted result + thought leftover", () => {
  it("thinking_delta 之后被中断（没有完整 assistant 消息）", () => {
    let items: Item[] = [];
    items = applyCLI(items, { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "在想" } } });
    items = applyCLI(items, { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: " " } } });
    items = applyCLI(items, { type: "result", is_error: true, subtype: "error_during_execution" });
    console.log(JSON.stringify(items.map(i => ({ kind: i.kind, text: (i as any).text, streaming: (i as any).streaming }))));
  });
});
