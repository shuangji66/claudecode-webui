import { describe, expect, it, beforeEach } from "vitest";
import { applyCLI, appendUser, __resetIds, stripAnsi, textOfContent } from "./normalize";
import type { Item } from "./model";

function assistantText(text: string) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function delta(text: string) {
  return { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } };
}

describe("normalize", () => {
  beforeEach(() => __resetIds());

  it("流式增量累积到一个 streaming 气泡里", () => {
    let items: Item[] = [];
    items = applyCLI(items, delta("中继"));
    items = applyCLI(items, delta("测试"));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assistant", text: "中继测试", streaming: true });
  });

  // 这是最容易踩的坑：--include-partial-messages 会先给逐字增量，再给一次完整消息。
  // 若两套都追加，UI 上每句话出现两遍。
  it("完整 assistant 消息替换流式气泡而不是追加", () => {
    let items: Item[] = [];
    items = applyCLI(items, delta("中继"));
    items = applyCLI(items, delta("测试"));
    items = applyCLI(items, assistantText("中继测试通过。"));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assistant", text: "中继测试通过。", streaming: false });
  });

  it("没有流式前置时，完整消息直接入列", () => {
    const items = applyCLI([], assistantText("你好"));
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("assistant");
  });

  it("tool_use 生成工具卡片，tool_result 按 id 回填", () => {
    let items: Item[] = [];
    items = applyCLI(items, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "echo hi" } }],
      },
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", toolUseId: "tu1", name: "Bash" });
    expect((items[0] as Extract<Item, { kind: "tool" }>).result).toBeUndefined();

    items = applyCLI(items, {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu1", content: "hi", is_error: false }],
      },
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", result: "hi", isError: false });
  });

  it("tool_result 携带结构化补丁时保留 structured", () => {
    let items: Item[] = applyCLI([], {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "e1", name: "Edit", input: {} }] },
    });
    const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }];
    items = applyCLI(items, {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }] },
      tool_use_result: { structuredPatch: patch },
    });
    expect((items[0] as Extract<Item, { kind: "tool" }>).structured).toEqual({ structuredPatch: patch });
  });

  // 同一 tool_use_id 重复到达（重连回放 / CLI 重试）不应生成两张卡片，
  // 否则 tool_result 会被回填到两张卡上，UI 出现「两张都完成」的假象。
  it("重复的 tool_use_id 只生成一张卡片", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "dup", name: "Bash", input: { command: "ls" } }] },
    };
    let items: Item[] = applyCLI([], msg);
    items = applyCLI(items, msg);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", toolUseId: "dup" });
  });

  it("thinking 块独立成项", () => {
    const items = applyCLI([], {
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "先想想" }] },
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "thinking", text: "先想想" });
  });

  it("result 记录成本、耗时与被拒工具数", () => {
    const items = applyCLI([], {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.0123,
      duration_ms: 1500,
      permission_denials: [{ tool_name: "Bash" }],
    });
    expect(items[0]).toMatchObject({ kind: "result", costUsd: 0.0123, durationMs: 1500 });
    expect((items[0] as Extract<Item, { kind: "result" }>).denials).toHaveLength(1);
  });

  it("system/init 不进消息流，hooks 输出进且清洗 ANSI", () => {
    let items = applyCLI([], { type: "system", subtype: "init", model: "x" });
    expect(items).toHaveLength(0);

    items = applyCLI(items, { type: "system", content: "\u001b[31mhook 输出\u001b[0m" });
    expect(items).toHaveLength(1);
    expect((items[0] as Extract<Item, { kind: "system" }>).text).toBe("hook 输出");
  });

  it("本地已插入的用户消息不会被回显重复", () => {
    let items = appendUser([], "你好");
    items = applyCLI(items, { type: "user", message: { role: "user", content: "你好" } });
    expect(items).toHaveLength(1);
  });

  it("未知消息类型被忽略而不是抛错", () => {
    const items = applyCLI([], { type: "some_future_event", payload: 1 });
    expect(items).toEqual([]);
  });

  it("纯工具回合时把悬着的流式气泡收尾", () => {
    let items: Item[] = applyCLI([], delta(""));
    expect(items).toHaveLength(1);
    items = applyCLI(items, {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] },
    });
    const assistant = items.find((i) => i.kind === "assistant");
    expect(assistant).toMatchObject({ streaming: false });
  });
});

describe("textOfContent", () => {
  it("支持字符串、内容块数组与空值", () => {
    expect(textOfContent("hi")).toBe("hi");
    expect(textOfContent([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(textOfContent(undefined)).toBe("");
  });
});

describe("stripAnsi", () => {
  it("去掉颜色转义", () => {
    expect(stripAnsi("\u001b[32mok\u001b[0m")).toBe("ok");
  });
});

describe("附件回显去重", () => {
  it("文件/图片用户消息回显不重复追加本地气泡", () => {
    let items: Item[] = [];
    items = appendUser(items, "看看这张图\n附件：a.png");
    items = applyCLI(items, {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "看看这张图" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
        ],
      },
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "user", text: "看看这张图\n附件：a.png" });
  });

  it("仅文本文件、无提示词时也不重复", () => {
    let items: Item[] = appendUser([], "附件：a.txt");
    items = applyCLI(items, {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: '<file name="a.txt">\nhi\n</file>' }],
      },
    });
    expect(items).toHaveLength(1);
  });

  it("文本文件回显（多个 text block）同样不重复", () => {
    let items: Item[] = appendUser([], "读一下\n附件：a.txt");
    items = applyCLI(items, {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "读一下" },
          { type: "text", text: '<file name="a.txt">\nhi\n</file>' },
        ],
      },
    });
    expect(items).toHaveLength(1);
  });
});
