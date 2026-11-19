// CLI 原始消息 → 渲染模型的归一化逻辑（纯函数，可单测）。
//
// 这里承担三件容易出错的事：
//   1. 流式去重：--include-partial-messages 会先给逐字 stream_event，再给一次完整的
//      assistant 消息。两套都往列表里 push 会让每句话出现两遍，所以流式阶段只维护
//      一个 streaming 气泡，完整消息到达时「替换」而不是「追加」。
//   2. tool_use ↔ tool_result 配对：结果消息里的 tool_use_id 必须回填到对应工具卡片。
//   3. 未知消息类型原样忽略，不抛错（协议会随 CLI 版本漂移）。

import {
  applyUsageMessage,
  cacheHitRate,
  contextTokens,
  formatTokens,
  totalsFromUsage,
  type UsageSnapshot,
} from "./usage";
import { interruptReason } from "./model";
import type { Item, SubagentInfo, ToolImage, TurnUsage, UserImage } from "./model";

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

/** 内联 JSON 兜底的上限：未知块里可能藏着 base64，整段塞进 DOM 会把页面拖死。 */
const MAX_INLINE_JSON = 4000;

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 非文本块（图片/文档）的占位说明：base64 绝不能当正文渲染。 */
function describeBlock(block: Raw): string | undefined {
  if (block.type !== "image" && block.type !== "document") return undefined;
  const src = asRecord(block.source);
  const mediaType = typeof src?.media_type === "string" ? src.media_type : "";
  const data = typeof src?.data === "string" ? src.data : "";
  // base64 长度 ≈ 字节数 * 4/3，估算够用了，别真去解码。
  const size = data ? humanBytes(Math.floor((data.length * 3) / 4)) : "";
  const kind = block.type === "image" ? "图片" : "文档";
  return `[${kind}${mediaType ? ` ${mediaType}` : ""}${size ? `，约 ${size}` : ""}]`;
}

function jsonPreview(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
  return s.length > MAX_INLINE_JSON ? `${s.slice(0, MAX_INLINE_JSON)}…（共 ${s.length} 字符，已省略）` : s;
}

/** 把 tool_result 的 content（字符串或内容块数组）压成纯文本。 */
export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (typeof b === "string") {
        parts.push(b);
        continue;
      }
      const block = asRecord(b);
      if (!block) continue;
      if (typeof block.text === "string") {
        parts.push(block.text);
        continue;
      }
      const placeholder = describeBlock(block);
      if (placeholder) parts.push(placeholder);
    }
    if (parts.length > 0) return parts.join("\n");
    return jsonPreview(content);
  }
  if (content == null) return "";
  return jsonPreview(content);
}

const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_TOOL_IMAGES = 8;
const MAX_TOOL_IMAGE_BYTES = 4 << 20;

/** 抽出 tool_result 里的图片，交给卡片渲染缩略图（文本侧只留占位符）。 */
export function imagesOfContent(content: unknown): ToolImage[] {
  if (!Array.isArray(content)) return [];
  const out: ToolImage[] = [];
  for (const b of content) {
    if (out.length >= MAX_TOOL_IMAGES) break;
    const block = asRecord(b);
    if (!block || block.type !== "image") continue;
    const src = asRecord(block.source);
    const mediaType = typeof src?.media_type === "string" ? src.media_type : "";
    const data = typeof src?.data === "string" ? src.data : "";
    if (!IMAGE_MEDIA_TYPES.has(mediaType) || !data) continue;
    // 超限的图不往前端塞，避免一条工具结果把标签页内存撑爆。
    if (data.length * 0.75 > MAX_TOOL_IMAGE_BYTES) continue;
    out.push({ mediaType, data });
  }
  return out;
}

type Raw = Record<string, unknown>;

function asRecord(v: unknown): Raw | undefined {
  return v && typeof v === "object" ? (v as Raw) : undefined;
}

/** 这条 CLI 消息是不是「一轮结束」（成功、被中断、报错都会发 result）。 */
export function isTurnResult(msg: unknown): boolean {
  return asRecord(msg)?.type === "result";
}

/**
 * 处理一条 CLI 原始消息，返回新的列表（不修改入参）。
 *
 * `at` 用于回放历史转录时保留原始时间，不传则用当前时间。
 * `usageHint` 是实时流里已经攒下的用量快照（store 的 `usage[sid]`）：`result` 的整轮
 * 口径里没有「最近一次请求的生成速度」，tok/s 只能从流式阶段量到的 genMs/genTokens 借。
 */
export function applyCLI(items: Item[], msg: unknown, at = Date.now(), usageHint?: UsageSnapshot): Item[] {
  const m = asRecord(msg);
  if (!m) return items;
  // sidechain（子代理）与 meta 行一律不进主消息流。实时流里 store 已分流子代理帧，
  // 但**转录回放**是把 jsonl 逐行喂进来：CLI 会给同一句话补一条 `isMeta: true` 的
  // 伴随行（`turnCompanion`，例如把附加的图片/路径写成一句 `[Image: source: …]`），
  // 不挡的话它会被当成用户又发了一句，气泡里凭空多出一条 `[Image: source: /tmp/…]`，
  // 而且轮次刻度也跟着多一格。
  if (m.isSidechain === true || m.isMeta === true) return items;
  switch (m.type) {
    case "stream_event":
      return applyStreamEvent(items, m, at);
    case "assistant":
      return applyAssistant(items, m, at);
    case "user":
      return applyUser(items, m, at);
    case "result":
      return applyResult(items, m, at, usageHint);
    case "system":
      // 任务事件（子代理 / 后台命令）要先折进对应的工具卡片，再走通用 system 渲染。
      return applyTaskEvent(items, m, at) ?? applySystem(items, m, at);
    case "tool_progress":
      return applyToolProgress(items, m);
    default:
      return items;
  }
}

// localCommandEchoRE 匹配「本地斜杠命令的回显」：claude CLI 把 /model、/clear 这类
// 本地命令的输入与输出当作 user 消息写进会话流，界面里会把它们渲染成用户气泡
// （例如 `<local-command-stdout>Set model to `x`</local-command-stdout>`）。
// 这些不是用户说的话，切模型在设置页已经能表达，所以整条丢弃。
//
// 只认「整条消息就是这些标签」的形态：用户正文里恰好提到 `<command-name>` 时，
// 前后还有自己的文字，不会命中。
const localCommandEchoRE =
  /^<(local-command-(?:stdout|stderr)|local-command-caveat|command-name|command-message|command-args)[\s\S]*<\/?(?:local-command-(?:stdout|stderr|caveat)|command-(?:name|message|args))>\s*$/;

/** 判断一条文本是否是本地斜杠命令的回显（应整条忽略）。 */
export function isLocalCommandEcho(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("<")) return false;
  return localCommandEchoRE.test(t);
}

// 回合被中断时，CLI 会往流里写一条**合成的 user 消息**当标记：
//   `[Request interrupted by user]`（按 Esc）
//   `[Request interrupted by user for tool use]`（工具执行中被打断）
//   `[Request interrupted: the session ended …]` / `[Agent call interrupted: …]`（进程/会话结束）
// 它不是用户说的话：渲染成用户气泡，用户会以为自己发过这句；而且它让 CLI 在这一轮结束时
// 报 error_during_execution（见 applyResult 里的处理）。判定照 CLI 自己的标记识别
// （2.1.327 的 `/^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/`），
// 只认「整条消息就是标记」的形态，用户正文里顺口提到这句话不会命中。
const interruptMarkerRE = /^\[(?:Request interrupted|Agent call interrupted)(?: by user|:)[^\]]*\]$/;

/** 判断一条用户文本是否是 CLI 的「本轮被中断」标记。 */
export function isInterruptMarker(text: string): boolean {
  return interruptMarkerRE.test(text.trim());
}

/**
 * 回合结束或连接断开时，把还挂着的流式气泡收尾。
 *
 * 只有完整 assistant 消息到达才会摘掉 `streaming`；一旦这一轮没有完整消息
 * （用户中断、进程崩溃、结果里只有错误），气泡会一直显示流式光标，看起来像还在写。
 */
export function settleStreaming(items: Item[]): Item[] {
  let changed = false;
  const out = items.map((it) => {
    if (it.kind !== "assistant" || !it.streaming) return it;
    changed = true;
    return { ...it, streaming: false };
  });
  return changed ? out : items;
}

/** 本回合（最后一条 result 之后）是否出现过中断标记。 */
function interruptedThisTurn(items: Item[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it.kind === "result") return false;
    if (it.kind === "interrupt") return true;
  }
  return false;
}

function applyStreamEvent(items: Item[], m: Raw, at: number): Item[] {
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
      ts: at,
      kind: "assistant",
      text: delta.text,
      streaming: true,
    },
  ];
}

function applyAssistant(items: Item[], m: Raw, at: number): Item[] {
  const message = asRecord(m.message);
  const content = message?.content;
  const blocks = Array.isArray(content) ? content : [];
  // 上游报错时 CLI 用一条 assistant 消息包装错误文本（`API Error: …`）。它不是模型的
  // 回答，result 里还会再给同一段原因——带上标记，result 那边据此不重复。
  // 线上字段只见 camelCase（2.1.327），snake_case 一并认，省得版本换写法时静默失效。
  const apiError = m.isApiErrorMessage === true || m.is_api_error_message === true;

  // 先把悬着的流式气泡摘掉：完整消息里带着全部内容块，按块顺序重建才能保住 CLI 的
  // 真实顺序（thinking → text → tool_use）。留着它会把正文永远排在思考之前。
  // 摘掉**所有**流式气泡，而不只是最后一个：增量与完整消息之间可能插进别的条目
  // （system 输出、task_started 占位卡、后端 error），那时气泡已不在末尾。
  // 只认末尾会让它留在原位且 streaming 永远为 true（光标常驻），完整消息再追加
  // 一份正文 —— 同一段话显示两遍。
  let out: Item[] = [];
  let leftover = "";
  let insertAt = -1;
  for (const it of items) {
    if (it.kind === "assistant" && it.streaming) {
      if (insertAt < 0) insertAt = out.length;
      leftover += it.text;
      continue;
    }
    out.push(it);
  }
  // 流式气泡原来的位置：只有增量、没有正文块时要把字补回这里，别挪到工具卡片后面。
  if (insertAt < 0) insertAt = out.length;

  let textCount = 0;
  // 上游中继（Anthropic 兼容代理）会把同一条消息的内容块重放多份：实测一次 /doctor
  // 回复里 thinking 与 text 各被复制了三份，界面与导出就变成「同一段回答三遍」。
  // tool_use 早就按 id 去重了，正文/思考没有 id，只能按「紧邻且逐字相同」判重。
  // 中间隔着别的块（tool_use、内容不同的正文）就不算重复，避免把模型真的重复
  // 说的两句话吞掉。
  let prevKind = "";
  let prevText = "";
  for (const b of blocks) {
    const block = asRecord(b);
    if (!block) continue;
    if (block.type === "text") {
      const text = typeof block.text === "string" ? block.text : "";
      if (!text) continue;
      if (prevKind === "text" && prevText === text) continue;
      prevKind = "text";
      prevText = text;
      textCount += 1;
      // 一条消息可能有多个 text 块（正文 → tool_use → 正文）：全部保留，各自成段。
      out = [
        ...out,
        {
          id: nextId(),
          seq: seqOf(out),
          ts: at,
          kind: "assistant",
          text,
          streaming: false,
          ...(apiError ? { apiError } : {}),
        },
      ];
    } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
      // 只认**非空白**内容：上游在工具调用之间常发一个 `" "`（实测一次会话里 57 条），
      // 渲染出来就是一行「思考过程 · 1 字」，点开是个空格——既没信息也点不动。
      if (prevKind === "thinking" && prevText === block.thinking) continue;
      prevKind = "thinking";
      prevText = block.thinking;
      out = [
        ...out,
        { id: nextId(), seq: seqOf(out), ts: at, kind: "thinking", text: block.thinking },
      ];
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      prevKind = "tool";
      prevText = "";
      const toolUseId = typeof block.id === "string" ? block.id : "";
      // 防御性去重：同一 tool_use_id 若重复到达（重连回放、CLI 重试），
      // 不应生成两张卡片——否则 tool_result 会被回填到两张卡上。
      if (toolUseId && out.some((it) => it.kind === "tool" && it.toolUseId === toolUseId)) {
        // 任务事件可能先造了占位卡（后台子代理）：把真正的入参并进去，别丢 model/isolation。
        out = out.map((it) =>
          it.kind === "tool" && it.toolUseId === toolUseId
            ? { ...it, name: block.name as string, input: block.input }
            : it,
        );
        continue;
      }
      out = [
        ...out,
        {
          id: nextId(),
          seq: seqOf(out),
          ts: at,
          kind: "tool",
          toolUseId,
          name: block.name,
          input: block.input,
        },
      ];
    }
  }

  // 只收到流式增量、没有正文块（例如被中断的回合）：把已收到的字补回原位置，别丢。
  if (textCount === 0 && leftover) {
    out = [
      ...out.slice(0, insertAt),
      { id: nextId(), seq: seqOf(out), ts: at, kind: "assistant", text: leftover, streaming: false, ...(apiError ? { apiError } : {}) },
      ...out.slice(insertAt),
    ];
  }
  return out;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function int(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function subagentStatus(v: unknown): SubagentInfo["status"] | undefined {
  return v === "running" || v === "completed" || v === "failed" || v === "stopped" ? v : undefined;
}

const TASK_SUBTYPES = new Set(["task_started", "task_progress", "task_updated", "task_notification"]);

/**
 * 把 system/task_* 事件折进对应的 Agent 工具卡片。
 *
 * 实测（2.1.325）：task_started 带 tool_use_id + description + subagent_type + spawn_depth，
 * task_updated 只带 task_id 与 patch，task_notification 带 status + summary + usage。
 * 三者都可能比工具卡片先到（后台任务），所以找不到卡片时按 tool_use_id 先造一张占位卡。
 */
function applyTaskEvent(items: Item[], m: Raw, at: number): Item[] | undefined {
  const subtype = str(m.subtype);
  if (!TASK_SUBTYPES.has(subtype)) return undefined;
  const taskId = str(m.task_id);
  if (!taskId) return undefined;
  const toolUseId = str(m.tool_use_id);

  let out = items;
  let index = out.findIndex(
    (it) =>
      it.kind === "tool" &&
      ((toolUseId !== "" && it.toolUseId === toolUseId) || it.subagent?.taskId === taskId),
  );
  if (index < 0) {
    // task_updated 没有 tool_use_id：此时卡片一定已经在列表里，找不到就忽略。
    if (!toolUseId) return items;
    const description = str(m.description);
    const prompt = str(m.prompt);
    const type = str(m.subagent_type);
    out = [
      ...out,
      {
        id: nextId(),
        seq: seqOf(out),
        ts: at,
        kind: "tool",
        toolUseId,
        name: "Agent",
        input: { description, prompt, subagent_type: type },
        subagent: { taskId, status: "running" },
      },
    ];
    index = out.length - 1;
  }

  const item = out[index] as Extract<Item, { kind: "tool" }>;
  const prev: SubagentInfo = item.subagent ?? { taskId, status: "running" };
  const next: SubagentInfo = { ...prev, taskId, agentId: prev.agentId ?? taskId };

  if (subtype === "task_started") {
    next.type = str(m.subagent_type) || prev.type;
    next.taskType = str(m.task_type) || prev.taskType;
    next.description = str(m.description) || prev.description;
    next.prompt = str(m.prompt) || prev.prompt;
    if (typeof m.is_backgrounded === "boolean") next.background = m.is_backgrounded;
    next.spawnDepth = int(m.spawn_depth) ?? prev.spawnDepth;
  } else if (subtype === "task_progress") {
    // 运行中的进度：只更新用量与一行摘要，状态保持 running。
    next.summary = str(m.summary) || prev.summary;
    const usage = asRecord(m.usage);
    if (usage) {
      next.usage = {
        totalTokens: int(usage.total_tokens) ?? 0,
        toolUses: int(usage.tool_uses) ?? 0,
        durationMs: int(usage.duration_ms) ?? 0,
      };
    }
  } else if (subtype === "task_updated") {
    const patch = asRecord(m.patch) ?? {};
    next.status = subagentStatus(patch.status) ?? prev.status;
  } else {
    next.status = subagentStatus(m.status) ?? prev.status;
    next.summary = str(m.summary) || prev.summary;
    next.outputFile = str(m.output_file) || prev.outputFile;
    const usage = asRecord(m.usage);
    if (usage) {
      next.usage = {
        totalTokens: int(usage.total_tokens) ?? 0,
        toolUses: int(usage.tool_uses) ?? 0,
        durationMs: int(usage.duration_ms) ?? 0,
      };
    }
  }

  return [...out.slice(0, index), { ...item, subagent: next }, ...out.slice(index + 1)];
}

/**
 * 判断一条帧是否产生于子代理内部。
 *
 * 打开 --forward-subagent-text 后，子代理的正文/思考会带着 parent_tool_use_id 与
 * agent_id 混在同一个 stdout 里；store 必须把它们分流到子代理视图，
 * 否则子代理说的话会糊进主对话（和转录里过滤 isSidechain 是同一类问题）。
 */
export function subagentFrame(msg: unknown): { agentId: string; toolUseId: string } | undefined {
  const m = asRecord(msg);
  if (!m) return undefined;
  const toolUseId = typeof m.parent_tool_use_id === "string" ? m.parent_tool_use_id : "";
  if (!toolUseId) return undefined;
  const agentId = typeof m.agent_id === "string" && m.agent_id ? m.agent_id : toolUseId;
  return { agentId, toolUseId };
}

/** tool_progress 只更新卡片上的「已跑 N 秒」，不产生新消息。 */
function applyToolProgress(items: Item[], m: Raw): Item[] {
  const toolUseId = str(m.tool_use_id);
  const elapsed = int(m.elapsed_time_seconds);
  if (!toolUseId || elapsed === undefined) return items;
  return items.map((it) =>
    it.kind === "tool" && it.toolUseId === toolUseId ? { ...it, progress: elapsed } : it,
  );
}

const AGENT_ID_RE = /\bagentId:\s*([A-Za-z0-9_-]{1,128})/;
const SUBAGENT_USAGE_RE =
  /<usage>[\s\S]*?subagent_tokens:\s*(\d+)[\s\S]*?tool_uses:\s*(\d+)[\s\S]*?duration_ms:\s*(\d+)[\s\S]*?<\/usage>/;

/**
 * 从 Agent 工具的 tool_result 里读回 agentId 与用量。
 *
 * 回放历史时只有这段文本（主转录里没有 task_* 行），「查看子代理对话」要靠它。
 */
export function subagentFromResult(text: string, isError: boolean): Partial<SubagentInfo> | undefined {
  const idMatch = AGENT_ID_RE.exec(text);
  const usageMatch = SUBAGENT_USAGE_RE.exec(text);
  if (!idMatch && !usageMatch) return undefined;
  const out: Partial<SubagentInfo> = { status: isError ? "failed" : "completed" };
  if (idMatch) out.agentId = idMatch[1];
  if (usageMatch) {
    out.usage = {
      totalTokens: Number(usageMatch[1]),
      toolUses: Number(usageMatch[2]),
      durationMs: Number(usageMatch[3]),
    };
  }
  return out;
}

/** 文本文件附件的回显形态：`<file name="a.txt">…</file>`（见 protocol.UserMessage）。 */
const FILE_BLOCK_RE = /^<file name="([^"]*)">/;

function fileNameOfBlock(block: unknown): string | undefined {
  const text = asRecord(block)?.text;
  if (typeof text !== "string") return undefined;
  const m = FILE_BLOCK_RE.exec(text);
  return m?.[1] || undefined;
}

/** 回显与本地气泡是否同一条消息：比提示词前缀，不比附件名（CLI 不带文件名）。 */
function samePromptEcho(lastText: string, prompt: string): boolean {
  if (!prompt) return lastText === "附件" || lastText.startsWith("附件：");
  return (
    lastText === prompt ||
    lastText.startsWith(`${prompt}\n附件：`) ||
    lastText.startsWith(`${prompt}\nFile: `)
  );
}

/** 转录里的图片块能内联渲染的白名单（与后端接受的一组一致）。 */
const USER_IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * 取用户消息里的图片块（本地发送的截图，或转录回放里的同一批）。
 *
 * CLI 的 image block 只有字节、没有文件名，回放时补 `image-N.<扩展名>`；
 * 只认 base64 内联，`source.type === "url"` 一律跳过——那会让界面去第三方拉图，
 * 等于把「这条消息被看过」暴露出去。
 */
function userImagesOf(blocks: unknown[]): UserImage[] {
  const out: UserImage[] = [];
  for (const block of blocks) {
    const rec = asRecord(block);
    if (rec?.type !== "image") continue;
    const source = asRecord(rec.source);
    const mediaType = typeof source?.media_type === "string" ? source.media_type.toLowerCase() : "";
    const ext = USER_IMAGE_TYPES[mediaType];
    const data = typeof source?.data === "string" ? source.data : "";
    if (ext === undefined || data === "") continue;
    out.push({ name: `image-${out.length + 1}.${ext}`, mediaType, data });
  }
  return out;
}

function applyUser(items: Item[], m: Raw, at: number): Item[] {
  const message = asRecord(m.message);
  const content = message?.content;
  const blocks = Array.isArray(content) ? content : [];
  const images = userImagesOf(blocks);
  const results = blocks.filter((b) => asRecord(b)?.type === "tool_result");

  if (results.length > 0) {
    // tool_use_result 是**整条消息**上的单值；一条 user 行里出现多个 tool_result 时
    // 它只属于其中一个，套到其它卡片上会让 Edit 画出别的文件的 diff。
    const structured = results.length === 1 ? (m.tool_use_result ?? m.toolUseResult) : undefined;
    let out = items;
    for (const r of results) {
      const block = asRecord(r)!;
      const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      const text = textOfContent(block.content);
      const images = imagesOfContent(block.content);
      const isError = block.is_error === true;
      out = out.map((it) => {
        if (it.kind !== "tool" || it.toolUseId !== toolUseId) return it;
        // Agent 工具的最终报告里带着 agentId 与 <usage>：回放历史时没有 task 事件，
        // 靠它把卡片补成「已完成 + 用量 + 可查看对话」。
        const sub =
          it.name === "Agent" || it.name === "Task"
            ? subagentFromResult(text, isError)
            : undefined;
        const subagent: SubagentInfo | undefined = sub
          ? {
              taskId: it.subagent?.taskId ?? sub.agentId ?? "",
              ...it.subagent,
              ...sub,
              status: sub.status ?? it.subagent?.status ?? "running",
            }
          : it.subagent;
        return {
          ...it,
          result: text,
          isError,
          structured: structured ?? it.structured,
          ...(images.length > 0 ? { images } : {}),
          ...(subagent ? { subagent } : {}),
        };
      });
    }
    return out;
  }

  // 本地命令回显（/model 之类的 stdout、斜杠命令包装）整条丢弃：
  // 它不是用户说的话，也不是模型输出，渲染成气泡只会污染会话。
  if (isLocalCommandEcho(textOfContent(content))) return items;

  // CLI 的中断标记：单独渲染成一句中性的「已中断」，不占用户气泡。
  // 连续中断（用户连按 Esc）只留一条，否则每按一次多一行。
  const marker = textOfContent(content).trim();
  if (isInterruptMarker(marker)) {
    const last = items[items.length - 1];
    if (last && last.kind === "interrupt") return items;
    return [
      ...items,
      { id: nextId(), seq: seqOf(items), ts: at, kind: "interrupt", marker, reason: interruptReason(marker) },
    ];
  }

  // 附件消息会被 CLI 原样回显（图片/PDF 是 image/document block，文本文件是
  // 额外的 text block）。回放历史时没有本地气泡兜底，这里必须自己拼出
  // 「提示词 + 附件名」——否则内联的文件全文会当成用户说的话显示出来。
  const textBlocks = blocks.filter((b) => asRecord(b)?.type === "text");
  const fileBlocks = textBlocks.filter((b) => fileNameOfBlock(b) !== undefined);
  const promptBlocks = textBlocks.filter((b) => fileNameOfBlock(b) === undefined);
  const documentCount = blocks.filter((b) => asRecord(b)?.type === "document").length;
  // 认不出来的图片（url 来源、缺 data）：不能内联渲染，但仍要告诉用户「这里有过一张图」，
  // 否则整条消息会因为既没有正文、也没有可画的图而被丢掉。
  const imageBlockCount = blocks.filter((b) => asRecord(b)?.type === "image").length;
  const unrenderableImages = Math.max(0, imageBlockCount - images.length);
  const attachmentEcho =
    images.length > 0 || unrenderableImages > 0 || documentCount > 0 || textBlocks.length > 1 || fileBlocks.length > 0;
  if (attachmentEcho) {
    // 空数组不能走 textOfContent：它会把「无可读文本」降级成 JSON 预览（"[]"），
    // 拼出来的气泡就变成 "[]\n附件：a.txt"。
    const prompt = promptBlocks.length > 0 ? textOfContent(promptBlocks) : "";
    const names = fileBlocks
      .map(fileNameOfBlock)
      .filter((n): n is string => typeof n === "string" && n !== "");
    const binaries = documentCount + unrenderableImages;
    if (binaries > 0) names.push(`${binaries} 个图片/PDF`);
    // 图片不进正文：气泡里直接画出来，再写一行「附件：a.png」是重复信息。
    const display = [prompt, ...names.map((n) => `附件：${n}`)].filter(Boolean).join("\n");
    const last = items[items.length - 1];
    // 只有「本地刚插入的那条就是这条回显」时才丢弃。原先只看最后一条是不是 user：
    // 上一轮被中断（没有 assistant 行）时，下一条带附件的消息会被整条吞掉。
    // 比对只能比提示词前缀：CLI 的 image/document block 不带文件名，本地气泡对
    // 不可内联的附件写的是「附件：a.pdf」，回显只能拼出「附件：1 个图片/PDF」。
    // 只发了一张图、没有正文时两边 text 都是空串，只能靠「都有图片」认出来。
    const onlyImages = prompt === "" && last?.kind === "user" && last.text === "" && (last.images?.length ?? 0) > 0;
    if (last && last.kind === "user" && (samePromptEcho(last.text, prompt) || (images.length > 0 && onlyImages))) {
      return items;
    }
    return [
      ...items,
      {
        id: nextId(),
        seq: seqOf(items),
        ts: at,
        kind: "user",
        text: display,
        ...(images.length > 0 ? { images } : {}),
      },
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
  return [...items, { id: nextId(), seq: seqOf(items), ts: at, kind: "user", text }];
}

/** 转录里推导出来的一轮用量；ts 与该回合最后一条回答的 item.ts 对齐。 */
export interface TranscriptTurn {
  ts: number;
  turn: TurnUsage;
}

/**
 * 从转录行推导每一轮回答的用量。
 *
 * 为什么需要它：实时帧里的 result 带 duration_ms / usage，normalize 会把它贴到
 * 回答上；但重开对话走的是转录回放（`--resume` 不回放历史，界面自己读 jsonl），
 * 转录里没有 result 行（claude 只把 result 写 stdout），于是「本轮耗时 · 输出 tok」
 * 一刷新就没了。转录里其实有全部原料：
 *   - `assistant` 行的 `message.usage`：那次请求的 input/cache/output；
 *   - `api-request` 行 → 下一条 `assistant` 行的间隔 = 这次请求的 API 耗时；
 *   - 用户提问行 → 本轮最后一条 assistant 行的时间差 = 整个回合的墙钟耗时
 *     （与 result.duration_ms 同一个口径）。
 *
 * 拿不到的数不编：缺 prompt 时间（转录被截断）就整轮跳过，缺 usage 就跳过该轮。
 *
 * 口径与实时路径一致：`contextTokens` 只取**最后一次请求**（上下文占用），
 * `turnInputTokens` / `outputTokens` / `apiMs` 是本轮所有请求之和（这一轮吃了多少）。
 */
export function turnsFromTranscript(lines: unknown[]): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];
  let promptAt: number | undefined;
  let last: { ts: number; usage: UsageSnapshot } | undefined;
  let requestAt: number | undefined;
  // 本轮的累计消耗：一轮里可能有十几次请求，回答下面那行要的是它们的和。
  let turnIn = 0;
  let turnOut = 0;
  let turnApiMs = 0;

  const closeTurn = () => {
    if (promptAt === undefined || !last) return;
    out.push({
      ts: last.ts,
      turn: {
        durationMs: Math.max(0, last.ts - promptAt),
        usage: {
          ...last.usage,
          turnInputTokens: turnIn,
          outputTokens: turnOut,
          apiMs: turnApiMs || last.usage.apiMs,
        },
      },
    });
  };

  for (const raw of lines) {
    const line = asRecord(raw);
    if (!line) continue;
    // 服务端已经过滤过 sidechain / meta，这里再挡一次：子代理的话不能当回合边界。
    if (line.isSidechain === true || line.isMeta === true) continue;
    const type = str(line.type);
    const parsed = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : Number.NaN;
    const at = Number.isFinite(parsed) ? parsed : undefined;

    if (type === "api-request") {
      requestAt = at;
      continue;
    }
    if (type === "user") {
      if (!isPromptLine(line)) continue;
      closeTurn();
      promptAt = at;
      last = undefined;
      turnIn = 0;
      turnOut = 0;
      turnApiMs = 0;
      continue;
    }
    if (type === "assistant") {
      const totals = totalsFromUsage(asRecord(line.message)?.usage);
      // 这次请求已经结束（有没有 usage 都一样）：不清掉的话，下一条 assistant
      // 会拿上一个 api-request 算出一个跨了两次请求的「API 耗时」。
      const apiMs = at !== undefined && requestAt !== undefined && at >= requestAt ? at - requestAt : undefined;
      requestAt = undefined;
      if (!totals) continue;
      turnIn += contextTokens(totals);
      turnOut += totals.output;
      if (apiMs !== undefined) turnApiMs += apiMs;
      last = {
        ts: at ?? last?.ts ?? 0,
        usage: {
          contextTokens: contextTokens(totals),
          cacheHitRate: cacheHitRate(totals),
          // 最近一次请求自己的耗时与输出：tok/s 靠它（整轮平均会把每次请求的首字延迟摊进去）。
          genMs: apiMs,
          genTokens: totals.output,
        },
      };
    }
  }
  closeTurn();
  // 没有时间戳的行（极老转录）会导致 ts=0，贴上去只会把耗时算成 1970 年。
  return out.filter((t) => t.ts > 0);
}

/** 这条 user 行是用户的提问，而不是工具回包 / 本地命令回显。 */
function isPromptLine(line: Raw): boolean {
  const content = asRecord(line.message)?.content;
  if (typeof content === "string") return !isLocalCommandEcho(content) && content.trim() !== "";
  if (!Array.isArray(content)) return false;
  if (content.some((b) => asRecord(b)?.type === "tool_result")) return false;
  // 只发了图片/PDF 的提问没有 text block，但它照样是「一轮的开始」：不认的话这一轮的
  // 用量会被并进上一轮（lib/usage.ts 的同名判定早已按这个口径，两处必须一致）。
  if (content.some((b) => ["image", "document"].includes(str(asRecord(b)?.type)))) return true;
  const text = content.map((b) => str(asRecord(b)?.text)).join("");
  return text.trim() !== "" && !isLocalCommandEcho(text);
}

/**
 * 把推导出来的回合用量贴回消息列表：只贴该回合**最后一条**已完成回答。
 *
 * 同一个 ts 可能有多条 assistant（一条消息里的多个 text 块共享时间戳），
 * 从后往前扫、每个 ts 只用一次，保证贴在「答案那一段」上。
 */
export function attachTurnUsage(items: Item[], turns: TranscriptTurn[]): Item[] {
  if (turns.length === 0) return items;
  const byTs = new Map<number, TurnUsage>();
  for (const t of turns) byTs.set(t.ts, t.turn);
  const used = new Set<number>();
  let out = items;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it.kind !== "assistant" || it.streaming) continue;
    const turn = byTs.get(it.ts);
    if (!turn || used.has(it.ts)) continue;
    used.add(it.ts);
    if (out === items) out = items.slice();
    out[i] = { ...it, turn };
  }
  return out;
}

/**
 * 把本回合的用量回填到该回合最后一条回答上。
 *
 * 为什么挂在回答上而不是只在 result 条里：「本轮花了多少」是看答案时的自然问题，
 * 答案那一行（复制按钮旁）就是最顺手的位置；result 条只在末尾，翻上去就看不见了。
 * 只认**最后一条已完成的 assistant**：中间的过渡正文（后面还跟着工具调用）不挂，
 * 免得同一个回合到处是重复的耗时。
 *
 * 只在「最后一条用户消息之后」找：纯工具回合（只有工具调用、没有正文）从列表末尾
 * 一路往前扫，会把**上一回合**的答案挂上这一回合的耗时。
 */
function stampTurnUsage(items: Item[], turn: { durationMs?: number; usage?: UsageSnapshot }): Item[] {
  if (turn.durationMs === undefined && turn.usage === undefined) return items;
  let start = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    // 插话不切轮（与 `lib/process.turnSpans` 同一套锚点）：按它取起点会漏掉插话之前
    // 那几条回答，而它们同属这一回合。
    const it = items[i];
    if (it.kind === "user" && !it.interjected) {
      start = i + 1;
      break;
    }
  }
  for (let i = items.length - 1; i >= start; i -= 1) {
    const it = items[i];
    if (it.kind !== "assistant" || it.streaming) continue;
    const next = items.slice();
    next[i] = { ...it, turn };
    return next;
  }
  return items;
}

/**
 * result 的原因是否已经由那条「API Error」assistant 消息展示过。
 *
 * 只认最后一条 assistant 且带 `apiError` 标记：正常回答里恰好包含同样的字时
 * 不该把 result 的原因吞掉（那是另一件事）。
 */
function repeatedByApiErrorAnswer(items: Item[], reason: string): boolean {
  const last = [...items].reverse().find((it) => it.kind === "assistant");
  if (!last || last.kind !== "assistant" || !last.apiError) return false;
  const answer = last.text.trim();
  return answer !== "" && reason.trim().includes(answer);
}

function applyResult(items: Item[], m: Raw, at: number, usageHint?: UsageSnapshot): Item[] {
  const denials = Array.isArray(m.permission_denials) ? (m.permission_denials as unknown[]) : [];
  const raw = typeof m.result === "string" ? m.result : "";
  const errors = Array.isArray(m.errors)
    ? m.errors.filter((e): e is string => typeof e === "string")
    : [];
  // 用户中断时 CLI 会把这一轮判成失败（subtype=error_during_execution），**而且不写
  // result.result**——诊断只在 errors 数组里：
  //   `[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null`
  // （「最后一条消息是 user、stop_reason 是 null / tool_use」正是中断的形态）。
  // 只看 result.result 会漏掉整类（界面上照样弹「本轮出错 + 诊断」，踩过）。
  //
  // 判据有两条，任一成立即视为中断：
  //   ① 错误文本全部是这段诊断，且 result_type=user —— 标记可能和 tool_result 合并、
  //      也可能晚到，靠诊断本身也能认出来；
  //   ② 本回合收到过中断标记，且 result 的原因就是标记本身。
  // 真正的 API 报错一定还会带自己的原因（「API Error: …」），不会被吞。
  const shown = stripAnsi(raw || errors.join("\n")).trim();
  const diagnosticOnly =
    shown !== "" &&
    shown.split("\n").every((line) => !line.trim() || line.trim().startsWith("[ede_diagnostic]"));
  const userTerminated = diagnosticOnly && /result_type=user\b/.test(shown);
  const interrupted =
    m.is_error === true &&
    (userTerminated || (isInterruptMarker(shown) && interruptedThisTurn(items)));
  const isError = m.is_error === true && !interrupted;
  // 失败原因就在 result / errors 里（API 报错、超出最大轮数…）。成功回合的 result
  // 与最后一条 assistant 正文是同一段话，只在出错时展示，免得同一段出现两遍。
  // 上游 API 报错是同一个道理的第二遍：CLI 先把「API Error: …」作为一条 assistant 消息
  // 发下来，result 里又给同一段原因。这里只留上面那条消息，不再重复一次。
  const reason = isError ? stripAnsi(raw || errors.join("\n")) : "";
  const text = reason && !repeatedByApiErrorAnswer(items, reason) ? reason : "";
  const usage = applyUsageMessage(undefined, m);
  // tok/s 用的是「最近一次请求」的 genMs/genTokens（见 lib/usage 的文件头）：result 的
  // 整轮累计里没有这一对，只能从流式阶段那份快照借过来。不借的话实时回合的回答下面
  // 永远少一段「· 210 tok/s」，而重开对话走转录回放反而有。
  if (usage && usageHint) {
    if (usageHint.genMs !== undefined) usage.genMs = usageHint.genMs;
    if (usageHint.genTokens !== undefined) usage.genTokens = usageHint.genTokens;
  }
  // 回合结束（成功/失败/中断都一样）：悬着的流式气泡必须收尾，否则光标永远在闪。
  const out = stampTurnUsage(settleStreaming(items), {
    durationMs: typeof m.duration_ms === "number" ? m.duration_ms : undefined,
    usage,
  });
  return [
    ...out,
    {
      id: nextId(),
      seq: seqOf(out),
      ts: at,
      kind: "result",
      costUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined,
      durationMs: typeof m.duration_ms === "number" ? m.duration_ms : undefined,
      isError,
      subtype: interrupted ? "interrupt" : typeof m.subtype === "string" ? m.subtype : undefined,
      text: text || undefined,
      denials,
      usage,
    },
  ];
}

function applySystem(items: Item[], m: Raw, at: number): Item[] {
  // init 只用于填充顶栏元信息，不进消息流；status 同理。
  if (m.subtype === "init" || m.subtype === "status") return items;
  // 上下文压缩是回合之间真实发生过的事，转录里也有；不显示的话用户会以为
  // 历史无缘无故变短了。
  if (m.subtype === "compact_boundary") {
    const meta = asRecord(m.compact_metadata);
    const trigger = meta?.trigger === "manual" ? "手动" : "自动";
    const pre =
      typeof meta?.pre_tokens === "number" ? `，压缩前 ${formatTokens(meta.pre_tokens)} tokens` : "";
    return [
      ...items,
      {
        id: nextId(),
        seq: seqOf(items),
        ts: at,
        kind: "system",
        subtype: "compact_boundary",
        text: `上下文已${trigger}压缩${pre}`,
      },
    ];
  }
  // 本地命令回显也可能走 system 通道，同样整条丢弃。
  if (typeof m.content === "string" && isLocalCommandEcho(m.content)) return items;
  // hooks 输出等以 system + content 字符串形式上送，需要展示（并清洗 ANSI）。
  if (typeof m.content === "string" && m.content) {
    return [
      ...items,
      {
        id: nextId(),
        seq: seqOf(items),
        ts: at,
        kind: "system",
        subtype: typeof m.subtype === "string" ? m.subtype : undefined,
        text: stripAnsi(m.content),
      },
    ];
  }
  return items;
}

// CSI（颜色/光标/清屏）、OSC（窗口标题、超链接）、其余单字符 ESC 序列。
// 只清颜色不够用：进度条、光标控制、超链接都会出现在 hooks 输出里，
// 留在正文里就是一堆 `[2K`、`]8;;` 之类的乱码。
// eslint-disable-next-line no-control-regex
const OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// eslint-disable-next-line no-control-regex
const CSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESC_RE = /\u001b[@-_]/g;

/** 去掉终端转义，并把 `\r` 覆盖还原成最终那一版（进度条会把同一行刷很多遍）。 */
export function stripAnsi(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(OSC_RE, "")
    .replace(CSI_RE, "")
    .replace(ESC_RE, "")
    .split("\n")
    .map((line) => (line.includes("\r") ? line.slice(line.lastIndexOf("\r") + 1) : line))
    .join("\n");
}

/**
 * 本地插入一条用户消息（不等后端回显）。
 *
 * `interjected` 标出「这是插话」（`priority=now`）：它并入当前回合，**不切轮**。
 * 切轮规则见 `lib/process.turnSpans` 与 `lib/turns.turnsOf`。
 */
export function appendUser(items: Item[], text: string, images?: UserImage[], interjected = false): Item[] {
  const item: Item = {
    id: nextId(),
    seq: seqOf(items),
    ts: Date.now(),
    kind: "user",
    text,
    ...(images !== undefined && images.length > 0 ? { images } : {}),
    ...(interjected ? { interjected: true } : {}),
  };
  return [...items, item];
}

/**
 * 把「别的设备发出的提示词」补进本机消息流（后端 `prompt.echo`）。
 *
 * 用户气泡是本地乐观插入的，CLI 又不回显 stdin 里的消息：不补这一步，另一台设备
 * 上只会看到模型突然开始思考，用户发的那句话不见了。
 *
 * 去重规则与 CLI 回显那条路一致（`samePromptEcho`）：本机自己发的连接也会收到这条
 * 广播，它最后一条气泡就是这句话，命中后原样返回。`label` 是本机界面的「附件：」文案
 * （发送方那台设备的语言可能不同，所以文案由收到的一方决定）。
 */
export function appendPromptEcho(
  items: Item[],
  echo: { text?: string; files?: string[]; images?: UserImage[]; interjected?: boolean },
  label = "附件：",
): Item[] {
  const prompt = (echo.text ?? "").trim();
  const files = (echo.files ?? []).filter((name) => name !== "");
  const images = echo.images ?? [];
  const text = [prompt, ...files.map((name) => `${label}${name}`)].filter(Boolean).join("\n");
  if (!text && images.length === 0) return items;
  const last = items[items.length - 1];
  // 本机刚插过同一条：不重复。图片消息两边都可以没有正文，靠「都有图片」认出来。
  if (
    last &&
    last.kind === "user" &&
    (samePromptEcho(last.text, prompt) || (images.length > 0 && last.text === "" && (last.images?.length ?? 0) > 0))
  ) {
    return items;
  }
  return [
    ...items,
    {
      id: nextId(),
      seq: seqOf(items),
      ts: Date.now(),
      kind: "user",
      text,
      ...(images.length > 0 ? { images } : {}),
      // 别的设备插的一句话：同样并进当前回合，不切轮（跟本机发送那条一个口径）。
      ...(echo.interjected ? { interjected: true } : {}),
    },
  ];
}

/** 在列表开头插一条系统提示（例如「更早的消息已省略」）。 */
export function prependSystem(items: Item[], text: string): Item[] {
  const ts = items[0]?.ts ?? Date.now();
  return [
    { id: nextId(), seq: (items[0]?.seq ?? 0) - 1, ts, kind: "system", text },
    ...items,
  ];
}

/** 本地插入一条错误提示。 */
export function appendError(items: Item[], text: string): Item[] {
  return [...items, { id: nextId(), seq: seqOf(items), ts: Date.now(), kind: "error", text }];
}
