import { describe, expect, it, beforeEach } from "vitest";
import {
  applyCLI,
  attachTurnUsage,
  turnsFromTranscript,
  appendUser,
  appendPromptEcho,
  __resetIds,
  commandsChanged,
  imagesOfContent,
  isInterruptMarker,
  mergeReplayed,
  isLocalCommandEcho,
  isTaskNotification,
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

  // 上游在工具调用之间常发一个纯空白的 thinking 块（实测一次会话里 57 条 `" "`）：
  // 渲染出来是一行「思考过程 · 1 字」，点开只有个空格。
  it("纯空白的 thinking 块直接丢掉", () => {
    const items = applyCLI([], {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: " " },
          { type: "thinking", thinking: "\n  \t" },
          { type: "thinking", thinking: "" },
          { type: "text", text: "真正的回答" },
        ],
      },
    });
    expect(items.map((i) => i.kind)).toEqual(["assistant"]);
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

  // tok/s 用「最近一次请求」的口径（genMs/genTokens）：result 的整轮累计里没有这一对，
  // 必须从流式阶段那份快照借过来，否则实时回合的回答下面永远少一段「· N tok/s」。
  it("result 的用量会带上流式阶段量到的生成速度", () => {
    let items = applyCLI([], {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "答案" }] },
    });
    items = applyCLI(
      items,
      {
        type: "result",
        subtype: "success",
        duration_ms: 4000,
        usage: { input_tokens: 10, output_tokens: 900 },
      },
      Date.now(),
      { contextTokens: 1000, genMs: 2000, genTokens: 400 },
    );
    const answer = items.find((i) => i.kind === "assistant") as { turn?: { usage?: Record<string, number> } };
    expect(answer.turn?.usage).toMatchObject({ genMs: 2000, genTokens: 400, outputTokens: 900 });
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

  it("只发了一张图（没有正文）时回显也不重复", () => {
    const images = [{ name: "shot.png", mediaType: "image/png", data: "AA" }];
    let items = appendUser([], "", images);
    items = applyCLI(items, {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } }],
      },
    });
    expect(items).toHaveLength(1);
    expect((items[0] as Extract<Item, { kind: "user" }>).images?.[0].name).toBe("shot.png");
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

  it("图片附件进 item.images，正文里不再写一行数量", () => {
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
    const user = items[0] as Extract<Item, { kind: "user" }>;
    expect(user.text).toBe("看图");
    expect(user.images).toEqual([{ name: "image-1.png", mediaType: "image/png", data: "AA" }]);
  });

  it("只发图片（没有正文）时气泡里只有图，没有占位文字", () => {
    const items = applyCLI([], {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BB" } }],
      },
    });
    const user = items[0] as Extract<Item, { kind: "user" }>;
    expect(user.text).toBe("");
    expect(user.images).toHaveLength(1);
    expect(user.images?.[0].mediaType).toBe("image/jpeg");
  });

  it("PDF 附件仍然写一行占位（只有图片进气泡）", () => {
    const items = applyCLI([], {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "看这两份" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } },
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: "CC" } },
        ],
      },
    });
    const user = items[0] as Extract<Item, { kind: "user" }>;
    expect(user.text).toBe("看这两份\n附件：1 个图片/PDF");
    expect(user.images).toHaveLength(1);
  });

  it("url 来源的图片不内联（不让界面去第三方拉图），但仍写一行占位", () => {
    const items = applyCLI([], {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
        ],
      },
    });
    const user = items[0] as Extract<Item, { kind: "user" }>;
    expect(user.images).toBeUndefined();
    // 没有可画的字节时不能把整条消息吞掉。
    expect(user.text).toBe("看图\n附件：1 个图片/PDF");
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

  it("按「提问 → 本轮最后一条回答」推导耗时与本轮消耗", () => {
    const turns = turnsFromTranscript(lines);
    expect(turns).toHaveLength(2);
    // 第一轮有两次请求（一次工具调用 + 一次回答）：耗时/输入/输出都取这一轮的和，
    // 上下文仍是最新那次请求的（100 + 900 + 0 = 1000… 见下一条断言）。
    expect(turns[0].turn).toMatchObject({
      durationMs: 9000,
      usage: { outputTokens: 1100, turnInputTokens: 1300, apiMs: 6000 },
    });
    // 第二轮只有一次请求：00:00:20 → 00:00:23 = 3s。
    expect(turns[1].turn).toMatchObject({ durationMs: 3000, usage: { outputTokens: 40, turnInputTokens: 10, apiMs: 2000 } });
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

  // 只发了图片/PDF 的提问没有 text block，但它照样是「一轮的开始」：
  // 不认的话这一轮的用量会被并进上一轮（lib/usage.ts 的同名判定早已按这个口径）。
  it("只发图片的提问也算新的一轮", () => {
    const turns = turnsFromTranscript([
      { type: "user", timestamp: "2026-01-02T00:00:00.000Z", message: { role: "user", content: "第一问" } },
      { type: "api-request", timestamp: "2026-01-02T00:00:01.000Z" },
      {
        type: "assistant",
        timestamp: "2026-01-02T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "第一答" }],
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      },
      {
        type: "user",
        timestamp: "2026-01-02T00:00:10.000Z",
        message: {
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }],
        },
      },
      { type: "api-request", timestamp: "2026-01-02T00:00:11.000Z" },
      {
        type: "assistant",
        timestamp: "2026-01-02T00:00:13.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "第二答" }],
          usage: { input_tokens: 7, output_tokens: 3 },
        },
      },
    ]);
    expect(turns).toHaveLength(2);
    // 第二轮只算它自己的用量（1s），不把第一轮的和算进来。
    expect(turns[1].turn).toMatchObject({ durationMs: 3000, usage: { turnInputTokens: 7, outputTokens: 3 } });
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

describe("用户中断", () => {
  const marker = (text = "[Request interrupted by user]") => ({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });
  const interruptedResult = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
  };

  it("识别 CLI 的三种中断标记形态", () => {
    expect(isInterruptMarker("[Request interrupted by user]")).toBe(true);
    expect(isInterruptMarker("[Request interrupted by user for tool use]")).toBe(true);
    expect(isInterruptMarker("[Request interrupted: the session ended before this agent finished.]")).toBe(true);
    expect(isInterruptMarker("[Agent call interrupted: the process stopped]")).toBe(true);
    // 用户正文里提到这句话不是标记。
    expect(isInterruptMarker("为什么会出现 [Request interrupted by user]？")).toBe(false);
    expect(isInterruptMarker("普通消息")).toBe(false);
  });

  // CLI 把中断标记写成一条 user 消息：渲染成气泡等于让用户以为自己发过这句。
  it("中断标记不生成用户气泡，而是一条中性的「已中断」", () => {
    const items = applyCLI(applyCLI([], marker()), assistantText("半截回答"));
    expect(items.filter((i) => i.kind === "user")).toHaveLength(0);
    expect(items[0]).toMatchObject({
      kind: "interrupt",
      marker: "[Request interrupted by user]",
      reason: "user",
    });
  });

  it("连续中断只留一条标记", () => {
    let items = applyCLI([], marker());
    items = applyCLI(items, marker("[Request interrupted by user for tool use]"));
    expect(items.filter((i) => i.kind === "interrupt")).toHaveLength(1);
  });

  it("标记按来源分类：用户 / 会话被结束 / 子代理", () => {
    const cases: Array<[string, string]> = [
      ["[Request interrupted by user]", "user"],
      ["[Request interrupted by user for tool use]", "user"],
      ["[Request interrupted: the session ended before this agent finished.]", "session"],
      ["[Agent call interrupted: the process stopped]", "agent"],
    ];
    for (const [text, reason] of cases) {
      const items = applyCLI([], marker(text));
      expect(items[0]).toMatchObject({ kind: "interrupt", reason });
    }
  });

  // 中断时上一轮的流式气泡通常没有完整 assistant 消息来收尾：光标不能永远在闪。
  it("中断的回合结束时收起流式光标", () => {
    let items = applyCLI([], delta("写到一半"));
    expect(items[0]).toMatchObject({ kind: "assistant", streaming: true });
    items = applyCLI(items, marker());
    items = applyCLI(items, interruptedResult);
    expect(items[0]).toMatchObject({ kind: "assistant", streaming: false });
  });

  // 中断时 CLI 的 result 是 is_error + error_during_execution，文本只有一段内部诊断。
  // 这不是失败：界面不该弹「本轮出错」，更不该把诊断糊到用户脸上。
  it("中断后的 result 不当作错误，也不显示诊断文本", () => {
    let items = applyCLI([], marker());
    items = applyCLI(items, interruptedResult);
    const result = items.find((i) => i.kind === "result");
    expect(result).toMatchObject({ kind: "result", isError: false, subtype: "interrupt" });
    expect(result?.kind === "result" && result.text).toBeUndefined();
  });

  // 真实形态：中断时 CLI **不写 result.result**，诊断只在 errors 数组里（2.1.327）。
  // 只查 result.result 会漏掉一整类——界面上照旧弹「本轮出错 + 诊断」。
  it("诊断只在 errors 里（没有 result 字段）也能认出中断", () => {
    const items = applyCLI([], {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
    });
    const result = items.find((i) => i.kind === "result");
    expect(result).toMatchObject({ kind: "result", isError: false, subtype: "interrupt" });
    expect(result?.kind === "result" && result.text).toBeUndefined();
  });

  // 判据②：本回合收到过中断标记，且 result 的原因就是标记本身。
  // 会话被结束 / 子代理被中断的标记不是「by user」开头，只认前缀会把它们当成失败。
  it("会话被结束 / 子代理中断的标记同样不算失败", () => {
    for (const text of [
      "[Request interrupted: the session ended before this agent finished.]",
      "[Agent call interrupted: the process stopped]",
    ]) {
      let items = applyCLI([], marker(text));
      items = applyCLI(items, {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: text,
      });
      const result = items.find((i) => i.kind === "result");
      expect(result).toMatchObject({ kind: "result", isError: false, subtype: "interrupt" });
    }
  });

  it("诊断之外还有真实错误时，仍然算失败并显示原因", () => {
    const items = applyCLI([], {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: [
        "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
        "API Error: 500 internal server error",
      ],
    });
    const result = items.find((i) => i.kind === "result");
    expect(result).toMatchObject({ kind: "result", isError: true, subtype: "error_during_execution" });
    expect(result?.kind === "result" && result.text).toContain("API Error: 500");
  });

  // 诊断里 result_type 不是 user（例如 assistant 收尾）说明不是中断，不能吞。
  it("诊断不是「user 收尾」时仍算失败", () => {
    const items = applyCLI([], {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["[ede_diagnostic] result_type=assistant last_content_type=none stop_reason=end_turn"],
    });
    expect(items[0]).toMatchObject({ kind: "result", isError: true, subtype: "error_during_execution" });
  });

  it("中断之后的真正报错照旧显示", () => {
    let items = applyCLI([], marker());
    items = applyCLI(items, { type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: 500" });
    expect(items[items.length - 1]).toMatchObject({ kind: "result", isError: true });
  });
});

describe("上游 API 错误", () => {
  // CLI 把「API Error: …」包装成一条 assistant 消息（isApiErrorMessage），
  // 随后 result 里再给一遍同一段原因。两处都渲染等于同一句话出现两遍。
  const apiErrorAnswer = (text: string, field = "isApiErrorMessage") => ({
    type: "assistant",
    [field]: true,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

  it("API 错误消息带 apiError 标记（camel / snake 两种写法都认）", () => {
    for (const field of ["isApiErrorMessage", "is_api_error_message"]) {
      const items = applyCLI([], apiErrorAnswer("API Error: 500 internal server error", field));
      expect(items[0]).toMatchObject({ kind: "assistant", apiError: true });
    }
  });

  it("result 的原因已被上面那条错误消息展示过时不再重复", () => {
    let items = applyCLI([], apiErrorAnswer("API Error: 500 internal server error"));
    items = applyCLI(items, {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "API Error: 500 internal server error",
    });
    const result = items.find((i) => i.kind === "result");
    expect(result).toMatchObject({ kind: "result", isError: true });
    expect(result?.kind === "result" && result.text).toBeUndefined();
  });

  it("普通回答里恰好有同样的字时，result 的原因照旧显示", () => {
    let items = applyCLI([], assistantText("API Error: 500 internal server error"));
    items = applyCLI(items, {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "API Error: 500 internal server error",
    });
    const result = items.find((i) => i.kind === "result");
    expect(result?.kind === "result" && result.text).toBe("API Error: 500 internal server error");
  });

  it("只有 result 没有上面那条消息时，原因照旧显示", () => {
    const items = applyCLI([], {
      type: "result",
      subtype: "success",
      is_error: true,
      result: "API Error: 429 rate limit",
    });
    expect(items[0]).toMatchObject({ kind: "result", isError: true, text: "API Error: 429 rate limit" });
  });
});

describe("appendPromptEcho（别的设备发的提示词）", () => {
  // CLI 不回显 stdin 里的消息，而气泡是发送方本地乐观插入的：不补这一步，
  // 另一台设备上只会看到模型突然开始思考。
  it("补一条用户气泡，带上附件名", () => {
    const items = appendPromptEcho([], { text: "跑一遍测试", files: ["a.log"] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "user", text: "跑一遍测试\n附件：a.log" });
  });

  it("已有同一条（本机自己发的也收到广播）时不重复", () => {
    const local = appendUser([], "跑一遍测试");
    expect(appendPromptEcho(local, { text: "跑一遍测试" })).toBe(local);
  });

  it("只有图片时按图片成条", () => {
    const image = { name: "a.png", mediaType: "image/png", data: "AAAA" };
    const items = appendPromptEcho([], { text: "", images: [image] });
    expect(items[0]).toMatchObject({ kind: "user", text: "", images: [image] });
  });

  it("空载荷原样返回", () => {
    const items: Item[] = [];
    expect(appendPromptEcho(items, { text: "", files: [], images: [] })).toBe(items);
  });

  // 别的设备「立即插话」发来的那一句：标记必须跟着走，否则收到的一方会把它当成
  // 新的一轮，把发送方那一轮的思考劈成两半。
  it("插话带上 interjected 标记", () => {
    const items = appendPromptEcho([], { text: "顺便看一下日志", interjected: true });
    expect(items[0]).toMatchObject({ kind: "user", interjected: true });
  });

  it("普通消息不带这个标记", () => {
    const items = appendPromptEcho([], { text: "跑一遍测试" });
    expect(items[0].kind === "user" && items[0].interjected).toBeFalsy();
  });

  // 发送方自己也会收到自己的广播，靠「本机气泡命中」丢弃。但补进来的 echo 不能
  // 反过来参与这条去重：同一个设备连发两次「继续」，第二条广播会命中第一条补进来的
  // 气泡被吞掉，另一台设备上就少一条。
  it("别的设备连发两次同一句话：本机补两条", () => {
    let items: Item[] = [];
    items = appendPromptEcho(items, { text: "继续" });
    items = appendPromptEcho(items, { text: "继续" });
    expect(items.filter((i) => i.kind === "user")).toHaveLength(2);
    expect(items.filter((i) => i.kind === "user" && i.echoed)).toHaveLength(2);
  });

  it("本机发的那条仍然去重（发送方也会收到自己的广播）", () => {
    let items = appendUser([], "继续");
    items = appendPromptEcho(items, { text: "继续" });
    expect(items.filter((i) => i.kind === "user")).toHaveLength(1);
    expect(items.some((i) => i.kind === "user" && i.echoed)).toBe(false);
  });
});

describe("applyCLI 跳过 sidechain / meta 行", () => {
  // 转录回放是逐行喂进来的：CLI 会给同一句话补一条 isMeta 的伴随行
  // （turnCompanion，把附图写成 `[Image: source: …]`）。不挡的话它会变成一个
  // 用户气泡，轮次刻度也跟着多一格。
  function userRow(text: string, extra: Record<string, unknown> = {}) {
    return { type: "user", message: { role: "user", content: [{ type: "text", text }] }, ...extra };
  }

  it("isMeta 的伴随行不进消息流", () => {
    let items = applyCLI([], userRow("看这张图"));
    items = applyCLI(items, userRow("[Image: source: /tmp/a.png]", { isMeta: true, turnCompanion: true }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "user", text: "看这张图" });
  });

  it("isSidechain 的帧同样不进主消息流", () => {
    const items = applyCLI([], userRow("子代理说的话", { isSidechain: true }));
    expect(items).toHaveLength(0);
  });
});

// 转录回放**不能**做回显去重：那套去重是给实时流用的（本地已经乐观插过一条气泡），
// 转录里每条 user 行都是真的发过的。而且转录没有 result 行，`echoAlreadyShown` 按
// result 划的轮边界永远触发不到，于是「上一轮说过同样一句话」会被整段历史比对吞掉
// ——实测一份真实转录里 `提交修改` 发了 4 次，回放后只剩 1 条。
describe("转录回放不做回显去重", () => {
  const opts = { replay: true } as const;
  const userRow = (text: string) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
  const answer = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });

  it("重复发送的同一句话每次都要留下", () => {
    let items: Item[] = [];
    items = applyCLI(items, userRow("提交修改"), 0, undefined, opts);
    items = applyCLI(items, answer("好"), 1000, undefined, opts);
    items = applyCLI(items, userRow("提交修改"), 2000, undefined, opts);
    items = applyCLI(items, answer("再提交"), 3000, undefined, opts);
    items = applyCLI(items, userRow("提交修改"), 4000, undefined, opts);
    expect(items.filter((i) => i.kind === "user").map((i) => i.text)).toEqual(["提交修改", "提交修改", "提交修改"]);
  });

  it("带附件的重复消息也不被吞", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } };
    const withImage = { type: "user", message: { role: "user", content: [{ type: "text", text: "看看" }, image] } };
    let items: Item[] = [];
    items = applyCLI(items, withImage, 0, undefined, opts);
    items = applyCLI(items, answer("看到了"), 1000, undefined, opts);
    items = applyCLI(items, withImage, 2000, undefined, opts);
    expect(items.filter((i) => i.kind === "user")).toHaveLength(2);
  });

  it("实时路径（不带 replay）仍然去重：本地气泡 + CLI 回显只留一条", () => {
    let items = appendUser([], "跑一遍测试");
    items = applyCLI(items, userRow("跑一遍测试"));
    expect(items).toHaveLength(1);
  });
});

// 插话发生在**回合进行中**：本地气泡后面已经跟了 thinking / tool，CLI 回显那条
// 用户消息时尾巴不是 user。原来只看最后一条，去重失效 → 回显被当成新的一条用户
// 消息插进来 → 这一轮被切成两半（前半截被当成「已完成」收起来、还冒出复制按钮）。
describe("插话回显去重（回合进行中）", () => {
  const thinking: Item = { id: "th", seq: 0, ts: 0, kind: "thinking", text: "想一下" };

  it("尾巴是过程内容时，仍能认出这条回显", () => {
    // 本地发一条、插一句，中间插进了思考。
    let items: Item[] = appendUser([], "开始干活", undefined, false);
    items = [...items, thinking];
    items = appendUser(items, "顺便看看日志", undefined, true);

    items = applyCLI(items, {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "顺便看看日志" }] },
    });

    // 没有多出第三条用户消息。
    expect(items.filter((i) => i.kind === "user")).toHaveLength(2);
  });

  it("插话之前那条的尾巴也是过程内容时同理", () => {
    let items: Item[] = appendUser([], "开始干活", undefined, false);
    items = [...items, thinking];
    items = applyCLI(items, {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "开始干活" }] },
    });
    expect(items.filter((i) => i.kind === "user")).toHaveLength(1);
  });

  // 跨过 result 就是上一轮：用户真的又说了一遍同样的话，不能被吞。
  it("不跨轮去重：上一轮说过同样的话，这一轮仍保留", () => {
    const result: Item = { id: "r1", seq: 0, ts: 0, kind: "result", durationMs: 1000 };
    let items: Item[] = appendUser([], "跑测试", undefined, false);
    items = [...items, result];
    items = applyCLI(items, {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "跑测试" }] },
    });
    expect(items.filter((i) => i.kind === "user")).toHaveLength(2);
  });
});

// 后端 `prompt.echo` 走的是另一条去重（`appendPromptEcho`）。插话时本地气泡后面
// 已经跟上了 thinking，尾项不是 user——旧实现只看尾巴，于是广播被当成新消息补进来，
// 那条没有 interjected 标记，把这一轮切成两半。
describe("prompt.echo 插话去重（回合进行中）", () => {
  it("尾巴是 thinking 时，广播不再补一条用户消息", () => {
    let items: Item[] = appendUser([], "开始干活", undefined, false);
    items = [...items, { id: "th", seq: 0, ts: 0, kind: "thinking", text: "想一下" }];
    items = appendUser(items, "顺便看看日志", undefined, true);
    // 插话写进 stdin 之后、广播到达之前，CLI 已经在往下跑了。
    items = [...items, { id: "th2", seq: 0, ts: 0, kind: "thinking", text: "接着想" }];

    items = appendPromptEcho(items, { text: "顺便看看日志", interjected: true });
    expect(items.filter((i) => i.kind === "user")).toHaveLength(2);
  });

  it("别的设备发来的插话确实会补一条，并带上 interjected", () => {
    // 本机没有这条气泡：必须补，否则界面上只剩模型突然开始思考。
    const items = appendPromptEcho([], { text: "另一台设备插的话", interjected: true });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "user", interjected: true });
  });
});

// 重连补不齐时整份重放转录，需要跟本地那份合并：
// 以转录为主（它完整、有序、带真实时间戳），只把本地 ts 晚于转录最后一条的接上。
describe("mergeReplayed", () => {
  const user = (text: string, ts: number): Item => ({ id: `u${ts}`, seq: 0, ts, kind: "user", text });
  const asst = (text: string, ts: number): Item => ({
    id: `a${ts}`,
    seq: 0,
    ts,
    kind: "assistant",
    text,
    streaming: false,
  });

  it("本地空时直接用转录", () => {
    const history = [user("问题", 100)];
    expect(mergeReplayed(history, [])).toBe(history);
  });

  it("转录里已经有本地那条（乐观插入的提示词）时不会出现两遍", () => {
    const history = [user("问题", 100), asst("回答", 200)];
    // 本地那份只有那条乐观插入的提示词：ts 不晚于转录最后一条，所以不接。
    const local = [user("问题", 90)];
    expect(mergeReplayed(history, local)).toHaveLength(2);
  });

  it("只接转录之后的新条目（断线时本地插的错误提示等）", () => {
    const history = [user("问题", 100), asst("回答", 200)];
    const local = [user("问题", 90), { id: "e1", seq: 1, ts: 300, kind: "error" as const, text: "连接已断开" }];
    const merged = mergeReplayed(history, local);
    expect(merged.map((i) => i.kind)).toEqual(["user", "assistant", "error"]);
  });

  it("接上去的条目重排序号（两边的 seq 都是从 0 起算的独立计数）", () => {
    // 真实转录回放出来的 seq 是递增的（applyCLI 逐条 +1）。
    const history = [{ ...user("问题", 100), seq: 0 }, { ...asst("回答", 200), seq: 1 }];
    const local = [{ id: "e1", seq: 0, ts: 300, kind: "error" as const, text: "连接已断开" }];
    const merged = mergeReplayed(history, local);
    const seqs = merged.map((i) => i.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("settle=true 时收掉本地残留的流式光标（那一轮早就结束了）", () => {
    const history = [user("问题", 100), asst("完整回答", 200)];
    const local: Item[] = [{ id: "s1", seq: 0, ts: 50, kind: "assistant", text: "半截", streaming: true }];
    const merged = mergeReplayed(history, local, true);
    expect(merged.some((i) => i.kind === "assistant" && i.streaming)).toBe(false);
  });
});

function thinkingDelta(text: string) {
  return { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: text } } };
}

function assistantThinking(thinking: string, text?: string) {
  const content: unknown[] = [{ type: "thinking", thinking }];
  if (text) content.push({ type: "text", text });
  return { type: "assistant", message: { role: "assistant", content } };
}

describe("思考流式（thinking_delta）", () => {
  beforeEach(() => __resetIds());

  // 真实帧序（2.1.329 实测）：message_start → content_block_start(thinking) →
  // 多条 thinking_delta（中间夹 system/thinking_tokens）→ signature_delta →
  // content_block_stop → assistant（完整消息）。只认 text_delta 时，这整段时间
  // 界面上什么都不动——模型思考几十秒，用户会以为会话卡死了。
  it("thinking_delta 逐字累积成一个流式思考块", () => {
    let items: Item[] = [];
    items = applyCLI(items, thinkingDelta("让我"));
    items = applyCLI(items, thinkingDelta("想想"));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "thinking", text: "让我想想", streaming: true });
  });

  it("完整消息把流式思考替换掉，不重复显示", () => {
    let items: Item[] = [];
    items = applyCLI(items, thinkingDelta("让我想想"));
    items = applyCLI(items, assistantThinking("让我想想", "答案是 42。"));
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "thinking", text: "让我想想" });
    expect(items[0]).not.toMatchObject({ streaming: true });
    expect(items[1]).toMatchObject({ kind: "assistant", text: "答案是 42。" });
  });

  it("思考与正文各自维护流式气泡，交替到达时不会互相吞掉", () => {
    let items: Item[] = [];
    items = applyCLI(items, thinkingDelta("先想"));
    items = applyCLI(items, delta("再答"));
    items = applyCLI(items, thinkingDelta("补一句"));
    expect(items.map((i) => i.kind)).toEqual(["thinking", "assistant", "thinking"]);
  });

  it("完整消息里没有 thinking 块时保留已收到的思考文字（中断的回合）", () => {
    let items: Item[] = [];
    items = applyCLI(items, thinkingDelta("想到一半被打断"));
    // 只有正文、没有 thinking 块（上游在中断后只回正文的形态）。
    items = applyCLI(items, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "好的" }] } });
    expect(items[0]).toMatchObject({ kind: "thinking", text: "想到一半被打断", streaming: false });
    expect(items[1]).toMatchObject({ kind: "assistant", text: "好的" });
  });

  // 上游在工具调用之间会发纯空白的 thinking_delta（`" "` / `"\n"`）：自己开一个
  // 气泡就是界面上那行「思考过程 · 0 字」，点开只有个空格（截图复现过）。
  it("纯空白的 thinking_delta 不开新气泡", () => {
    let items: Item[] = [];
    items = applyCLI(items, thinkingDelta(" "));
    items = applyCLI(items, thinkingDelta("\n  "));
    expect(items).toHaveLength(0);
  });

  it("已经有思考气泡时空白增量照常追加（中间的换行不能丢）", () => {
    let items: Item[] = [];
    items = applyCLI(items, thinkingDelta("第一段"));
    items = applyCLI(items, thinkingDelta("\n\n"));
    items = applyCLI(items, thinkingDelta("第二段"));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "thinking", text: "第一段\n\n第二段", streaming: true });
  });

  // 只有 thinking_delta、完整消息里却没有 thinking 块（中断形态）：leftover 要补回去，
  // 但纯空白的 leftover 补出来就是一行「0 字」。
  it("完整消息没有 thinking 块时，纯空白的残留思考不补回", () => {
    let items: Item[] = [];
    items = applyCLI(items, thinkingDelta("   "));
    items = applyCLI(items, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "好的" }] } });
    expect(items.map((i) => i.kind)).toEqual(["assistant"]);
  });

  it("被中断时流式思考块也要收尾（否则光标一直闪）", () => {
    let items: Item[] = [];
    items = applyCLI(items, thinkingDelta("一直想"));
    items = applyCLI(items, { type: "result", subtype: "error_during_execution", is_error: true, errors: [] });
    expect(items.some((i) => i.kind === "thinking" && i.streaming)).toBe(false);
  });
});

describe("system 消息里的可显示状态", () => {
  beforeEach(() => __resetIds());

  // api_retry 的载荷全是结构化字段、没有 content，早先会静默穿过。
  it("api_retry 显示成一条重试提示", () => {
    const items = applyCLI([], {
      type: "system",
      subtype: "api_retry",
      attempt: 2,
      max_retries: 10,
      error_status: 529,
      error: "overloaded_error",
      retry_delay_ms: 1038,
    });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("system");
    expect((items[0] as { text: string }).text).toContain("2/10");
    expect((items[0] as { text: string }).text).toContain("529");
  });

  // compacting 会连发很多条（每次 summary 增长一条），不能叠一屏。
  it("status=compacting 只留一条提示", () => {
    let items: Item[] = [];
    for (let i = 0; i < 5; i += 1) {
      items = applyCLI(items, { type: "system", subtype: "status", status: "compacting" });
    }
    expect(items).toHaveLength(1);
    expect((items[0] as { text: string }).text).toContain("压缩");
  });

  it("压缩失败显示原因（静默失败会让人以为历史无故变短）", () => {
    const items = applyCLI([], {
      type: "system",
      subtype: "status",
      status: "requesting",
      compact_result: "failed",
      compact_error: "prompt too long",
    });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("error");
    expect((items[0] as { text: string }).text).toContain("prompt too long");
  });

  it("普通 status 不进消息流", () => {
    const items = applyCLI([], { type: "system", subtype: "status", status: "requesting" });
    expect(items).toHaveLength(0);
  });

  // hook 的输出在 output/stdout/stderr 里，没有 content，早先同样静默。
  it("hook 失败显示 hook 名与 stderr，成功的报告不显示", () => {
    const ok = applyCLI([], {
      type: "system",
      subtype: "hook_response",
      hook_name: "fmt",
      hook_event: "PostToolUse",
      outcome: "success",
      stdout: "fine",
    });
    expect(ok).toHaveLength(0);

    const bad = applyCLI([], {
      type: "system",
      subtype: "hook_response",
      hook_name: "fmt",
      hook_event: "PostToolUse",
      outcome: "error",
      exit_code: 2,
      stderr: "gofmt: no such file",
    });
    expect(bad).toHaveLength(1);
    const text = (bad[0] as { text: string }).text;
    expect(text).toContain("fmt");
    expect(text).toContain("2");
    expect(text).toContain("gofmt: no such file");
  });

  it("Stop hook 的 hookErrors 非空才显示", () => {
    const clean = applyCLI([], { type: "system", subtype: "stop_hook_summary", hookErrors: [] });
    expect(clean).toHaveLength(0);
    const bad = applyCLI([], {
      type: "system",
      subtype: "stop_hook_summary",
      hookErrors: ["JSON validation failed"],
    });
    expect(bad).toHaveLength(1);
    expect((bad[0] as { text: string }).text).toContain("JSON validation failed");
  });

  // 模型回退在 ccweb 里已经用 CLAUDE_CODE_NO_MODEL_FALLBACK 关掉了，但旧版本 /
  // 环境变量失效时仍可能收到这条：它的 content 是 CLI 写好的入话，照常显示。
  it("model_fallback 的 content 照常显示", () => {
    const items = applyCLI([], {
      type: "system",
      subtype: "model_fallback",
      trigger: "overloaded",
      original_model: "a",
      fallback_model: "b",
      content: "Switched to b for this turn",
    });
    expect(items).toHaveLength(1);
    expect((items[0] as { text: string }).text).toContain("Switched to b");
  });
});

describe("commands_changed", () => {
  beforeEach(() => __resetIds());

  // CLI 的原话：clients should REPLACE their cached command list。
  // 不接的话，会话中途装的技能永远进不了 `/` 菜单。
  it("解析出完整命令列表（replace 语义）", () => {
    const cmds = commandsChanged({
      type: "system",
      subtype: "commands_changed",
      commands: [
        { name: "review", description: "审查代码", argumentHint: "<path>", builtin: false },
        { name: "clear", builtin: true },
        { 缺名字: 1 },
        "垃圾",
      ],
    });
    expect(cmds).toEqual([
      { name: "review", description: "审查代码", argumentHint: "<path>", builtin: false },
      { name: "clear", builtin: true },
    ]);
  });

  it("不是这条消息时返回 undefined", () => {
    expect(commandsChanged({ type: "system", subtype: "status" })).toBeUndefined();
    expect(commandsChanged({ type: "system", subtype: "commands_changed" })).toBeUndefined();
    expect(commandsChanged(null)).toBeUndefined();
  });

  it("不进消息流", () => {
    const items = applyCLI([], {
      type: "system",
      subtype: "commands_changed",
      commands: [{ name: "review" }],
    });
    expect(items).toHaveLength(0);
  });
});

describe("conversation_reset", () => {
  beforeEach(() => __resetIds());

  // 实测帧序（2.1.329，--input-format stream-json 的常驻会话）：
  //   result → conversation_reset{trigger:"clear"} → system/background_tasks_changed
  //   → system/init{session_id: <新 id>}
  // 它必须显示：上下文被清空了，而界面上的旧消息还在，否则
  // 「刚才说过的话模型怎么不记得了」完全无从解释。
  it("/clear 显示成一条上下文已清空的提示", () => {
    const items = applyCLI([], {
      type: "conversation_reset",
      trigger: "clear",
      new_conversation_id: "new-id",
    });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("system");
    expect((items[0] as { text: string }).text).toContain("清空");
  });

  it("未知 trigger 说「已重置」，不硬猜成 /clear", () => {
    const items = applyCLI([], { type: "conversation_reset", trigger: "something-new" });
    const text = (items[0] as { text: string }).text;
    expect(text).toContain("重置");
    expect(text).not.toContain("/clear");
  });
});



describe("CLI 注入的后台任务通知", () => {
  beforeEach(() => __resetIds());

  // 后台命令/子代理结束时 CLI 会写一条普通 user 行（isMeta 是 null，绕过了
  // applyCLI 顶上的 meta 过滤）。不丢掉的话，停掉后台命令再重进对话，界面上
  // 就多出一坨 `<task-notification>` 原始 XML，还让轮次计数多一格。
  const notice =
    "<task-notification>\n<task-id>bv3vaq2qk</task-id>\n<tool-use-id>call_00_x</tool-use-id>\n" +
    "<output-file>/tmp/x.output</output-file>\n<status>killed</status>\n" +
    '<summary>Background command "Run 529 mock server" was stopped</summary>\n' +
    "<note>No completion record was found…</note>\n</task-notification>";

  it("整条丢弃，不进消息流", () => {
    const items = applyCLI([], { type: "user", message: { role: "user", content: notice } });
    expect(items).toHaveLength(0);
  });

  it("内容块数组形态也认", () => {
    const items = applyCLI([], {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: notice }] },
    });
    expect(items).toHaveLength(0);
  });

  it("用户正文里贴了这段 XML 时不吞（前后还有自己的话）", () => {
    const items = applyCLI([], {
      type: "user",
      message: { role: "user", content: "帮我看下这个：\n" + notice },
    });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("user");
  });

  it("isTaskNotification 只认整条就是这一个块", () => {
    expect(isTaskNotification(notice)).toBe(true);
    expect(isTaskNotification("  " + notice + "  ")).toBe(true);
    expect(isTaskNotification("<task-notification>缺结束标签")).toBe(false);
    expect(isTaskNotification("hello")).toBe(false);
    expect(isTaskNotification("")).toBe(false);
  });
});
