import { describe, expect, it, beforeEach } from "vitest";
import {
  applyCLI,
  appendUser,
  __resetIds,
  imagesOfContent,
  isLocalCommandEcho,
  prependSystem,
  stripAnsi,
  textOfContent,
} from "./normalize";
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

  // 纯工具回合（正文还没落地就先发了 tool_use）不能留一个永远转圈的气泡。
  // 现在收尾时按内容块顺序重建：已收到的流式文字补回原位、streaming 置 false。
  it("纯工具回合不会留下悬着的流式气泡", () => {
    let items: Item[] = applyCLI([], delta("先读文件"));
    items = applyCLI(items, {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] },
    });
    expect(items.filter((i) => i.kind === "assistant" && i.streaming)).toHaveLength(0);
    expect(items.map((i) => i.kind)).toEqual(["assistant", "tool"]);
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

describe("applyCLI timestamp", () => {
  it("回放转录时可保留原始时间", () => {
    const items = applyCLI([], { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }, 123456);
    expect(items[0]?.ts).toBe(123456);
  });
});

// CLI 把本地斜杠命令（/model、/clear）的输入与输出也当成 user 消息写进会话流。
// 界面里它们会变成用户气泡，看起来像用户自己说了句 "Set model to ..."。
describe("本地命令回显", () => {
  beforeEach(() => __resetIds());

  const userText = (text: string) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });

  it("整条丢弃 /model 的 stdout", () => {
    const items = applyCLI([], userText("<local-command-stdout>Set model to `cn:glm-5.3-flash`</local-command-stdout>"));
    expect(items).toHaveLength(0);
  });

  it("整条丢弃斜杠命令包装（command-name / message / args）", () => {
    const wrapped = "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>";
    expect(isLocalCommandEcho(wrapped)).toBe(true);
    expect(applyCLI([], userText(wrapped))).toHaveLength(0);
  });

  it("字符串形态的 content 同样过滤", () => {
    const items = applyCLI([], { type: "user", message: { role: "user", content: "<local-command-stderr>boom</local-command-stderr>" } });
    expect(items).toHaveLength(0);
  });

  it("用户正文里提到标签时不能误删", () => {
    const text = "帮我看下 <local-command-stdout> 这个标签是谁写的";
    expect(isLocalCommandEcho(text)).toBe(false);
    const items = applyCLI([], userText(text));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "user", text });
  });

  it("标签后面还有自己的话时保留", () => {
    const text = "<command-name>/model</command-name>\n这条是我想问的";
    expect(isLocalCommandEcho(text)).toBe(false);
    expect(applyCLI([], userText(text))).toHaveLength(1);
  });

  it("system 通道的命令回显也丢弃", () => {
    const items = applyCLI([], { type: "system", subtype: "local_command", content: "<local-command-stdout>Set model to `x`</local-command-stdout>" });
    expect(items).toHaveLength(0);
  });

  it("普通文本不命中", () => {
    for (const text of ["", "hello", "<div>hi</div>", "Set model to `x`"]) {
      expect(isLocalCommandEcho(text)).toBe(false);
    }
  });
});

describe("result 的用量", () => {
  it("把 result 的 usage / modelUsage 挂到 Item 上，供回放时显示", () => {
    const items = applyCLI([], {
      type: "result",
      subtype: "success",
      duration_ms: 341,
      duration_api_ms: 22,
      usage: { input_tokens: 12, cache_creation_input_tokens: 300, cache_read_input_tokens: 9000, output_tokens: 7 },
      modelUsage: { "claude-sonnet-4-5": { contextWindow: 200000 } },
    });
    const last = items[items.length - 1];
    expect(last.kind).toBe("result");
    if (last.kind !== "result") return;
    expect(last.usage?.contextTokens).toBe(9312);
    expect(last.usage?.contextWindow).toBe(200000);
    expect(last.usage?.apiMs).toBe(22);
  });
});

describe("内容块保真", () => {
  beforeEach(() => __resetIds());

  it("同一条消息里的多个 text 块都保留", () => {
    const items = applyCLI([], {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "先看文件" },
          { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "a.ts" } },
          { type: "text", text: "读完了，结论如下" },
        ],
      },
    });
    expect(items.map((i) => i.kind)).toEqual(["assistant", "tool", "assistant"]);
    expect(items[2]).toMatchObject({ text: "读完了，结论如下" });
  });

  it("thinking 按内容块顺序排在正文之前", () => {
    const items = applyCLI([], {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先想想" },
          { type: "text", text: "答案" },
        ],
      },
    });
    expect(items.map((i) => i.kind)).toEqual(["thinking", "assistant"]);
  });

  it("流式气泡收尾时仍按块顺序重建", () => {
    let items: Item[] = [];
    items = applyCLI(items, delta("答"));
    items = applyCLI(items, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "想" },
          { type: "text", text: "答案" },
        ],
      },
    });
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.kind)).toEqual(["thinking", "assistant"]);
    expect(items[1]).toMatchObject({ text: "答案", streaming: false });
  });

  it("只有流式增量、没有正文块时补回原位置", () => {
    let items: Item[] = [];
    items = applyCLI(items, delta("半句"));
    items = applyCLI(items, {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    });
    expect(items.map((i) => i.kind)).toEqual(["assistant", "tool"]);
    expect(items[0]).toMatchObject({ text: "半句", streaming: false });
  });
});

describe("result 失败原因", () => {
  beforeEach(() => __resetIds());

  it("出错回合带出 CLI 给的 result 文本", () => {
    const items = applyCLI([], {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "API Error: 400 bad request",
      duration_ms: 1200,
    });
    expect(items[0]).toMatchObject({
      kind: "result",
      isError: true,
      text: "API Error: 400 bad request",
      subtype: "error_during_execution",
    });
  });

  it("成功回合不重复展示 result 文本", () => {
    const items = applyCLI([], { type: "result", subtype: "success", is_error: false, result: "答案" });
    expect((items[0] as Extract<Item, { kind: "result" }>).text).toBeUndefined();
  });
});

describe("compact_boundary", () => {
  beforeEach(() => __resetIds());

  it("上下文压缩留下一条系统提示", () => {
    const items = applyCLI([], {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 200000 },
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "system", subtype: "compact_boundary" });
    const text = (items[0] as Extract<Item, { kind: "system" }>).text;
    expect(text).toContain("上下文已自动压缩");
    expect(text).toContain("195.3K");
  });
});

describe("tool_result 里的图片", () => {
  it("base64 不再当正文，改占位符", () => {
    const content = [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(4000) } }];
    const text = textOfContent(content);
    expect(text).toBe("[图片 image/png，约 3 KB]");
    expect(text).not.toContain("AAAA");
  });

  it("图片挂到工具卡片上", () => {
    let items: Item[] = applyCLI([], {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Read", input: {} }] },
    });
    items = applyCLI(items, {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu1",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }],
          },
        ],
      },
    });
    const tool = items[0] as Extract<Item, { kind: "tool" }>;
    expect(tool.images).toHaveLength(1);
    expect(tool.images?.[0].mediaType).toBe("image/png");
    expect(tool.result).toContain("[图片 image/png");
  });

  it("非图片媒体类型不渲染", () => {
    expect(
      imagesOfContent([{ type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "AA" } }]),
    ).toHaveLength(0);
  });
});

describe("附件回放", () => {
  beforeEach(() => __resetIds());

  it("文本文件附件不再把全文当用户消息", () => {
    const items = applyCLI([], {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "读一下" },
          { type: "text", text: '<file name="a.txt">\n机密内容\n</file>' },
        ],
      },
    });
    expect(items).toHaveLength(1);
    expect((items[0] as Extract<Item, { kind: "user" }>).text).toBe("读一下\n附件：a.txt");
  });

  it("图片附件只报数量", () => {
    const items = applyCLI([], {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } },
        ],
      },
    });
    expect((items[0] as Extract<Item, { kind: "user" }>).text).toBe("看图\n附件：1 个图片/PDF");
  });
});

describe("stripAnsi 扩展", () => {
  it("清掉光标/清屏/OSC 等非颜色转义", () => {
    expect(stripAnsi("\u001b[2K\u001b[1G处理中")).toBe("处理中");
    expect(stripAnsi("\u001b]0;title\u0007ok")).toBe("ok");
  });

  it("回车覆盖只保留最后一次", () => {
    expect(stripAnsi("进度 10%\r进度 100%\r完成")).toBe("完成");
    expect(stripAnsi("a\r\nb")).toBe("a\nb");
  });
});

describe("prependSystem", () => {
  it("在开头插入系统提示", () => {
    const items = prependSystem([{ id: "x", seq: 0, ts: 1, kind: "user", text: "hi" }], "更早的消息已被省略");
    expect(items[0]).toMatchObject({ kind: "system", text: "更早的消息已被省略" });
    expect(items[1]).toMatchObject({ kind: "user", text: "hi" });
  });
});
