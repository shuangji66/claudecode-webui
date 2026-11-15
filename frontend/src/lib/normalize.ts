// CLI 原始消息 → 渲染模型的归一化逻辑（纯函数，可单测）。
//
// 这里承担三件容易出错的事：
//   1. 流式去重：--include-partial-messages 会先给逐字 stream_event，再给一次完整的
//      assistant 消息。两套都往列表里 push 会让每句话出现两遍，所以流式阶段只维护
//      一个 streaming 气泡，完整消息到达时「替换」而不是「追加」。
//   2. tool_use ↔ tool_result 配对：结果消息里的 tool_use_id 必须回填到对应工具卡片。
//   3. 未知消息类型原样忽略，不抛错（协议会随 CLI 版本漂移）。

import type { Item } from "./model";

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `it-${idCounter}`;
}

/** 仅用于测试：重置 id 计数器。 */
export function __resetIds(): void {
  idCounter = 0;
}

function seqOf(items: Item[]): number {
  return items.length === 0 ? 0 : items[items.length - 1].seq + 1;
}

/** 把 tool_result 的 content（字符串或内容块数组）压成纯文本。 */
export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (b && typeof b === "object") {
        const block = b as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        } else if (typeof block.text === "string") {
          parts.push(block.text);
        }
      } else if (typeof b === "string") {
        parts.push(b);
      }
    }
    if (parts.length > 0) return parts.join("\n");
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

type Raw = Record<string, unknown>;

function asRecord(v: unknown): Raw | undefined {
  return v && typeof v === "object" ? (v as Raw) : undefined;
}

/** 处理一条 CLI 原始消息，返回新的列表（不修改入参）。 */
export function applyCLI(items: Item[], msg: unknown): Item[] {
  const m = asRecord(msg);
  if (!m) return items;
  switch (m.type) {
    case "stream_event":
      return applyStreamEvent(items, m);
    case "assistant":
      return applyAssistant(items, m);
    case "user":
      return applyUser(items, m);
    case "result":
      return applyResult(items, m);
    case "system":
      return applySystem(items, m);
    default:
      return items;
  }
}

function applyStreamEvent(items: Item[], m: Raw): Item[] {
  const ev = asRecord(m.event);
  if (!ev || ev.type !== "content_block_delta") return items;
  const delta = asRecord(ev.delta);
  if (!delta || delta.type !== "text_delta" || typeof delta.text !== "string") return items;

  const last = items[items.length - 1];
  if (last && last.kind === "assistant" && last.streaming) {
    return [...items.slice(0, -1), { ...last, text: last.text + delta.text }];
  }
  return [
    ...items,
    {
      id: nextId(),
      seq: seqOf(items),
      ts: Date.now(),
      kind: "assistant",
      text: delta.text,
      streaming: true,
    },
  ];
}

function applyAssistant(items: Item[], m: Raw): Item[] {
  const message = asRecord(m.message);
  const content = message?.content;
  const blocks = Array.isArray(content) ? content : [];

  let out = items;
  const textBlock = blocks.find((b) => asRecord(b)?.type === "text");
  const text = typeof asRecord(textBlock)?.text === "string" ? (asRecord(textBlock)!.text as string) : "";

  const last = out[out.length - 1];
  const hasStreaming = last && last.kind === "assistant" && last.streaming;

  if (text) {
    if (hasStreaming) {
      // 关键：替换流式气泡，而不是再 push 一条，否则整段回答会重复显示。
      out = [...out.slice(0, -1), { ...(last as Extract<Item, { kind: "assistant" }>), text, streaming: false }];
    } else {
      out = [
        ...out,
        { id: nextId(), seq: seqOf(out), ts: Date.now(), kind: "assistant", text, streaming: false },
      ];
    }
  } else if (hasStreaming) {
    // 纯工具/思考回合：把悬着的流式气泡收尾，避免一直转圈。
    out = [...out.slice(0, -1), { ...(last as Extract<Item, { kind: "assistant" }>), streaming: false }];
  }

  for (const b of blocks) {
    const block = asRecord(b);
    if (!block) continue;
    if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
      out = [
        ...out,
        { id: nextId(), seq: seqOf(out), ts: Date.now(), kind: "thinking", text: block.thinking },
      ];
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      const toolUseId = typeof block.id === "string" ? block.id : "";
      // 防御性去重：同一 tool_use_id 若重复到达（重连回放、CLI 重试），
      // 不应生成两张卡片——否则 tool_result 会被回填到两张卡上。
      if (toolUseId && out.some((it) => it.kind === "tool" && it.toolUseId === toolUseId)) {
        continue;
      }
      out = [
        ...out,
        {
          id: nextId(),
          seq: seqOf(out),
          ts: Date.now(),
          kind: "tool",
          toolUseId,
          name: block.name,
          input: block.input,
        },
      ];
    }
  }
  return out;
}

function applyUser(items: Item[], m: Raw): Item[] {
  const message = asRecord(m.message);
  const content = message?.content;
  const blocks = Array.isArray(content) ? content : [];
  const results = blocks.filter((b) => asRecord(b)?.type === "tool_result");

  if (results.length > 0) {
    const structured = m.tool_use_result ?? m.toolUseResult;
    let out = items;
    for (const r of results) {
      const block = asRecord(r)!;
      const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      const text = textOfContent(block.content);
      const isError = block.is_error === true;
      out = out.map((it) =>
        it.kind === "tool" && it.toolUseId === toolUseId
          ? { ...it, result: text, isError, structured: structured ?? it.structured }
          : it,
      );
    }
    return out;
  }

  // 附件消息会被 CLI 原样回显（图片/PDF 是 image/document block，文本文件是
  // 额外的 text block）。本地气泡只显示提示词与文件名，不能按文本内容精确
  // 去重，否则会出现两条用户消息。
  const textBlocks = blocks.filter((b) => asRecord(b)?.type === "text");
  const hasFileBlock = textBlocks.some((b) => {
    const value = asRecord(b)?.text;
    return typeof value === "string" && value.startsWith("<file name=");
  });
  const attachmentEcho =
    blocks.some((b) => asRecord(b)?.type !== "text") || textBlocks.length > 1 || hasFileBlock;
  if (attachmentEcho) {
    const last = items[items.length - 1];
    if (last && last.kind === "user") return items;
    const firstText = textOfContent(textBlocks);
    return [
      ...items,
      { id: nextId(), seq: seqOf(items), ts: Date.now(), kind: "user", text: firstText || "附件" },
    ];
  }

  // 纯用户文本：本地发送时已经插过一条，这里按内容去重，避免重复。
  const text = textOfContent(content);
  if (!text) return items;
  const last = items[items.length - 1];
  if (
    last &&
    last.kind === "user" &&
    (last.text === text ||
      last.text.startsWith(`${text}\n附件：`) ||
      last.text.startsWith(`${text}\nFile: `))
  ) {
    return items;
  }
  return [...items, { id: nextId(), seq: seqOf(items), ts: Date.now(), kind: "user", text }];
}

function applyResult(items: Item[], m: Raw): Item[] {
  const denials = Array.isArray(m.permission_denials) ? (m.permission_denials as unknown[]) : [];
  return [
    ...items,
    {
      id: nextId(),
      seq: seqOf(items),
      ts: Date.now(),
      kind: "result",
      costUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined,
      durationMs: typeof m.duration_ms === "number" ? m.duration_ms : undefined,
      isError: m.is_error === true,
      denials,
    },
  ];
}

function applySystem(items: Item[], m: Raw): Item[] {
  // init 只用于填充顶栏元信息，不进消息流；status 同理。
  if (m.subtype === "init" || m.subtype === "status") return items;
  // hooks 输出等以 system + content 字符串形式上送，需要展示（并清洗 ANSI）。
  if (typeof m.content === "string" && m.content) {
    return [
      ...items,
      {
        id: nextId(),
        seq: seqOf(items),
        ts: Date.now(),
        kind: "system",
        subtype: typeof m.subtype === "string" ? m.subtype : undefined,
        text: stripAnsi(m.content),
      },
    ];
  }
  return items;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** 去掉终端 ANSI 颜色转义（hooks 输出里常见）。 */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** 本地插入一条用户消息（不等后端回显）。 */
export function appendUser(items: Item[], text: string): Item[] {
  return [...items, { id: nextId(), seq: seqOf(items), ts: Date.now(), kind: "user", text }];
}

/** 本地插入一条错误提示。 */
export function appendError(items: Item[], text: string): Item[] {
  return [...items, { id: nextId(), seq: seqOf(items), ts: Date.now(), kind: "error", text }];
}
