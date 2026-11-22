// 轨迹（Trace）：把一份 Item 列表折成「一轮一条时间线」，右侧栏的「轨迹」标签消费它。
//
// 这里只做**能从 CLI 真给的数据推出来的事**（口径见 lib/usage.ts 与 lib/normalize.ts）：
//
//   - 轮边界与耗时：`turnSpans`（实时取 `result.duration_ms`，回放按转录首尾时间戳）；
//   - 一次模型请求：同一时刻落盘的那批 assistant / thinking 条目就是一次请求的产物，
//     它占用的时间是「上一步结束 → 这批条目的时间戳」；
//   - 一次工具调用：`tool_use` 的时间戳（`ToolItem.ts`）→ `tool_result` 的时间戳
//     （`ToolItem.doneAt`）；后台子代理的 tool_result 只是启动回执，时长改用
//     `task_notification.usage.duration_ms`；
//   - 一次子代理：Agent 卡片和它的工具调用共用同一对边界（`task_*` 事件只改状态）；
//   - 事件（压缩 / 报错 / 中断）：一条零时长的标记。
//
// **不做的事**：不把正文、思考再切成独立的时间段。一条 assistant 消息里的 thinking 与
// text 块共享同一个时间戳（实时是完整帧到达、转录是落盘），再往下切只能是编。同理，
// 段与段之间的空隙不填：它要么是 CLI 在两次请求之间调度，要么就是上游还没吐字——
// 把它画成某个实体就等于把「没测到」说成了「测到了」。
import { formatDuration } from "./elapsed";
import type { Item, ToolItem } from "./model";
import { toolCategory, turnSpans, type ToolCategory } from "./process";
import { toolSummary } from "./tools";

/** 泳道：用户输入 / 模型请求 / 工具调用 / 子代理 / 事件。 */
export type TraceLane = "input" | "model" | "tool" | "subagent" | "event";

/** 固定文案的键（真正的文字在 `TracePanel` 里按界面语言给）。 */
export type TraceLabelKey = "model" | "system" | "error" | "interruptUser" | "interruptAgent" | "interruptSession" | "event";

export interface TraceSpan {
  id: string;
  lane: TraceLane;
  /** 绝对时刻（ms）。零时长的段（事件标记）start === end。 */
  start: number;
  end: number;
  /**
   * 主文案：工具名 / 子代理描述 / 事件摘要（都是数据自带的名字）。
   *
   * 固定文案（「模型请求」「系统事件」…）不放这里，走 `labelKey` —— 它们是界面文案，
   * 必须跟着界面语言走；`label` 里塞中文会让英文界面混进中文（轨迹面板直接渲染它）。
   */
  label?: string;
  /** 固定文案的键；`label` 为空时由面板 `t()` 出文案。 */
  labelKey?: TraceLabelKey;
  /** 副文案：工具入参摘要、子代理类型、事件原因。 */
  detail?: string;
  /** 点这一行时滚到对话里的哪一条（对应 MessageList 的 `data-item-id`）。 */
  itemId?: string;
  /** 还没结束（工具在跑 / 当前正在等上游）。 */
  running?: boolean;
  error?: boolean;
  category?: ToolCategory;
  /** 子代理段的对话 id：点「查看对话」时用（`SubagentPanel` 要 sessionId + agentId）。 */
  agentId?: string;
}

export interface TraceTurn {
  /** 第几轮，0 起（界面显示时 +1）。 */
  index: number;
  /** 时间轴起止（ms）。还在跑的轮次 end 会跟到「此刻」。 */
  start: number;
  end: number;
  finished: boolean;
  /** 这一轮的墙钟耗时（`TurnSpan.durationMs`，回放按转录首尾推）。 */
  durationMs?: number;
  /** 用户这句话的摘要（换行压成空格）。 */
  prompt: string;
  /** 这一轮用过的最后一个模型名。 */
  model?: string;
  spans: TraceSpan[];
  toolCount: number;
  subagentCount: number;
  /** 本轮消耗（`result.usage` 的整轮累计口径；中断/回放时可能没有）。 */
  inputTokens?: number;
  outputTokens?: number;
}

/** 文案与摘要的上限：轨迹是缩略视图，长文本留给对话区。 */
const LABEL_MAX = 80;
const DETAIL_MAX = 120;

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * 事件标记的文案：有正文就用正文（CLI 自己写的人话），没有就退回一句固定文案。
 *
 * 退回的那句走 `labelKey`：中断与空系统事件的文案是界面文案，不该写死中文。
 */
function eventLabel(item: Item): { label: string; labelKey: TraceLabelKey } {
  if (item.kind === "system") {
    const text = clip(item.text, LABEL_MAX);
    return text ? { label: text, labelKey: "system" } : { label: item.subtype || "", labelKey: "system" };
  }
  if (item.kind === "error") {
    return { label: clip(item.text, LABEL_MAX), labelKey: "error" };
  }
  if (item.kind === "interrupt") {
    const labelKey: TraceLabelKey =
      item.reason === "user" ? "interruptUser" : item.reason === "agent" ? "interruptAgent" : "interruptSession";
    return { label: "", labelKey };
  }
  return { label: "", labelKey: "event" };
}

function eventDetail(item: Item): string | undefined {
  if (item.kind === "system") return item.subtype || undefined;
  if (item.kind === "interrupt") return item.reason;
  return undefined;
}

/** 是不是子代理调用（`Agent` / `Task`，以及带子代理状态的卡片）。 */
function isSubagentCall(item: ToolItem): boolean {
  if (item.subagent) return true;
  return item.name === "Agent" || item.name === "Task";
}

/** 事件标记：压缩、报错、中断这些「发生过但没有时长」的东西。 */
function isEventItem(item: Item): boolean {
  return item.kind === "system" || item.kind === "error" || item.kind === "interrupt";
}

/** 子代理已经收尾（不再产出内容）；其余情况按卡片自己的状态判。 */
function subagentSettled(item: ToolItem): boolean {
  const status = item.subagent?.status;
  return status === "completed" || status === "failed" || status === "stopped";
}

/**
 * 把一份消息列表折成逐轮轨迹。
 *
 * `running` 是「这条会话此刻在不在跑」（与 `turnSpans` 同一个口径）；`now` 只影响
 * 还在跑的轮次与工具的长度，纯函数便于单测。
 */
export function traceTurns(items: Item[], running = true, now = Date.now()): TraceTurn[] {
  const spans = turnSpans(items, running);
  const out: TraceTurn[] = [];

  spans.forEach((span, index) => {
    const slice = items.slice(span.start, span.end);
    if (slice.length === 0) return;

    const first = slice[0];
    const last = slice[slice.length - 1];
    const start = first.ts;
    const live = !span.finished;
    /** 这一轮的最后时刻：还在跑的轮次跟到「此刻」，否则就是最后一条消息。 */
    const turnEnd = live ? Math.max(last.ts, now) : last.ts;
    /** 上一步结束的时刻：下一次模型请求就从这里开始计时。 */
    let cursor = start;
    const outSpans: TraceSpan[] = [];

    let prompt = "";
    let model = "";
    let toolCount = 0;
    let subagentCount = 0;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let sawRunningTool = false;

    // 同一时刻落盘的条目属于同一条消息：先按时间戳分组，再决定这一组里谁画什么。
    // 分组按**相邻**判定（转录里的时间戳单调，实时帧也是按序到达），不做全局归并。
    for (let i = 0; i < slice.length; ) {
      const ts = slice[i].ts;
      const group: Item[] = [];
      while (i < slice.length && slice[i].ts === ts) {
        group.push(slice[i]);
        i += 1;
      }

      // 一次请求的产物：正文 / 思考 / **tool_use**。工具那一支不能漏——模型在工具循环里
      // 常常只回一个 tool_use（没有正文也没有思考），只按正文判的话这一整段请求会从
      // 泳道上消失，看起来像「工具凭空开始跑了」。
      //
      // 但 `task_*` 事件先造的**占位卡**不算：它的时间戳是 task 事件的时刻，不是请求
      // 落盘的时刻，拿它当边界会凭空多画一段模型耗时。
      const request = group.filter(
        (it) =>
          it.kind === "thinking" ||
          (it.kind === "assistant" && it.text.trim() !== "") ||
          (it.kind === "tool" && !it.placeholder),
      );
      const tools = group.filter((it): it is ToolItem => it.kind === "tool");
      const events = group.filter(isEventItem);

      for (const it of group) {
        if (it.kind === "user" && !prompt) prompt = clip(it.text, DETAIL_MAX);
        if ((it.kind === "assistant" || it.kind === "thinking") && it.model) model = it.model;
        if (it.kind === "result" && it.usage) {
          // 一轮里可能有多条 result（插话把一轮拆成几个子回合），各自是本轮的累计口径，
          // 相加才是这一轮真正吃掉的量。
          inputTokens = (inputTokens ?? 0) + (it.usage.turnInputTokens ?? 0);
          outputTokens = (outputTokens ?? 0) + (it.usage.outputTokens ?? 0);
        }
      }

      if (request.length > 0) {
        const named = request.find(
          (it): it is Extract<Item, { kind: "assistant" | "thinking" }> =>
            (it.kind === "assistant" || it.kind === "thinking") && Boolean(it.model),
        );
        const name = named && "model" in named ? named.model : undefined;
        // 请求段从「上一步结束」开始：这段时间就是上游在跑（含首字延迟）。
        // 起点与终点同一毫秒时不画，画出来只会是一根 1px 的线。
        if (ts > cursor) {
          outSpans.push({
            id: `model-${index}-${outSpans.length}`,
            lane: "model",
            start: cursor,
            end: ts,
            // 主文案说「这一步是什么」，模型名放副文案：一轮里几十条请求都叫某个模型名，
            // 步骤表会变成一列重复的型号，看不出哪几段是请求。
            labelKey: "model",
            detail: name || model || undefined,
            itemId: request.find((it) => it.kind !== "tool")?.id ?? request[0].id,
          });
        }
      }

      for (const tool of tools) {
        toolCount += 1;
        const sub = isSubagentCall(tool);
        if (sub) subagentCount += 1;
        // 后台子代理的 tool_result 是启动回执：真实时长以 task 通知的 duration_ms 为准。
        const usageMs = tool.subagent?.usage?.durationMs ?? 0;
        const usageEnd = usageMs > 0 ? ts + usageMs : undefined;
        const doneAt = tool.doneAt;
        const tail = doneAt ?? (live ? now : turnEnd);
        // 重启后那条 task 通知不在了（它只出现在 stdout 上），磁盘上还剩的收尾时刻是
        // 子代理自己转录的最后一行（`history.subagentStates` 读出来、`settleSubagents`
        // 回填成 `subagent.endedAt`）。不认它，一个跑了十分钟的后台子代理在泳道上
        // 就只剩启动回执那么一根线。
        const recoveredEnd = tool.subagent?.endedAt;
        // 四个边界取最晚：启动时刻、结果落地、task 用量、转录恢复的收尾时刻。
        const spanEnd = Math.max(ts, tail, usageEnd ?? 0, recoveredEnd ?? 0);
        const runningNow = live && doneAt === undefined && !subagentSettled(tool);
        /**
         * 并行的任务不占用「主循环的下一步」：后台子代理跑 40 秒期间，主对话照样在发
         * 下一次请求。把它们也算进 cursor 的话，那 40 秒之后的所有模型请求都会被挤掉。
         * `task_*` 先造的占位卡同理——它是后台任务的形态，按并行处理。
         */
        const parallel = tool.subagent?.background === true || tool.placeholder === true;
        if (!parallel) {
          if (runningNow) sawRunningTool = true;
          cursor = Math.max(cursor, spanEnd);
        }
        outSpans.push({
          id: `tool-${tool.id}`,
          lane: sub ? "subagent" : "tool",
          start: ts,
          end: spanEnd,
          label: sub ? tool.subagent?.description || tool.name : tool.name,
          detail: sub
            ? [tool.subagent?.type, tool.subagent?.usage?.toolUses !== undefined ? `${tool.subagent.usage.toolUses} 次工具` : ""]
                .filter(Boolean)
                .join(" · ")
            : clip(toolSummary(tool), DETAIL_MAX),
          itemId: tool.id,
          agentId: sub ? tool.subagent?.agentId || tool.subagent?.taskId || undefined : undefined,
          running: runningNow,
          error: tool.isError === true,
          category: toolCategory(tool.name),
        });
      }

      for (const ev of events) {
        const evLabel = eventLabel(ev);
        outSpans.push({
          id: `event-${ev.id}`,
          lane: "event",
          start: ts,
          end: ts,
          label: evLabel.label || undefined,
          labelKey: evLabel.labelKey,
          detail: eventDetail(ev),
          itemId: ev.id,
          error: ev.kind === "error",
        });
      }

      if (ts > cursor) cursor = ts;
    }

    // 还在跑、且没有正在跑的工具：最后这一段是「已经发出请求、还没收到任何东西」。
    // 单独画出来，用户才知道此刻在等上游而不是卡住了。
    if (live && !sawRunningTool && turnEnd > cursor) {
      outSpans.push({
        id: `model-${index}-pending`,
        lane: "model",
        start: cursor,
        end: turnEnd,
        labelKey: "model",
        detail: model || undefined,
        running: true,
      });
    }

    outSpans.sort((a, b) => a.start - b.start || a.end - b.end);
    out.push({
      index,
      start,
      end: Math.max(turnEnd, start + 1),
      finished: span.finished,
      durationMs: span.durationMs,
      prompt,
      model: model || undefined,
      spans: outSpans,
      toolCount,
      subagentCount,
      inputTokens,
      outputTokens,
    });
  });

  return out;
}

/** 时间轴上的比例坐标（0..1）：零时长的段也留一点位置，否则事件标记永远看不见。 */
export function spanGeometry(span: TraceSpan, turn: TraceTurn): { left: number; width: number } {
  const total = Math.max(1, turn.end - turn.start);
  const left = Math.min(1, Math.max(0, (span.start - turn.start) / total));
  const width = Math.max(0, Math.min(1 - left, (span.end - span.start) / total));
  return { left, width };
}

/**
 * 段/步骤的耗时文案：亚秒给 `820ms`，十秒内留一位小数（轨迹上 1.2s 与 1.8s 差得很明显），
 * 再长才用「mm:ss」。
 */
export function formatSpanMs(ms: number): string {
  const v = Math.max(0, ms);
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 10_000) return `${(v / 1000).toFixed(1)}s`;
  return formatDuration(v);
}

/**
 * 把同一泳道里可能重叠的段排成最少的行（区间图贪心着色）。
 *
 * 顺序的工具调用必须挤在一行里：一轮 30 次工具各占一行的话，泳道图会变成一列
 * 30 条横线，看着像骨架屏。真正并行的调用（同一批 tool_use）才另起一行展示重叠，
 * 所以「几行」= 这一轮里同时最多有几个工具在跑。
 */
export function layoutLane(spans: TraceSpan[]): TraceSpan[][] {
  const rows: TraceSpan[][] = [];
  const ordered = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  for (const span of ordered) {
    // 零时长的标记（事件）不占行：否则每个事件都会把后续段往下挤一行。
    const row = rows.find((r) => (r[r.length - 1]?.end ?? -Infinity) <= span.start);
    if (row) row.push(span);
    else rows.push([span]);
  }
  return rows;
}
