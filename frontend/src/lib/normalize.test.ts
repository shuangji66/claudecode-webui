import { describe, expect, it, beforeEach } from "vitest";
import {
  applyCLI,
  attachTurnUsage,
  turnsFromTranscript,
  appendUser,
  __resetIds,
  imagesOfContent,
  isLocalCommandEcho,
  subagentFromResult,
  prependSystem,
  stripAnsi,
  subagentFrame,
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

  // 上游中继（Anthropic 兼容代理）会把同一段内容重放多份：实测一次 /doctor 回复里
  // 一个 message 的 thinking 与 text 各被复制了三份，界面与导出就出现「同一段回答三遍」。
  // 同一条消息内「紧邻且逐字相同」的同类块只保留一份。
  it("同一消息里被重放的 thinking/text 块只渲染一次", () => {
    const items = applyCLI([], {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "我先跑只读检查" },
          { type: "thinking", thinking: "我先跑只读检查" },
          { type: "thinking", thinking: "我先跑只读检查" },
          { type: "text", text: "I'll run the doctor checks." },
          { type: "text", text: "I'll run the doctor checks." },
          { type: "text", text: "I'll run the doctor checks." },
        ],
      },
    });
    expect(items.map((i) => i.kind)).toEqual(["thinking", "assistant"]);
    expect(items[1]).toMatchObject({ text: "I'll run the doctor checks." });
  });

  it("相邻但内容不同、或中间隔着工具的块仍然各自成段", () => {
    const items = applyCLI([], {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "先看文件" },
          { type: "text", text: "再跑测试" },
          { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
          { type: "text", text: "再跑测试" },
        ],
      },
    });
    expect(items.map((i) => i.kind)).toEqual(["assistant", "assistant", "tool", "assistant"]);
  });

  // 「本轮花了多少」挂在回答那一行最顺手：result 来时把用量回填到该回合
  // **最后一条**已完成的 assistant 上，中间过渡正文不挂，免得同一个回合到处是耗时。
  it("result 把本轮用量回填到最后一条回答上", () => {
    let items = applyCLI([], {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "先看代码" },
          { type: "tool_use", id: "tu1", name: "Read", input: {} },
          { type: "text", text: "结论如下" },
        ],
      },
    });
    items = applyCLI(items, {
      type: "result",
      subtype: "success",
      duration_ms: 5000,
      duration_api_ms: 4900,
      usage: { input_tokens: 10, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    const answers = items.filter((i) => i.kind === "assistant");
    expect(answers[0]).toMatchObject({ text: "先看代码" });
    expect((answers[0] as { turn?: unknown }).turn).toBeUndefined();
    expect((answers[1] as { turn?: unknown }).turn).toMatchObject({
      durationMs: 5000,
      usage: { outputTokens: 900, apiMs: 4900 },
    });
    // result 条自身仍保留 duration_ms：转录回放与底部统计都靠它。
    expect(items[items.length - 1]).toMatchObject({ kind: "result", durationMs: 5000 });
  });

  // 纯工具回合没有可挂的正文时，不能一路往前扫到**上一回合**的答案上：
  // 否则第一个答案会显示成第二次提问的耗时。
  it("纯工具回合不会改写上一回合的耗时", () => {
    let items = applyCLI([], {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "第一回合的答案" }] },
    });
    items = applyCLI(items, { type: "result", subtype: "success", duration_ms: 1000 });
    items = applyCLI(items, { type: "user", message: { role: "user", content: "再跑个工具" } });
    items = applyCLI(items, {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "tu9", name: "Bash", input: {} }] },
    });
    items = applyCLI(items, { type: "result", subtype: "success", duration_ms: 9000 });

    const answers = items.filter((i) => i.kind === "assistant");
    expect(answers).toHaveLength(1);
    expect((answers[0] as { turn?: unknown }).turn).toMatchObject({ durationMs: 1000 });
    expect(items[items.length - 1]).toMatchObject({ kind: "result", durationMs: 9000 });
  });

  it("纯工具回合没有回答可挂时不影响 result", () => {
    let items = applyCLI([], {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: {} }] },
    });
    items = applyCLI(items, { type: "result", subtype: "success", duration_ms: 800 });
    expect(items.map((i) => i.kind)).toEqual(["tool", "result"]);
    expect(items[1]).toMatchObject({ kind: "result", durationMs: 800 });
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
  it("把 result 的窗口 / 耗时 / 输出挂到 Item 上，供回放时显示", () => {
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
    // result.usage 是整轮累计，不是任何一次请求的上下文：这里只能挂整轮这一层成立的数。
    expect(last.usage?.contextTokens).toBe(0);
    expect(last.usage?.outputTokens).toBe(7);
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

describe("子代理任务事件", () => {
  beforeEach(() => __resetIds());

  const toolUse = {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_01",
          name: "Agent",
          input: { description: "probe child", prompt: "say hi", subagent_type: "general-purpose" },
        },
      ],
    },
  };

  it("task_started / task_updated / task_notification 折进 Agent 卡片", () => {
    let items = applyCLI([], toolUse);
    items = applyCLI(items, {
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      tool_use_id: "toolu_01",
      description: "probe child",
      subagent_type: "general-purpose",
      spawn_depth: 1,
      is_backgrounded: false,
    });
    expect((items[0] as Extract<Item, { kind: "tool" }>).subagent).toMatchObject({
      taskId: "task-1",
      status: "running",
      type: "general-purpose",
      spawnDepth: 1,
      background: false,
    });

    items = applyCLI(items, { type: "system", subtype: "task_updated", task_id: "task-1", patch: { status: "completed" } });
    expect((items[0] as Extract<Item, { kind: "tool" }>).subagent?.status).toBe("completed");

    items = applyCLI(items, {
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      tool_use_id: "toolu_01",
      status: "completed",
      summary: "child says hello",
      usage: { total_tokens: 19, tool_uses: 3, duration_ms: 81 },
    });
    const sub = (items[0] as Extract<Item, { kind: "tool" }>).subagent;
    expect(sub).toMatchObject({
      status: "completed",
      summary: "child says hello",
      usage: { totalTokens: 19, toolUses: 3, durationMs: 81 },
    });
    // 任务事件不能额外生成消息项。
    expect(items).toHaveLength(1);
  });

  it("任务事件先到：先造占位卡，真实入参到达时合并", () => {
    let items = applyCLI([], {
      type: "system",
      subtype: "task_started",
      task_id: "task-2",
      tool_use_id: "toolu_02",
      description: "bg child",
      subagent_type: "Explore",
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", toolUseId: "toolu_02", name: "Agent" });

    items = applyCLI(items, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_02",
            name: "Agent",
            input: { description: "bg child", prompt: "p", subagent_type: "Explore", run_in_background: true },
          },
        ],
      },
    });
    expect(items).toHaveLength(1);
    expect((items[0] as Extract<Item, { kind: "tool" }>).input).toMatchObject({ run_in_background: true });
  });

  it("回放时从 tool_result 里补 agentId 与用量", () => {
    let items = applyCLI([], toolUse);
    const text = [
      "report follows:",
      "  child says hello",
      "agentId: abc123 (use SendMessage with to: 'abc123')",
      "<usage>subagent_tokens: 15",
      "tool_uses: 2",
      "duration_ms: 83</usage>",
    ].join("\n");
    items = applyCLI(items, {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: text }] },
    });
    expect((items[0] as Extract<Item, { kind: "tool" }>).subagent).toMatchObject({
      agentId: "abc123",
      status: "completed",
      usage: { totalTokens: 15, toolUses: 2, durationMs: 83 },
    });
  });

  it("subagentFromResult 对普通工具输出返回 undefined", () => {
    expect(subagentFromResult("just output", false)).toBeUndefined();
  });
});

describe("子代理帧分流", () => {
  it("parent_tool_use_id 非空才算子代理帧，agent_id 优先作为桶键", () => {
    expect(subagentFrame({ type: "assistant", parent_tool_use_id: null })).toBeUndefined();
    expect(subagentFrame({ type: "assistant" })).toBeUndefined();
    expect(subagentFrame({ type: "assistant", parent_tool_use_id: "toolu_01", agent_id: "task-1" })).toEqual({
      agentId: "task-1",
      toolUseId: "toolu_01",
    });
    // 没有 agent_id 时用 tool_use_id 兜底，至少能分到一个桶里。
    expect(subagentFrame({ type: "user", parent_tool_use_id: "toolu_02" })).toEqual({
      agentId: "toolu_02",
      toolUseId: "toolu_02",
    });
  });
});

describe("tool_progress", () => {
  beforeEach(() => __resetIds());

  it("只更新卡片的已跑秒数，不产生新消息", () => {
    let items = applyCLI([], {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "sleep 60" } }] },
    });
    items = applyCLI(items, { type: "tool_progress", tool_use_id: "tu1", tool_name: "Bash", elapsed_time_seconds: 12 });
    expect(items).toHaveLength(1);
    expect((items[0] as Extract<Item, { kind: "tool" }>).progress).toBe(12);
  });

  it("对不上的 tool_use_id 直接忽略", () => {
    const items = applyCLI([], { type: "tool_progress", tool_use_id: "nope", elapsed_time_seconds: 3 });
    expect(items).toEqual([]);
  });
});

describe("回显去重不吞相邻消息", () => {
  it("上一条是没有回复的用户消息时，带附件的下一条仍要保留", () => {
    // 上一轮被中断（没有 assistant 行），最后一条仍是 user。
    let items: Item[] = appendUser([], "上一句");
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
    // 回显与第 2 条重复 → 丢弃；第 1 条不能被牵连，也不能多出第 3 条。
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ text: "上一句" });
    expect(items[1]).toMatchObject({ text: "看看这张图\n附件：a.png" });
  });

  it("提示词不同的附件消息不会被当成上一条的回显", () => {
    let items: Item[] = appendUser([], "旧的一句\n附件：old.png");
    items = applyCLI(items, {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "全新的一句" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
        ],
      },
    });
    expect(items).toHaveLength(2);
    const second = items[1];
    expect(second.kind === "user" ? second.text : "").toContain("全新的一句");
  });
});

describe("多 tool_result 共用一条消息", () => {
  it("消息级 tool_use_result 只挂到唯一的那个结果上", () => {
    let items: Item[] = [];
    items = applyCLI(items, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu1", name: "Edit", input: { file_path: "/a.go", old_string: "a", new_string: "b" } },
          { type: "tool_use", id: "tu2", name: "Edit", input: { file_path: "/b.go", old_string: "c", new_string: "d" } },
        ],
      },
    });
    items = applyCLI(items, {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu1", content: "ok" },
          { type: "tool_result", tool_use_id: "tu2", content: "ok" },
        ],
      },
      tool_use_result: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] },
    });
    const tools = items.filter((i): i is Extract<Item, { kind: "tool" }> => i.kind === "tool");
    expect(tools).toHaveLength(2);
    // 两个结果同属一条消息时，结构化补丁不该被复制到两张卡片上。
    expect(tools[0].structured).toBeUndefined();
    expect(tools[1].structured).toBeUndefined();
  });
});

describe("流式气泡不在末尾时也要被替换", () => {
  it("增量与完整消息之间插入 system 行，正文不会显示两遍", () => {
    let items: Item[] = [];
    // 逐字增量
    items = applyCLI(items, {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } },
    });
    // 中间插一条 system 行（hook 输出 / compact 提示）
    items = applyCLI(items, { type: "system", subtype: "hook", content: "hook output" });
    // 完整消息到达
    items = applyCLI(items, {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "你好，世界" }] },
    });

    const assistants = items.filter((i) => i.kind === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ text: "你好，世界", streaming: false });
    // 半截气泡不能残留
    expect(items.some((i) => i.kind === "assistant" && i.streaming)).toBe(false);
  });
});

describe("转录回放的回合用量", () => {
  // 转录里没有 result 行（claude 只把 result 写 stdout），重开对话时靠
  // assistant / api-request 行自己推：否则刷新后「本轮耗时 · 输出 tok」全丢。
  const lines = [
    { type: "user", timestamp: "2026-01-02T00:00:00.000Z", message: { role: "user", content: "第一问" } },
    { type: "api-request", timestamp: "2026-01-02T00:00:01.000Z" },
    {
      type: "assistant",
      timestamp: "2026-01-02T00:00:03.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "先看代码" },
          { type: "tool_use", id: "tu1", name: "Read", input: {} },
        ],
        usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
      },
    },
    {
      type: "user",
      timestamp: "2026-01-02T00:00:04.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
    },
    { type: "api-request", timestamp: "2026-01-02T00:00:05.000Z" },
    {
      type: "assistant",
      timestamp: "2026-01-02T00:00:09.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "答案是 42" }],
        usage: { input_tokens: 300, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
    { type: "user", timestamp: "2026-01-02T00:00:20.000Z", message: { role: "user", content: "第二问" } },
    { type: "api-request", timestamp: "2026-01-02T00:00:21.000Z" },
    {
      type: "assistant",
      timestamp: "2026-01-02T00:00:23.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "第二个答案" }],
        usage: { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
  ];

  it("按「提问 → 本轮最后一条回答」推导耗时与输出 token", () => {
    const turns = turnsFromTranscript(lines);
    expect(turns).toHaveLength(2);
    // 第一轮：提问 00:00 → 最后回答 00:00:09 = 9s；输出是最后那次请求的 900 tok。
    expect(turns[0].turn).toMatchObject({ durationMs: 9000, usage: { outputTokens: 900, apiMs: 4000 } });
    // 第二轮：00:00:20 → 00:00:23 = 3s。
    expect(turns[1].turn).toMatchObject({ durationMs: 3000, usage: { outputTokens: 40, apiMs: 2000 } });
    expect(turns[1].ts).toBe(Date.parse("2026-01-02T00:00:23.000Z"));
  });

  it("工具回包与本地命令回显不算新的一轮", () => {
    const turns = turnsFromTranscript([
      ...lines.slice(0, 5),
      {
        type: "user",
        timestamp: "2026-01-02T00:00:06.000Z",
        message: { role: "user", content: "<local-command-stdout>Set model</local-command-stdout>" },
      },
      ...lines.slice(5, 6),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].turn.durationMs).toBe(9000);
  });

  // 没有 usage 的 assistant 行同样是「这次请求结束了」：不清掉 api-request，
  // 下一个回答的 API 耗时会把两次请求的时间都算进去。
  it("assistant 行没有 usage 时也结束这次请求", () => {
    const turns = turnsFromTranscript([
      { type: "user", timestamp: "2026-01-02T00:00:00.000Z", message: { role: "user", content: "问" } },
      { type: "api-request", timestamp: "2026-01-02T00:00:01.000Z" },
      {
        type: "assistant",
        timestamp: "2026-01-02T00:00:02.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "半条" }] },
      },
      { type: "api-request", timestamp: "2026-01-02T00:00:05.000Z" },
      {
        type: "assistant",
        timestamp: "2026-01-02T00:00:07.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "答案" }],
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      },
    ]);
    expect(turns).toHaveLength(1);
    // 07 - 05，而不是 07 - 01。
    expect(turns[0].turn.usage?.apiMs).toBe(2000);
  });

  it("转录被截断（首轮没有提问时间）时整轮跳过，不编耗时", () => {
    const turns = turnsFromTranscript(lines.slice(1));
    // 第一条提问被截掉 → 第一个回答没有回合起点，只能推出第二轮。
    expect(turns).toHaveLength(1);
    expect(turns[0].turn.durationMs).toBe(3000);
  });

  it("贴回消息列表时只贴在每轮最后一条回答上", () => {
    let items: Item[] = [];
    for (const line of lines) {
      const rec = line as { timestamp?: string };
      items = applyCLI(items, line, Date.parse(rec.timestamp ?? ""));
    }
    const stamped = attachTurnUsage(items, turnsFromTranscript(lines));
    const answers = stamped.filter((i): i is Extract<Item, { kind: "assistant" }> => i.kind === "assistant");
    // 「先看代码」是本轮的过渡正文，不该带用量。
    expect(answers[0].turn).toBeUndefined();
    expect(answers[1].turn).toMatchObject({ durationMs: 9000 });
    expect(answers[2].turn).toMatchObject({ durationMs: 3000 });
  });
});
