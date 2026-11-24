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
  compactMetaOf,
  contextTokens,
  formatTokens,
  totalsFromUsage,
  type UsageSnapshot,
} from "./usage";
import { interruptReason, isTurnHead } from "./model";
import type { Item, SubagentInfo, ToolImage, TurnUsage, UserImage } from "./model";
import type { CommandInfo } from "../transport/types";
import { isInjectedUserRow, splitContinuation } from "./continuation";
import {
  interjectedPromptRows,
  isImageAnnotation,
  isInterruptMarker,
  isLocalCommandEcho,
  isPromptRow,
  isTaskNotification,
} from "./transcriptRows";

// 这几条判定原本就定义在本文件里，挪到 `transcriptRows.ts` 是为了让 `usage.ts` 也能
// 共用同一份（它不能反向 import 本文件，会成环）。对外仍然从这里导出，调用方不用改。
export {
  interjectedPromptRows,
  isImageAnnotation,
  isInterruptMarker,
  isLocalCommandEcho,
  isTaskNotification,
} from "./transcriptRows";

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
 * `system/commands_changed` 的斜杠命令列表；不是这条消息就返回 undefined。
 *
 * CLI 的语义是**替换**整份缓存列表（会话中途发现新技能、加载了插件都会推它）。
 * 不进消息流：它只影响 `/` 菜单，渲染成一条系统提示只是噪音。
 */
export function commandsChanged(msg: unknown): CommandInfo[] | undefined {
  const m = asRecord(msg);
  if (!m || m.type !== "system" || m.subtype !== "commands_changed") return undefined;
  if (!Array.isArray(m.commands)) return undefined;
  return m.commands
    .map((c) => asRecord(c))
    .filter((c): c is Raw => !!c && typeof c.name === "string" && c.name !== "")
    .map((c) => ({
      name: c.name as string,
      ...(typeof c.description === "string" ? { description: c.description } : {}),
      ...(typeof c.argumentHint === "string" ? { argumentHint: c.argumentHint } : {}),
      ...(typeof c.builtin === "boolean" ? { builtin: c.builtin } : {}),
    }));
}

/**
 * applyCLI 的调用方式选项。
 *
 * `replay` 表示「这是磁盘上的转录回放」，而不是实时流：**回显去重必须关掉**。
 * 那套去重（`echoAlreadyShown`）存在的理由是「本地已经乐观插过一条气泡，CLI 又把
 * 同一句回显了一遍」——只有实时路径有本地气泡。转录里的每一条 user 行都是真的发过的，
 * 而且转录**没有 `result` 行**（claude 只把 result 写 stdout），按 result 划的轮边界
 * 永远触发不到，于是「上一轮说过同样一句话」会被整段历史比对吞掉（实测一份真实转录里
 * `提交修改` 发了 4 次，回放后只剩 1 条）。
 */
export interface ApplyOptions {
  replay?: boolean;
  /**
   * 允许 sidechain 行（`isSidechain: true`）。
   *
   * 只给**子代理自己的转录**用：那份文件里的每一行都是 sidechain，主消息流才要丢掉它们。
   * 少了这个开关，「查看子代理对话」重启后会读到一份空转录（界面显示「子代理还没有输出」）。
   */
  sidechain?: boolean;
  /**
   * 这一行是**插话**（`priority=now`），不是新一轮的开始。
   *
   * 实时路径靠 `prompt.echo` 的 `interjected` 拿到它；转录回放里没有这个字段，
   * 由 `interjectedPromptRows` 先扫一遍标出来再逐行传进来（见该函数的注释）。
   * 转录回放**必须**带上它，否则重进前端时插话会把整轮劈成两段。
   */
  interjected?: boolean;
}

/**
 * 处理一条 CLI 原始消息，返回新的列表（不修改入参）。
 *
 * `at` 用于回放历史转录时保留原始时间，不传则用当前时间。
 * `usageHint` 是实时流里已经攒下的用量快照（store 的 `usage[sid]`）：`result` 的整轮
 * 口径里没有生成耗时，回答下面那行的 tok/s 只能从流式阶段量到的 turnGenMs / turnGenTokens
 * 借（本回合一次都没量到时退回最近一次请求的 genMs / genTokens）。
 */
export function applyCLI(
  items: Item[],
  msg: unknown,
  at = Date.now(),
  usageHint?: UsageSnapshot,
  opts: ApplyOptions = {},
): Item[] {
  const m = asRecord(msg);
  if (!m) return items;
  // sidechain（子代理）与 meta 行一律不进主消息流。实时流里 store 已分流子代理帧，
  // 但**转录回放**是把 jsonl 逐行喂进来：CLI 会给同一句话补一条 `isMeta: true` 的
  // 伴随行（`turnCompanion`，例如把附加的图片/路径写成一句 `[Image: source: …]`），
  // 不挡的话它会被当成用户又发了一句，气泡里凭空多出一条 `[Image: source: /tmp/…]`，
  // 而且轮次刻度也跟着多一格。
  if ((m.isSidechain === true && opts.sidechain !== true) || m.isMeta === true) return items;
  // 压缩之后 CLI 会把摘要当一条 user 行塞回上下文（`isCompactSummary` /
  // `isVisibleInTranscriptOnly`）。它是给模型看的续接提示，不是用户说的话——
  // 不挡的话界面里就是一条占满半屏的英文摘要气泡（见 lib/continuation.ts）。
  if (m.type === "user" && isInjectedUserRow(m)) return items;
  switch (m.type) {
    case "stream_event":
      return applyStreamEvent(items, m, at);
    case "assistant":
      return applyAssistant(items, m, at);
    case "user":
      return applyUser(items, m, at, opts);
    case "result":
      return applyResult(items, m, at, usageHint);
    case "system":
      // 任务事件（子代理 / 后台命令）要先折进对应的工具卡片，再走通用 system 渲染。
      return applyTaskEvent(items, m, at) ?? applySystem(items, m, at);
    case "conversation_reset":
      // `/clear`（以及退出计划模式时选「清空上下文」）让 CLI 丢掉整份对话历史。
      // 这是**用户必须知道**的事：他的上下文被清空了，而界面上还留着清空前的消息。
      // 不显示的话，「刚才说过的话模型怎么不记得了」完全无从解释。
      return [
        ...items,
        {
          id: nextId(),
          seq: seqOf(items),
          ts: at,
          kind: "system",
          subtype: "conversation_reset",
          text: resetText(m),
        },
      ];
    case "tool_progress":
      return applyToolProgress(items, m);
    default:
      return items;
  }
}

const NOTIFY_STATUS: Record<string, SubagentInfo["status"]> = {
  completed: "completed",
  failed: "failed",
  error: "failed",
  killed: "stopped",
  stopped: "stopped",
  cancelled: "stopped",
  running: "running",
  in_progress: "running",
};

/**
 * 把 `<task-notification>` 的结论折进对应的 Agent 卡片。
 *
 * **后台子代理的完成只在这里**：`run_in_background` 的 Agent，tool_result 只是一条
 * 启动回执（见 subagentFromResult），真正的 status / usage / summary 随这条通知到达。
 * 而它**同时是转录里唯一的一份**——主 jsonl 没有 `system/task_*` 行（实测整份转录里
 * 一条 system 都没有），所以回放历史时也靠它，否则重开对话后那条子代理永远停在
 * 「运行中」。
 *
 * **同一种通知也发给后台命令与 MCP 调用**（它们与子代理共用 `task_*`），所以只认
 * 本来就在跑子代理的卡片，或者本身是 Agent 调用的卡片：给一条后台命令补上
 * `subagent` 就等于把它塞进页头的「子智能体」列表。回放时尤其容易踩——转录里没有
 * `task_started`，Bash 卡片上压根没有子代理信息，这条通知就是唯一的「身份来源」。
 *
 * **折完不能整条丢掉，要留一条 `wake`**（见 `WakeItem`）：CLI 把每次通知都算作
 * **新的一轮**（真实转录里 `turnPosition.turnIndex` 在这里递增、`promptIndex` 不变）。
 * 丢掉的话这几段会被并进上一个回合，界面上就是「主任务暂时收尾时挂上『已完成』并
 * 收起思考 → 子代理回报后又重新铺开」，中间那段过渡正文的用量还留在旧轮下面。
 */
function applyTaskNotification(items: Item[], text: string, at: number): Item[] {
  const t = text.trim();
  const status = NOTIFY_STATUS[tagValue(t, "status") ?? ""];
  const toolUseId = tagValue(t, "tool-use-id");
  const summary = tagValue(t, "summary");
  const usageMatch = SUBAGENT_USAGE_RE.exec(t);
  // 匹配不到 tool_use_id 时回落 task-id（后台子代理的通知里两者都有，task-id 就是 agentId）。
  const taskId = tagValue(t, "task-id");
  // 认不出状态也认不出用量的，不是任务通知（只是恰好长得像）：整条不动，
  // 留给下面的通用分支按普通文本处理——凭空造一轮比漏一条更糟。
  if (!status && !usageMatch) return items;

  const folded = items.map((it) => {
    if (it.kind !== "tool") return it;
    // 通知可能先于 tool_result 到达：Agent 卡片此时还没有 `subagent`，按 task-id 建一个。
    if (!it.subagent && !isAgentTool(it.name)) return it;
    const prev: SubagentInfo = it.subagent ?? { taskId: taskId ?? "", status: "running" };
    const hit =
      (toolUseId !== undefined && it.toolUseId === toolUseId) ||
      (taskId !== undefined && (prev.taskId === taskId || prev.agentId === taskId));
    if (!hit) return it;
    const next: SubagentInfo = { ...prev };
    if (status) next.status = status;
    if (summary) next.summary = summary;
    if (usageMatch) {
      next.usage = {
        totalTokens: Number(usageMatch[1]),
        toolUses: Number(usageMatch[2]),
        durationMs: Number(usageMatch[3]),
      };
    }
    return { ...it, subagent: next };
  });

  return [
    ...folded,
    {
      id: nextId(),
      seq: seqOf(folded),
      ts: at,
      kind: "wake",
      origin: "task",
      ...(taskId ? { taskId } : {}),
      ...(toolUseId ? { toolUseId } : {}),
      ...(summary ? { summary } : {}),
      ...(status ? { status } : {}),
      text: t,
    },
  ];
}

/**
 * 这一轮**跑完了吗**（最后一条内容之后有 result）。
 *
 * 与 `lib/process.turnSpans` 的 `settledByResult` 同一个口径，只是按需算一次
 * （不 import process：process 依赖 model，normalize 再 import process 会成环）。
 *
 * 用途只有一个：实时收到 `task_notification` 时判它**开没开新一轮**——
 * 没开就一条 Item 都不造（见 `applyTaskEvent`）。
 */
function currentTurnSettled(items: Item[]): boolean {
  let lastResult = -1;
  let lastActivity = -1;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    // 走到本轮的轮首就停：只判最后这一轮。
    if (i > 0 && isTurnHead(it)) break;
    if (it.kind === "result") {
      lastResult = i;
      continue;
    }
    if (it.kind === "assistant" && it.text.trim() === "") continue;
    lastActivity = i;
  }
  return lastResult >= 0 && lastResult > lastActivity;
}

/** 取 `<tag>…</tag>` 里的文本（任务通知是一份扁平 XML，不需要通用解析器）。 */
function tagValue(text: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m?.[1]?.trim() || undefined;
}

/**
 * 回合结束或连接断开时，把还挂着的流式气泡收尾。
 *
 * 只有完整 assistant 消息到达才会摘掉 `streaming`；一旦这一轮没有完整消息
 * （用户中断、进程崩溃、结果里只有错误），气泡会一直显示流式光标，看起来像还在写。
 *
 * **思考气泡同样要收**：`thinking_delta` 走的是同一套流式标记，不一起收的话，
 * 一轮被中断时那个思考块会永远显示「还在写」。
 */
export function settleStreaming(items: Item[]): Item[] {
  let changed = false;
  const out = items.map((it) => {
    if ((it.kind !== "assistant" && it.kind !== "thinking") || !it.streaming) return it;
    changed = true;
    return { ...it, streaming: false };
  });
  return changed ? out : items;
}

/**
 * 转录回放之后，用子代理的收尾状态（`meta.json` 的 `finished`）结算还挂在
 * 「运行中」的 Agent 卡片。
 *
 * 为什么需要：主转录里**没有** `system/task_*` 行，后台子代理的结论只靠
 * `<task-notification>` 那条 user 行；而被中断（TaskStop）的子代理**根本不写通知**，
 * 于是重开对话后它们永远停在 `running`——页头上一直转圈（截图复现过）。
 *
 * **只把 `running` 收成 `stopped`，不改其它状态**：
 *   - `finished` 只说明「claude 收尾了」，不说明成功。能拿到通知的早就被
 *     `applyTaskNotification` 标成 completed/failed/stopped 了，这里轮到的一定是
 *     「收尾了但没有通知」——中断、进程被杀、或通知帧丢了。统一记「已停止」，
 *     比猜成「完成」（绿点）诚实：用户看到的是一次被打断的活儿。
 *   - `finished` 为 false 的（正在跑）保持 `running`，别把活着的任务标成结束。
 */
export function settleSubagents(
  items: Item[],
  states:
    | ReadonlyArray<{
        agent_id: string;
        tool_use_id?: string;
        finished: boolean;
        tokens?: number;
        total_tokens?: number;
        ended_at?: number;
      }>
    | undefined,
): Item[] {
  if (!states || states.length === 0) return items;
  const byAgent = new Map<string, (typeof states)[number]>();
  const byTool = new Map<string, (typeof states)[number]>();
  for (const s of states) {
    if (s.agent_id) byAgent.set(s.agent_id, s);
    if (s.tool_use_id) byTool.set(s.tool_use_id, s);
  }
  let changed = false;
  const out = items.map((it) => {
    if (it.kind !== "tool" || !it.subagent) return it;
    const sub = it.subagent;
    const state =
      (sub.agentId !== undefined ? byAgent.get(sub.agentId) : undefined) ??
      (sub.taskId !== "" ? byAgent.get(sub.taskId) : undefined) ??
      byTool.get(it.toolUseId);
    if (!state) return it;
    let next = sub;
    if (state.finished && sub.status === "running") next = { ...next, status: "stopped" as const };
    // 用量/收尾时刻在**重启之后**只能从子代理转录恢复：后台子代理的 usage 只在
    // stdout 的 task_notification 里，而主转录那条 <task-notification> 不带 <usage>。
    //
    // **两种口径分开存**（见 SubagentInfo.usage 的注释）：
    //   - `totalTokens` 是「最后一次请求」，CLI 的进度帧与结束通知给的就是它；
    //   - `consumedTokens` 是累计消耗，只有从转录整份扫才拿得到，界面上要的是它。
    //
    // 累计值**以后端这份为准**：实时跑着时只能在收到 `task_progress` 的那一刻累加，
    // 而没有工具调用的纯思考请求一条进度帧都不发，那些 token 实时路径根本数不到
    // （实测同一份子代理：实时累加 236K vs 转录真值 252K）。所以只要后端给出了
    // `total_tokens` 就覆盖掉估算值——它不是「另一份同源副本」，是更全的那一份。
    const usage = next.usage;
    const patch: Partial<NonNullable<SubagentInfo["usage"]>> = {};
    if (state.tokens !== undefined && state.tokens > 0 && !usage) patch.totalTokens = state.tokens;
    if (state.total_tokens !== undefined && state.total_tokens > 0) patch.consumedTokens = state.total_tokens;
    if (Object.keys(patch).length > 0) {
      next = { ...next, usage: { totalTokens: 0, ...usage, ...patch } };
    }
    if (state.ended_at !== undefined && state.ended_at > 0) next = { ...next, endedAt: state.ended_at };
    if (next === sub) return it;
    changed = true;
    return { ...it, subagent: next };
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
  if (!delta) return items;

  // 思考的逐字增量。**必须单独处理**：只认 text_delta 时，模型长时间思考（几十秒
  // 到几分钟）界面上完全静止，要等完整 assistant 消息到齐思考块才出现——用户会
  // 以为会话卡死。思考与正文是两种块，各自维护自己的流式气泡。
  if (delta.type === "thinking_delta") {
    const piece = typeof delta.thinking === "string" ? delta.thinking : "";
    if (!piece) return items;
    const last = items[items.length - 1];
    const open = last && last.kind === "thinking" && last.streaming ? last : null;
    // 纯空白的增量**不能自己开一个气泡**：上游在工具调用之间会发 `" "`/`"\n"`，
    // 开出来就是一行「思考过程 · 0 字」，点开是个空格（截图复现过）。
    // 已经有气泡时照常追加——那是思考中间的换行/缩进，丢了会把段落粘在一起。
    if (!open && !piece.trim()) return items;
    if (open) {
      return [...items.slice(0, -1), { ...open, text: open.text + piece }];
    }
    return [
      ...items,
      { id: nextId(), seq: seqOf(items), ts: at, kind: "thinking", text: piece, streaming: true },
    ];
  }

  if (delta.type !== "text_delta" || typeof delta.text !== "string") return items;

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

/**
 * 摘掉列表里所有「还在流」的思考气泡，返回新列表与它们拼起来的文字。
 *
 * 完整 assistant 消息到达时，思考的**完整内容**在它自己的 thinking 块里；留着流式
 * 那一份会让同一段思考出现两遍。与正文流式气泡的处理同理，只是两者各管各的。
 */
function takeStreamingThoughts(items: Item[]): { rest: Item[]; leftover: string; at: number } {
  const rest: Item[] = [];
  let leftover = "";
  let at = -1;
  for (const it of items) {
    if (it.kind === "thinking" && it.streaming) {
      if (at < 0) at = rest.length;
      leftover += it.text;
      continue;
    }
    rest.push(it);
  }
  return { rest, leftover, at };
}


function applyAssistant(items: Item[], m: Raw, at: number): Item[] {
  const message = asRecord(m.message);
  const content = message?.content;
  const blocks = Array.isArray(content) ? content : [];
  // 这条消息是哪次请求的产物：轨迹面板按它标泳道（同一轮里换过模型时两条清晰可辨）。
  // 不走流式增量那条路——`content_block_delta` 里没有模型名，只能等完整消息。
  const model = typeof message?.model === "string" ? message.model : "";
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

  // 思考的流式气泡同样要先摘掉：完整消息里带着完整 thinking 块，留着会显示两遍。
  // 它和正文的流式气泡是两种块，各自记录自己的残留文字与插入位置。
  const thought = takeStreamingThoughts(out);
  out = thought.rest;
  let thoughtInsertAt = thought.at;
  if (thoughtInsertAt < 0) thoughtInsertAt = out.length;
  let thoughtCount = 0;

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
          ...(model ? { model } : {}),
        },
      ];
    } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
      // 只认**非空白**内容：上游在工具调用之间常发一个 `" "`（实测一次会话里 57 条），
      // 渲染出来就是一行「思考过程 · 1 字」，点开是个空格——既没信息也点不动。
      if (prevKind === "thinking" && prevText === block.thinking) continue;
      prevKind = "thinking";
      prevText = block.thinking;
      thoughtCount += 1;
      out = [
        ...out,
        {
          id: nextId(),
          seq: seqOf(out),
          ts: at,
          kind: "thinking",
          text: block.thinking,
          ...(model ? { model } : {}),
        },
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
            ? { ...it, name: block.name as string, input: block.input, placeholder: false }
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
      {
        id: nextId(),
        seq: seqOf(out),
        ts: at,
        kind: "assistant",
        text: leftover,
        streaming: false,
        ...(apiError ? { apiError } : {}),
        ...(model ? { model } : {}),
      },
      ...out.slice(insertAt),
    ];
  }
  // 思考同理：只有 thinking_delta、完整消息里却没有 thinking 块时，把已收到的补回去。
  // 补回去之前**也要过空白判断**：上游只发过一个 `" "` 的话，这里补出来的就是一行
  // 「思考过程 · 0 字」（上面开气泡那条已经挡了一层，但气泡可能更早就开出来过）。
  if (thoughtCount === 0 && thought.leftover.trim()) {
    out = [
      ...out.slice(0, thoughtInsertAt),
      {
        id: nextId(),
        seq: seqOf(out),
        ts: at,
        kind: "thinking",
        text: thought.leftover,
        streaming: false,
        ...(model ? { model } : {}),
      },
      ...out.slice(thoughtInsertAt),
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
        // 占位卡：真正的 tool_use 还没到，时间戳是 task 事件的时刻（不是请求落盘）。
        placeholder: true,
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
    // 运行中的进度：更新用量与「一行进度」，状态保持 running。
    //
    // 两行文字各有来源，**不能只取 summary**：
    //   - `summary` 是模型生成的进度摘要（initialize 的 `agentProgressSummaries`），
    //     语义最好，但它需要一次额外的模型请求、CLI 把整份子代理上下文 fork 进去。
    //     实测 2.1.330 + 自建中转：模型无视提示词里的 "Do not use tools" 直接调工具，
    //     那一次请求白花、一个子代理跑到底 `summary` 一条都没有（4 次尝试全空）。
    //   - `description` + `last_tool_name` 是 CLI 自己的活动描述，随每次工具调用变，
    //     不花请求、从不缺席（`"Reading b.txt"` / `Bash`）。它是唯一可靠的兜底。
    // 只认 summary 的话，页头上那一行在多数中转上是永久空的。
    next.summary = str(m.summary) || prev.summary;
    const description = str(m.description);
    const lastTool = str(m.last_tool_name);
    // 只有真的换了活动才写：这条帧每次工具调用都会来，秒数还一直变，
    // 无脑覆盖会让 React 每帧都认为对象变了。
    if (description && description !== prev.progressText) {
      next.progressText = description;
      next.progressTool = lastTool || undefined;
    } else if (lastTool && !prev.progressTool) {
      next.progressTool = lastTool;
    }
    const usage = asRecord(m.usage);
    if (usage) {
      const total = int(usage.total_tokens) ?? 0;
      const tools = int(usage.tool_uses) ?? 0;
      next.usage = {
        totalTokens: total,
        toolUses: tools,
        durationMs: int(usage.duration_ms) ?? 0,
        // **实时累计**：CLI 的 `total_tokens` 只是「最后一次请求的上下文有多大」，
        // 直接报它会把一个大任务说成「只花了 10K」（实测 97 次请求的真实消耗是
        // 单次的 70 倍）。这里按 `tool_uses` 的增长把它累加成用户要看的那份。
        //
        // 为什么拿 `tool_uses` 当增量信号：它是 CLI 那侧单调递增的请求计数
        // （每完成一次请求 +1），比「自己去重 message.id」稳——流式阶段同一条
        // 消息会多发几帧，按内容判会重复计数。
        //
        // 与后端扫转录的权威值差几个百分点（没有工具调用的纯思考请求不发进度帧，
        // 那些 token 这里数不到：实测 236K vs 252K）。跑到结束时后端那份会接上来
        // （见 `settleSubagents`），这里只负责「跑着的时候别显示得太离谱」。
        consumedTokens: accumulateConsumed(prev.usage, total, tools),
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
      const total = int(usage.total_tokens) ?? 0;
      next.usage = {
        totalTokens: total,
        toolUses: int(usage.tool_uses) ?? 0,
        durationMs: int(usage.duration_ms) ?? 0,
        // 结束通知里的 `total_tokens` 同样是「最后一次请求」，不是累计；
        // 跑着的过程中已经按进度帧累加过（见 task_progress 分支），保留那份更大的。
        consumedTokens: Math.max(prev.usage?.consumedTokens ?? 0, total) || undefined,
      };
    }
  }

  const folded = [...out.slice(0, index), { ...item, subagent: next }, ...out.slice(index + 1)];

  // `task_notification` 只有在**它真的开了一轮**时才是轮首，才需要留一条 `wake`。
  //
  // 转录里它是 CLI 注入的一条 user 行（`<task-notification>…`），走
  // `applyTaskNotification` 造 wake；但**实时流里没有那条 user 行**（实测 2.1.330：
  // 整份 stdout 里一次都没出现，它只落进磁盘转录）。只在实时侧漏掉它，界面上就是
  // 「刷新之后才多出那块『已完成』的触发条，而且轮次计数从 1 变 2」。
  // 实时唯一的那份信号就是这条 `system/task_notification`（帧序：notif → 新 init →
  // 唤醒轮的正文 → result），所以在这里补一条等价的 wake，两条路径各自造同一种 Item。
  //
  // **回合还在跑的时候什么都不造**（用户报过三次，最近一次截图里过程中间横着两条
  // 只剩「已完成」的框）：CLI 会把进行中到来的通知**吸收进当前回合**（转录里
  // `queue-operation` 的 `remove` 记的是 `reason: "absorbed_mid_turn"`——全库实测
  // 52 条通知全是它），既不切轮、也不递增 turnIndex，磁盘上根本不是 user 行
  // （只留一条 `queued_command` attachment，我们不渲染）——所以刷新之后它们凭空消失，
  // 与实时对不上。**「刷新会自动消失的东西」就是不该在实时流里造出来的东西。**
  //
  // 也不做「轮内一行轻量标记」那种折中（试过）：用户需要的信息在别处已经有了——
  // ① 上面 `folded` 已经把 status / usage / summary 折进了那张工具卡片，过程里本来
  // 就有一行「运行命令 … / 完成」/「Background agent test / 完成」；
  // ② 子代理还能点开看对话；
  // ③ 页头的「后台操作 N」「子智能体 N」在它跑着的时候一直都在。
  // 再往正文里插一行，无论有没有边框都是同一句话的第三遍——连排几条时尤其像噪音。
  //
  // 判据是「这一轮此刻收尾了没有」，与 `process.turnSpans` 的 `settledByResult` 同口径。
  if (subtype === "task_notification") {
    // 这一轮还在跑 → 吸收进当前回合：只保留折进卡片的那份结果，不产生任何消息项。
    if (!currentTurnSettled(folded)) return folded;
    const summary = str(m.summary);
    const status = subagentStatus(m.status) ?? next.status;
    // 名字的取法**要跟转录回放一致**，否则同一个子代理实时叫「已完成」、
    // 刷新之后才变成「子代理「Background sleep test」已完成」（用户截图复现）。
    // 回放那边 CLI 写的是 `Agent "名字" finished` 模板；实时帧的 `summary`
    // 对后台子代理常常是空串（二进制里就是 `summary: o?.summary ?? ""`），
    // 所以按 `wakeLabel` 认得的模板形状从卡片补一个——
    // 回放读的是同一个 `description`（Agent 的 tool_use 入参一直带着它），
    // 两边摘出来的名字因此必然一致。
    const wakeSummary = wakeSummaryFor(next, summary, item.input);
    return [
      ...folded,
      {
        id: nextId(),
        seq: seqOf(folded),
        ts: at,
        kind: "wake",
        origin: "task",
        taskId,
        ...(toolUseId ? { toolUseId } : {}),
        ...(wakeSummary ? { summary: wakeSummary } : {}),
        ...(status ? { status } : {}),
        // 实时流没有通知原文，点开也没有正文可看——留空串，渲染侧据此不摆那个展开区。
        text: "",
      },
    ];
  }

  return folded;
}

/**
 * 实时 `task_notification` → 触发条那一行的 `summary`，**形状与转录回放一致**。
 *
 * 两边的输入不一样，但必须产出同一种模板，否则同一个子代理在实时与刷新后长得不同：
 *   - **转录回放**：CLI 写进 jsonl 的 `summary` 是 `Agent "名字" finished`
 *     （后台命令是 `Background command "…" completed (exit code 0)`），名字就在引号里；
 *   - **实时帧**：同一个字段对后台子代理**常常是空串**（二进制里是
 *     `summary: o?.summary ?? ""`），或者是几千字的报告全文。
 *
 * 名字的唯一可靠来源是**卡片上的 `description`**（Agent 的 `tool_use` 入参一直带着它，
 * `task_started` 也会给），回放那边读的也是同一个值——所以按模板形状拼出来，
 * 两边摘出的名字必然相同。
 *
 * 只保留第一行前 40 字，避免把整份报告塞进 Item 常驻内存。
 */
function wakeSummaryFor(sub: SubagentInfo, live: string, input?: unknown): string {
  // 卡片上的 `description` 来自 `task_started`，而**后台子代理可能一条 task_started
  // 都没有**（它由 Agent 的 tool_use 直接起）。所以还要回落到那条 tool_use 的入参——
  // 转录回放读的也正是入参（`subagentEntries` 同一套兜底），两边才对得上。
  const raw = (sub.description || inputDescription(input) || sub.type || "").trim() || firstLine(live);
  const short = raw.split("\n").find((line) => line.trim())?.trim().slice(0, 40) ?? "";
  if (!short) return "";
  // 后台子代理与普通子代理的命令行模板不同，选哪个只影响 `wakeKind` 的角色词
  // （「后台子代理」还是「子代理」），两者都带引号，`wakeLabel` 都能摘出名字。
  return sub.background ? `Background agent "${short}" finished` : `Agent "${short}" finished`;
}

/** 从 Agent 的 tool_use 入参里取任务描述（`task_started` 缺失时的唯一来源）。 */
function inputDescription(input: unknown): string {
  const rec = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
  const v = rec?.description;
  return typeof v === "string" ? v : "";
}

/** 取第一段非空文本（报告全文只在第一行有意义）。 */
function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim()) ?? "";
}

/**
 * 实时累计用量：`task_progress` 的 `total_tokens` 是「这次请求的上下文」，
 * 按 `tool_uses` 的增长逐次累加。
 *
 * 返回值只在能确定「这是一次新请求」时才前进：`tool_uses` 没变（同一请求的多帧）
 * 或倒退（CLI 重启 / 换了计数口径）都保持原值，绝不重复累加。
 */
function accumulateConsumed(
  prev: SubagentInfo["usage"] | undefined,
  total: number,
  tools: number,
): number | undefined {
  const before = prev?.consumedTokens ?? 0;
  const beforeTools = prev?.toolUses;
  if (total <= 0) return before > 0 ? before : undefined;
  // 第一次拿到用量：直接以当前请求为准（它不是从 0 开始的）。
  if (beforeTools === undefined) return Math.max(before, total);
  if (tools <= beforeTools) return before > 0 ? before : total;
  // 增长了几次请求就加几份——一次跳两格（慢帧）时也按差值算。
  return before > 0 ? before + total : total;
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
  // 子代理正在重试（`subagent_retry`）：不带这条的话，重试期间卡片上的秒数照走，
  // 用户只看到「跑了很久」，看不出是在重试、第几次、为什么。
  const retry = asRecord(m.subagent_retry);
  const retryNote = retry
    ? [
        `重试第 ${int(retry.attempt) ?? 1}${int(retry.max_retries) !== undefined ? `/${int(retry.max_retries)}` : ""} 次`,
        int(retry.error_status) !== undefined ? `HTTP ${int(retry.error_status)}` : "",
        str(retry.error_category),
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  return items.map((it) =>
    it.kind === "tool" && it.toolUseId === toolUseId
      ? { ...it, progress: elapsed, ...(retryNote ? { progressNote: retryNote } : {}) }
      : it,
  );
}


const AGENT_ID_RE = /\bagentId:\s*([A-Za-z0-9_-]{1,128})/;
const SUBAGENT_USAGE_RE =
  /<usage>[\s\S]*?subagent_tokens:\s*(\d+)[\s\S]*?tool_uses:\s*(\d+)[\s\S]*?duration_ms:\s*(\d+)[\s\S]*?<\/usage>/;

/**
 * 这个工具是不是「起子代理」的那一个。
 *
 * 只有它们才该长出 `subagent` 卡片信息：同一种 `<task-notification>` 也发给后台命令
 * （`Bash` + `run_in_background`）与 MCP 调用，按它给所有工具卡片补子代理字段，
 * 页头的「子智能体 N」就会混进一堆后台命令。
 */
function isAgentTool(name: string): boolean {
  return name === "Agent" || name === "Task";
}

/**
 * 后台子代理的 tool_result 是**启动回执**，不是结果：
 * `Async agent launched successfully. … agentId: … The agent is working in the background.`
 *
 * 它带 `agentId:` 却不带 `<usage>`——那是唯一能把「已启动」与「跑完了」区分开的信号。
 */
const ASYNC_LAUNCH_RE = /Async agent launched successfully/;

/**
 * 从 Agent 工具的 tool_result 里读回 agentId 与用量。
 *
 * 回放历史时只有这段文本（主转录里没有 task_* 行），「查看子代理对话」要靠它。
 *
 * **只有带 `<usage>` 才算跑完**：`run_in_background` 的 Agent 一启动就回一条
 * 只带 agentId 的回执，把它判成 completed 会让卡片一出现就是绿点，真实的
 * status/usage 稍后才随 `<task-notification>` 到达（见 applyTaskNotification）。
 */
export function subagentFromResult(text: string, isError: boolean): Partial<SubagentInfo> | undefined {
  const idMatch = AGENT_ID_RE.exec(text);
  const usageMatch = SUBAGENT_USAGE_RE.exec(text);
  if (!idMatch && !usageMatch) return undefined;
  const launched = !usageMatch && ASYNC_LAUNCH_RE.test(text);
  const out: Partial<SubagentInfo> = {
    status: isError ? "failed" : launched ? "running" : "completed",
  };
  if (launched) out.background = true;
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

function applyUser(items: Item[], m: Raw, at: number, opts: ApplyOptions = {}): Item[] {
  const message = asRecord(m.message);
  const content = message?.content;
  const blocks = Array.isArray(content) ? content : [];
  const images = userImagesOf(blocks);
  const results = blocks.filter((b) => asRecord(b)?.type === "tool_result");
  // 上下文压缩后 CLI 会把续接提示**拼在用户下一句话前面**写成同一条 user 行
  // （见 lib/continuation.ts）。摘要是给模型看的，界面只该留用户真敲的那段；
  // 一个字的用户正文都没剩下时整条丢掉。
  const split = splitContinuation(textOfContent(content));
  if (split.injected && split.rest === "" && images.length === 0) return items;

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
          isAgentTool(it.name) ? subagentFromResult(text, isError) : undefined;
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
          // 结果落地时刻：轨迹面板画工具耗时就靠它（`ts` 是调用开始的时刻）。
          doneAt: at,
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

  // 附图注解（`[Image: source: …]` / `[Image: original …, displayed at …]`）：
  // 转录里它带 `isMeta`，实时流里**没有**（见 isImageAnnotation 上的注释），
  // 不挡的话每次 Read 一张图，用户气泡里就凭空多出一条英文注解。
  if (isImageAnnotation(textOfContent(content))) return items;

  // 后台任务通知同样是 CLI 注入的 user 行（`isMeta` 是 null，绕过顶上那道过滤）。
  // 不挡的话，停进对话里就多出一坨 `<task-notification>` 的原始 XML，还带着一串
  // task-id 与英文说明。
  // 先把结论折进卡片，再留一条 `wake`（它是**新的一轮**，见 WakeItem）：CLI 自己
  // 也是这么记的（turnIndex 在这里递增、promptIndex 不变），丢掉的话等待子代理的
  // 那几段会被并进上一个回合，界面上来回挂 / 撤「已完成」。
  if (isTaskNotification(textOfContent(content))) {
    // 转录里读得到这条 user 行 = 它确实开了一轮（被吸收的那种根本不写 user 行，
    // 只留一条 queued_command，见 `applyTaskEvent` 的注释）。所以这里不做额外判定。
    return applyTaskNotification(items, textOfContent(content), at);
  }

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
    const raw = promptBlocks.length > 0 ? textOfContent(promptBlocks) : "";
    // 续接提示与用户这句话拼在同一条里时，只留用户真敲的那段（见 applyUser 开头）。
    const prompt = splitContinuation(raw).rest;
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
    //
    // **转录回放不做这套判定**（`opts.replay`）：那边没有本地乐观气泡，每一条 user 行
    // 都是真的发过的，附件消息尤其容易被「上一轮同样那句话」吞掉。
    if (!opts.replay) {
      const onlyImages = prompt === "" && last?.kind === "user" && last.text === "" && (last.images?.length ?? 0) > 0;
      if (last && last.kind === "user" && (samePromptEcho(last.text, prompt) || (images.length > 0 && onlyImages))) {
        return items;
      }
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
        ...(opts.interjected ? { interjected: true } : {}),
      },
    ];
  }

  // 纯用户文本：本地发送时已经插过一条，这里按内容去重，避免重复。
  // 转录回放例外（见 `ApplyOptions.replay`）：那里的每条 user 行都是真的发过的。
  const text = split.rest;
  if (!text) return items;
  if (!opts.replay && echoAlreadyShown(items, text)) return items;
  return [
    ...items,
    {
      id: nextId(),
      seq: seqOf(items),
      ts: at,
      kind: "user",
      text,
      ...(opts.interjected ? { interjected: true } : {}),
    },
  ];
}

/**
 * 本地是不是已经插过这条用户消息了（CLI 回显 / 后端广播都走这一份判定）。
 *
 * **不能只看最后一条**：`items` 尾项是 thinking / tool 时（回合已经跑起来了）
 * 原来的判定直接失效。这在本机发的消息上不明显——那种情况回显紧跟着本地插入，
 * 尾巴就是那条气泡；但**插话**恰恰发生在回合进行中，本地气泡后面已经跟了一堆
 * 过程内容，于是回显被当成「又一条用户消息」插进来，把这一轮切成两半（前半截被
 * 当成「已完成」收起来、还冒出复制按钮）。
 *
 * 往回找的边界是**上一条 `result`**：一轮之内的本地气泡才算候选。跨过 result
 * 就是上一轮的事了，那里出现同样的话是用户真的又发了一遍，不能吞。
 *
 * `hasImages` 为真时，两条都没有正文的空文本消息也算同一条（图片消息两边都可能
 * 没有文字，只能靠「都有图」认）。
 *
 * `localOnly` 为真时只看**本机插入的**气泡（没有 `echoed` 标记）。`prompt.echo`
 * 的去重必须这样：补进来的那条也是 echo，把它算作候选的话，同一个设备连发两次同一句
 * 话时第二条广播会被吞掉，另一台设备上就少一条气泡。
 */
function echoAlreadyShown(items: Item[], text: string, hasImages = false, localOnly = false): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it.kind === "result") return false; // 出了这一轮：不跨轮比对
    if (it.kind !== "user") continue;
    if (localOnly && it.echoed) continue;
    if (samePromptEcho(it.text, text)) return true;
    if (hasImages && it.text === "" && (it.images?.length ?? 0) > 0) return true;
  }
  return false;
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
 *   - `api-request` 行 → 下一条 `assistant` 行的间隔 = 这次请求的 API 耗时
 *     （**含首字延迟**，所以只报耗时，不拿它算 tok/s，见 `lib/usage` 的
 *     `usageFromTranscript`）；
 *   - 用户提问行 → 本轮最后一条 assistant 行的时间差 = 整个回合的墙钟耗时
 *     （与 result.duration_ms 同一个口径）。
 *
 * 拿不到的数不编：缺 prompt 时间（转录被截断）就整轮跳过，缺 usage 就跳过该轮。
 *
 * 口径与实时路径一致：`contextTokens` 只取**最后一次请求**（上下文占用），
 * `turnInputTokens` / `outputTokens` / `apiMs` 是本轮所有请求之和（这一轮吃了多少）。
 */
export function turnsFromTranscript(lines: unknown[], interjectedUUIDs?: readonly string[]): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];
  let promptAt: number | undefined;
  let last: { ts: number; usage: UsageSnapshot } | undefined;
  let requestAt: number | undefined;
  // 本轮的累计消耗：一轮里可能有十几次请求，回答下面那行要的是它们的和。
  let turnIn = 0;
  let turnOut = 0;
  let turnApiMs = 0;
  // 插话由宿主机记账（`interjected_uuids`），不做任何推断——转录里区分不出来，
  // 见 transcriptRows.interjectedPromptRows 的注释（启发式在真实数据上 100% 误判）。
  const interjected = interjectedPromptRows(lines, interjectedUUIDs);

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

  for (let index = 0; index < lines.length; index += 1) {
    const line = asRecord(lines[index]);
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
      // 后台任务的唤醒通知也是**新的一轮**：CLI 自己就这么记（turnIndex 在这里递增、
      // promptIndex 不变）。不切的话，等待子代理的那一段耗时与用量会被并进上一个
      // 回合——界面上写着「已完成，用时 10 分 16 秒」，而那一整段其实是四次唤醒拼的。
      // 它与下面的提问行共用同一套「关掉上一轮、开新的一轮」逻辑。
      const wake = isTaskNotification(textOfContent(asRecord(line.message)?.content));
      if (!wake && !isPromptLine(line)) continue;
      // **插话不切轮**（与 `lib/process.turnSpans` 同一套锚点）：它并进当前回合，
      // 不是新的一轮。按它 closeTurn 的话，同一个回合会被拆成两段耗时与两份用量，
      // 而界面上它们是同一轮（轮次刻度、收起行都按「插话不切轮」算）。
      // 转录里没有 `priority` 标记，只能靠 `interjectedPromptRows` 认出来。
      if (!wake && interjected.has(index)) continue;
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
        },
      };
    }
  }
  closeTurn();
  // 没有时间戳的行（极老转录）会导致 ts=0，贴上去只会把耗时算成 1970 年。
  return out.filter((t) => t.ts > 0);
}

/**
 * 这条 user 行是用户的提问，而不是工具回包 / 本地命令回显 / CLI 注入的续接提示。
 *
 * 判定在 `transcriptRows.isPromptRow`：`usage.ts` 要用同一份规则，而它不能反向 import
 * 本文件（会成环）。别在本地另写一份。
 */
function isPromptLine(line: Raw): boolean {
  return isPromptRow(line);
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
  // 回答下面那行的速度用的是**本回合**的 Σ输出 ÷ Σ生成耗时（见 lib/usage 的
  // `turnThroughput`）：result 的整轮累计里没有生成耗时，只能从流式阶段那份快照借。
  // 不借的话实时回合的回答下面永远少一段「· 210 tok/s」，而重开对话走转录回放反而有。
  // （`speedSamples` 是跨轮的滚动窗口，回答这一行不报它——那是底栏速度计的口径。）
  if (usage && usageHint) {
    if (usageHint.turnGenMs !== undefined) usage.turnGenMs = usageHint.turnGenMs;
    if (usageHint.turnGenTokens !== undefined) usage.turnGenTokens = usageHint.turnGenTokens;
    // 本回合一次都没量到（中转没有增量帧 / 全是合并下发）时，退回最近一次真量到的
    // 请求——总比整行少一段强，而且它确实是测出来的数。
    if (usage.turnGenMs === undefined && usageHint.genMs !== undefined) {
      usage.genMs = usageHint.genMs;
      usage.genTokens = usageHint.genTokens;
    }
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
  const subtype = typeof m.subtype === "string" ? m.subtype : undefined;

  // init 只用于填充顶栏元信息，不进消息流。
  if (m.subtype === "init") return items;

  // status 平时只是 permissionMode 的载体（由 store 消费），但两处**必须显示**：
  //   - `compacting`：上下文压缩可能要跑几十秒（大上下文会话尤其），期间界面上
  //     什么都不动，用户会以为会话死了；
  //   - `compact_result: "failed"`：压缩失败是静默的数据损失（历史被截断却没压缩成），
  //     原因只在 `compact_error` 里。
  //
  // `compacting` 是**进行时**：压缩一收尾（`requesting` / `null`）就要把它摘掉，
  // 否则消息流里永远挂着一条「正在压缩上下文…」，紧接着下面又出现「上下文已手动压缩」，
  // 一次 `/compact` 之后两句话会一直叠在那里（截图复现过）。
  if (m.subtype === "status") {
    if (m.status === "compacting") {
      return pushOngoing(items, at, "status", "正在压缩上下文…");
    }
    if (m.compact_result === "failed") {
      const reason = typeof m.compact_error === "string" ? m.compact_error.trim() : "";
      return pushError(clearOngoing(items, "status"), at, reason ? `上下文压缩失败：${reason}` : "上下文压缩失败");
    }
    if (m.status === "requesting" || m.status === null) {
      return clearOngoing(items, "status");
    }
    return items;
  }

  // 上游 429/5xx 的重试。**载荷里没有 content**（全是结构化字段），会静默穿过这里。
  // 中转/官方在高峰期重试好几次很常见，期间界面毫无反应，用户会以为卡死去按停止。
  if (m.subtype === "api_retry") {
    const attempt = typeof m.attempt === "number" ? m.attempt : 0;
    const max = typeof m.max_retries === "number" ? m.max_retries : 0;
    const status = typeof m.error_status === "number" ? ` HTTP ${m.error_status}` : "";
    const kind = typeof m.error === "string" && m.error !== "unknown" ? `（${m.error}）` : "";
    const delay = typeof m.retry_delay_ms === "number" ? `，${(m.retry_delay_ms / 1000).toFixed(1)}s 后重试` : "";
    const counter = max > 0 ? `第 ${attempt}/${max} 次` : `第 ${attempt} 次`;
    return pushSystem(items, at, "api_retry", `上游请求失败${status}${kind}，${counter}${delay}`);
  }

  // hook 的输出。**载荷在 output/stdout/stderr 里，没有 content**，同样会静默穿过。
  // 成功的不必逐条报（一个回合可能触发几十次），失败才是用户唯一能看见
  // 「我这个 hook 挂了」的地方。
  if (m.subtype === "hook_response") {
    const outcome = typeof m.outcome === "string" ? m.outcome : "";
    if (outcome === "success") return items;
    const name = typeof m.hook_name === "string" && m.hook_name ? m.hook_name : "hook";
    const event = typeof m.hook_event === "string" && m.hook_event ? `（${m.hook_event}）` : "";
    const code = typeof m.exit_code === "number" ? `，退出码 ${m.exit_code}` : "";
    const detail = [m.stderr, m.stdout, m.output]
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .find((v) => v !== "");
    const head = `${name}${event} ${outcome === "cancelled" ? "被取消" : "执行失败"}${code}`;
    return pushSystem(items, at, "hook_response", detail ? `${head}\n${stripAnsi(detail)}` : head);
  }

  // Stop hook 的汇总：整条只有结构化字段，`hookErrors` 非空才值得说。
  if (m.subtype === "stop_hook_summary") {
    const errors = Array.isArray(m.hookErrors) ? m.hookErrors.filter((e) => typeof e === "string") : [];
    if (errors.length === 0) return items;
    return pushSystem(items, at, "stop_hook_summary", `Stop hook 出错：${errors.join("；")}`);
  }

  // 上下文压缩是回合之间真实发生过的事，转录里也有；不显示的话用户会以为
  // 历史无缘无故变短了。
  //
  // 字段名两边不同：**实时帧是 `compact_metadata`（snake），转录里落盘成
  // `compactMetadata`（camel）**。只认一个的话，实时看得见这条提示、重开对话后它就消失
  // （或者反过来）。两个都认。
  if (m.subtype === "compact_boundary") {
    const meta = compactMetaOf(m);
    const trigger = meta.trigger === "manual" ? "手动" : "自动";
    const pre = meta.preTokens !== undefined ? `，压缩前 ${formatTokens(meta.preTokens)} tokens` : "";
    // 压缩结束：「正在压缩上下文…」不再成立，必须一起摘掉（见 clearOngoing）。
    return pushSystem(clearOngoing(items, "status"), at, "compact_boundary", `上下文已${trigger}压缩${pre}`);
  }
  // `microcompact_boundary` 是**微观压缩**（只清掉过期的 tool_result / 冗余附件）的边界，
  // 不是一次真正的上下文压缩：没有 `compactMetadata`、没有 before/after 数，CLI 自己的
  // 界面也直接 `return null`（二进制里就是这一行）。所以整条丢弃。
  //
  // 只挡在没有 content 时是不够的：带一句 content 就会掉进下面的通用分支，界面上多一条
  // 「Conversation compacted」之类的提示，而历史并没有变短，用户会以为压过了。
  if (m.subtype === "microcompact_boundary") {
    // 微观压缩同样会结束上一个「正在压缩」的进行时（它证明这一轮已经过去了）。
    return clearOngoing(items, "status");
  }
  // 本地命令回显也可能走 system 通道，同样整条丢弃。
  if (typeof m.content === "string" && isLocalCommandEcho(m.content)) return items;
  // hooks 输出等以 system + content 字符串形式上送，需要展示（并清洗 ANSI）。
  // `model_fallback` / `model_refusal_fallback` / `informational` 这些也走这条路：
  // CLI 自己在 `content` 里写好了人话，逐条再翻译反而会丢掉细节。
  if (typeof m.content === "string" && m.content) {
    return pushSystem(items, at, subtype, stripAnsi(m.content));
  }
  return items;
}

/** 追加一条 system 文本（清掉 ANSI：hook 输出与进度条会带颜色与光标控制）。 */
function pushSystem(items: Item[], at: number, subtype: string | undefined, text: string): Item[] {
  return [...items, { id: nextId(), seq: seqOf(items), ts: at, kind: "system", subtype, text }];
}

/**
 * 追加一条「进行中」类的状态提示，**相同文案不叠加**。
 *
 * `status: compacting` 在一次压缩里会连发很多条（每次 summary 增长都发一条），
 * 逐条落地就是一屏「正在压缩上下文…」。同一条提示连续出现时只保留第一条即可。
 */
function pushOngoing(items: Item[], at: number, subtype: string, text: string): Item[] {
  const last = items[items.length - 1];
  if (last && last.kind === "system" && last.subtype === subtype && last.text === text) return items;
  return pushSystem(items, at, subtype, text);
}

/**
 * 摘掉「进行中」类的状态提示（压缩结束/失败时用）。
 *
 * 「正在压缩上下文…」是**进行时**：压缩一收尾它就不再成立，留着就是一条永远停在
 * 「正在…」的陈述，紧接着下面又出现「上下文已手动压缩」——两句话互相打架。
 * 早先只做了去重没做收尾，一次 `/compact` 之后那条提示会一直留在消息流里（截图复现过）。
 *
 * 只摘同一 subtype 的：别把别的进行时提示（比如以后新增的）一起收掉。
 */
function clearOngoing(items: Item[], subtype: string): Item[] {
  const kept = items.filter((it) => !(it.kind === "system" && it.subtype === subtype));
  return kept.length === items.length ? items : kept;
}

/** 追加一条错误提示（压缩失败这类「静默的数据损失」用它，比灰色小字显眼）。 */
function pushError(items: Item[], at: number, text: string): Item[] {
  return [...items, { id: nextId(), seq: seqOf(items), ts: at, kind: "error", text }];
}

/**
 * `conversation_reset` 的人话。
 *
 * `trigger` 是 CLI 自己给的：`clear`（/clear、/reset、/new）、`plan_mode_exit`
 * （退出计划模式时选了清空上下文）、`fresh_session`、`onboarding`。
 * 未知取值说「已重置」，别硬猜成 /clear。
 */
function resetText(m: Raw): string {
  switch (m.trigger) {
    case "clear":
      return "上下文已清空（/clear）";
    case "plan_mode_exit":
      return "退出计划模式，上下文已清空";
    case "fresh_session":
      return "已开始新的上下文（为执行已批准的计划）";
    case "onboarding":
      return "已重新跑一遍引导流程，上下文已清空";
    default:
      return "上下文已重置";
  }
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
 * 去重规则与 CLI 回显那条路一致（`samePromptEcho`），但**只认本机插入的那条**
 * （没有 `echoed` 标记）：发送方自己也会收到这条广播，命中本机气泡后丢弃。
 * 补进来的 echo 带 `echoed: true`，所以「同一个设备连发两次同一句话」时，第二条
 * 广播不会命中第一条补进来的气泡被吞掉——另一台设备上就少一条。
 * `label` 是本机界面的「附件：」文案（发送方那台设备的语言可能不同，所以文案由
 * 收到的一方决定）。
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
  // 本机刚发过同一条：不重复。图片消息两边都可以没有正文，靠「都有图片」认出来。
  //
  // **往回找整轮**而不是只看最后一条，理由同 `echoAlreadyShown`：插话发生在回合
  // 进行中，本地气泡早被后续的 thinking / tool 顶走了，只看尾巴会把广播当成新消息
  // 再插一条——那条没有 `interjected` 标记，于是把这一轮切成两半。
  if (echoAlreadyShown(items, prompt, images.length > 0, true)) return items;
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
      // 标出来源：下一次广播不能再被这条吞掉（见上面的注释）。
      echoed: true,
    },
  ];
}

/**
 * 交界处按内容去重的时间窗。
 *
 * 同一条消息在「CLI 写进转录」与「实时帧到达浏览器」之间只差几十毫秒，5 秒足够
 * 容下 NAS 上的抖动；而模型隔了一会儿又原样说了同一句话（「好的」）时，两边的
 * `ts` 差得远，不能被当成同一条吞掉。
 */
const REPLAY_ECHO_WINDOW_MS = 5000;

/**
 * 转录尾部的这一条与本地新增的头部这一条，是不是同一段内容。
 *
 * 只认三种能**确定**是同一件事的情形（用户气泡与 result 不参与，见下方的原因）：
 *   - `tool`：`tool_use_id` 是 CLI 给的，同一条调用只有一个 id；
 *   - `assistant` / `thinking`：正文逐字相同 + 时间接近（同一条消息的写盘时刻与
 *     到达时刻只差几十毫秒）。
 */
function sameReplayed(a: Item, b: Item): boolean {
  switch (a.kind) {
    case "tool":
      return b.kind === "tool" && a.toolUseId !== "" && a.toolUseId === b.toolUseId;
    case "assistant":
    case "thinking":
      // 正文为空的不比：那种条目没有可辨识的内容，比下去只会吞掉真正的新消息。
      return (
        b.kind === a.kind &&
        a.text.trim() !== "" &&
        a.text === b.text &&
        Math.abs(a.ts - b.ts) <= REPLAY_ECHO_WINDOW_MS
      );
    default:
      // user：本机的乐观气泡不能在这里被吞（`applyCLI` 的 `echoAlreadyShown` 管它）；
      // result / system / interrupt / error：转录里压根没有 result 行，其余几条
      // 重复出现都是合理内容，按内容比只会误删。
      return false;
  }
}

/**
 * 丢掉「实时帧已经落过、转录里也有」的那几条。
 *
 * 打开一条正在跑的对话时，回放读的是磁盘快照，而快照读完之后、读之前到达的实时帧
 * 会先落进 `items`：同一条助手消息/同一张工具卡片于是两边各有一份。原本只按 `ts`
 * 切（`ts` 晚于转录最后一条就接在后面），而实时帧的 `ts` 是**到达时刻**、永远晚于
 * 转录里的写盘时刻——它一定会被当成「转录取到之后的新条目」接上去，界面上就是
 * 同一段回答出现两遍。
 *
 * 从交界处**逆序**对齐：转录的最后一条对本地新增的第一条、依次往前比。命中几条
 * 丢几条，遇到第一处不同就停——本地新增里真正的新内容因此不会被牵连。
 */
function dropReplayedEcho(history: Item[], tail: Item[]): Item[] {
  let n = 0;
  while (n < tail.length && n < history.length && sameReplayed(tail[n], history[history.length - 1 - n])) {
    n += 1;
  }
  return n === 0 ? tail : tail.slice(n);
}

/**
 * 把「整份转录回放」的结果与本地已有的消息流合并。
 *
 * 用在重连补不齐（`session.resync`）的时候：断开期间产生的事件要么已从后端缓冲里
 * 淘汰、要么后端进程重启过，本地那份消息流中间缺了一段，只能整份重放转录。
 * 但**不能直接拿转录覆盖本地**：
 *   - 本地可能有转录里还没有的条目（刚发的提示词、断线期间本地插的错误提示）；
 *   - 断线时正在流的增量气泡也没进转录（转录里是完整版本，位置相同但 ts 不同）。
 *
 * 合并规则：**以转录那份为主**（它完整、有序、带真实时间戳），只把本地 ts 晚于
 * 转录最后一条的条目接在后面。这条界线天然把「转录已经收录的乐观条目」和「断线
 * 时的半截流式气泡」都排除掉——它们的 ts 都早于转录的最后一条。
 *
 * 交界处还要再比一次内容（`dropReplayedEcho`）：接线两侧很可能是同一条消息的两份
 * （实时帧先落了地，转录随后才被读到），光比 `ts` 挡不住。
 *
 * `settle` 为真时顺手收掉本地残留的流式光标：整份重建意味着那一轮早就结束了
 * （它的 result 在断线期间就产生过、转录里也有完整回答），光标不该继续闪。
 */
export function mergeReplayed(history: Item[], local: Item[], settle = false): Item[] {
  if (history.length === 0) return settle ? settleStreaming(local) : local;
  if (local.length === 0) return history;
  const base = settle ? settleStreaming(local) : local;
  const cut = history[history.length - 1].ts;
  const tail = dropReplayedEcho(history, base.filter((it) => it.ts > cut));
  if (tail.length === 0) return history;
  // 两边的 seq 都是从 0 起算的独立计数：接上去之前要重排，否则轮次刻度的
  // seq 会出现重复值（`lib/turns.ts` 拿它当稳定标识）。起点取转录里的最大 seq + 1。
  let seq = history.reduce((max, it) => Math.max(max, it.seq ?? 0), 0) + 1;
  return [...history, ...tail.map((it) => ({ ...it, seq: seq++ }))];
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
