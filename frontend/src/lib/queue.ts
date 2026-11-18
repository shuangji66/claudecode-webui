// 「待发送」队列：回合进行中用户提交的消息先排在这里，可编辑、可删、可立即插话。
//
// 为什么需要一层队列而不是直接写 stdin：claude 的 stdin 在回合进行中照样可写，
// 但写进去的那一刻就收不回来了（CLI 不回显被合并的消息），所以必须先摆出来让人确认。
// 投递规则见 store.flushQueued：一条回合结束后自动发下一条；被中断 / 出错时停在队列里，
// 由用户自己决定是「立即插话」还是删掉。
import type { WireAttachment } from "../transport/types";

export interface QueuedPrompt {
  id: string;
  text: string;
  attachments: WireAttachment[];
  /** 附件在气泡里的前缀，跟随界面语言（真正发送时才用得上）。 */
  label: string;
  ts: number;
}

/** 队列上限：附件是 base64 常驻内存，攒太多会顶到几百 MB。 */
export const MAX_QUEUED = 8;

let seq = 0;

function nextId(): string {
  seq += 1;
  return `q${seq}`;
}

/** 入队；空消息或队列已满返回 null，调用方据此提示（不静默丢消息）。 */
export function enqueuePrompt(
  queue: QueuedPrompt[],
  text: string,
  attachments: WireAttachment[] = [],
  label = "附件：",
  now = Date.now(),
): QueuedPrompt[] | null {
  if (queue.length >= MAX_QUEUED) return null;
  const body = text.trim();
  if (!body && attachments.length === 0) return null;
  return [...queue, { id: nextId(), text: body, attachments, label, ts: now }];
}

export function removePrompt(queue: QueuedPrompt[], id: string): QueuedPrompt[] {
  return queue.filter((q) => q.id !== id);
}

/**
 * 改一条待发送（正文 / 附件），**保持它在队列里的位置**——排队顺序就是上下文顺序，
 * 改完不该跑到队尾。正文与附件都被清空时等于删掉它。
 */
export function updatePrompt(
  queue: QueuedPrompt[],
  id: string,
  text: string,
  attachments?: WireAttachment[],
): QueuedPrompt[] {
  const body = text.trim();
  const out: QueuedPrompt[] = [];
  for (const q of queue) {
    if (q.id !== id) {
      out.push(q);
      continue;
    }
    const next = attachments ?? q.attachments;
    if (!body && next.length === 0) continue; // 清空 = 删掉
    out.push({ ...q, text: body, attachments: next });
  }
  return out;
}

/** 队首：一次只发一条，等它的回合结束再发下一条（并发会打乱上下文顺序）。 */
export function headPrompt(queue: QueuedPrompt[]): QueuedPrompt | undefined {
  return queue[0];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 「这一轮结束了，能不能自动发下一条」。
 *
 * 被中断 / 出错时不自动发：用户按 Esc 是「停手」，此时替他把排队的消息发出去
 * 等于替他决定继续；API 报错时继续灌消息也只会把错误叠起来。两种情况队列都留着，
 * 界面上仍然可以逐条「立即插话」或删掉。
 */
export function shouldFlushAfter(result: unknown): boolean {
  if (!isRecord(result) || result.type !== "result") return false;
  if (result.is_error === true) return false;
  // 中断时 CLI 只往 errors 数组里塞一段内部诊断（result.result 根本没有，见
  // lib/normalize.ts 的同一判定）：有的版本此时不把 is_error 置 true，只靠 subtype
  // 也可能漏掉，所以再看一眼文本——用户按 Esc 是「停手」，绝不能替他把排队的消息发出去。
  const texts = [result.result, ...(Array.isArray(result.errors) ? result.errors : [])];
  if (
    texts.some(
      (t) =>
        typeof t === "string" &&
        (t.trimStart().startsWith("[ede_diagnostic]") || t.trimStart().startsWith("[Request interrupted by user")),
    )
  ) {
    return false;
  }
  const sub = typeof result.subtype === "string" ? result.subtype.toLowerCase() : "";
  return !sub.includes("interrupt") && !sub.includes("abort") && !sub.includes("cancel");
}
