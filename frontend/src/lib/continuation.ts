// 上下文压缩后的「续接提示」：识别 CLI 自己写的那 16KB 英文摘要。
//
// 压缩完成后 CLI 会把摘要当成一条 **user 行**塞回对话（终端里它只出现在模型上下文，
// 不会渲染成用户说的话）。我们若不认它，界面上就是一条占满半屏的米色气泡：
//
//	This session is being continued from a previous conversation that ran out of
//	context. The summary below covers the earlier portion of the conversation. …
//
// 它有两种落点，两处都要挡：
//   - **独立的行**：带 `isCompactSummary: true`（转录里还多一个
//     `isVisibleInTranscriptOnly: true`）。这种整条都是 CLI 写的，直接丢。
//   - **和用户下一句话拼在一起**：压缩正好赶上用户发消息（或宿主自动续接）时，
//     CLI 把续接提示与用户那句话**拼成一条** user 行的正文。这时只能按文本切开：
//     摘要正文之后跟一句固定的收尾语，收尾语之后才是用户真敲的字。
//
// 收尾语在 2.1.329 里有三种变体（见 `CONTINUATION_TRAILERS`），都是 CLI 的常量字符串；
// 以后的版本改了措辞时 `splitContinuation` 会认不出结尾，那时**整条按 CLI 注入处理**
// （丢掉），代价是那条消息里的用户提问看不见——这比把 16KB 英文摘要糊在气泡里轻。

/** 续接提示的开头，CLI 的常量（`nhe` 里的 `v5e`）。 */
const CONTINUATION_PREFIX = "This session is being continued from a previous conversation";

/**
 * 续接提示末尾的固定句子（含它们**之后**才是用户正文）。
 *
 * 三种形态：
 *   - 常规：`…may already have happened in them.`
 *   - 压缩时要求不要追问：`…Pick up the last task as if the break never happened.`
 *   - Remote Control 撤下了摘要：`…If you need details from the earlier conversation, ask the user.`
 */
const CONTINUATION_TRAILERS = [
  "may already have happened in them.",
  "as if the break never happened.",
  "read only in the terminal session where it was written. If you need details from the earlier conversation, ask the user.",
];

export interface SplitContinuation {
  /** 这条正文是不是 CLI 的续接提示（整条或前缀）。 */
  injected: boolean;
  /** 去掉续接提示之后剩下的、用户真正说的话（可能为空）。 */
  rest: string;
}

/**
 * 把续接提示与用户正文分开。
 *
 * 不是续接提示时原样返回；是的话尽力切在最后一句收尾语之后。收尾语一个都认不出时
 * 返回 `{injected: true, rest: ""}`——整条当作 CLI 注入（见文件头对代价的说明）。
 */
export function splitContinuation(text: string): SplitContinuation {
  if (!text.startsWith(CONTINUATION_PREFIX)) return { injected: false, rest: text };
  let cut = -1;
  for (const trailer of CONTINUATION_TRAILERS) {
    const at = text.lastIndexOf(trailer);
    if (at >= 0) cut = Math.max(cut, at + trailer.length);
  }
  if (cut < 0) return { injected: true, rest: "" };
  return { injected: true, rest: text.slice(cut).trim() };
}

/**
 * 这条 user 行是不是纯 CLI 注入（压缩摘要 / 只在转录里有意义的行）。
 *
 * 与 `splitContinuation` 分开：带标记的行连用户正文都没有，不必走文本解析。
 */
export function isInjectedUserRow(row: Record<string, unknown> | undefined): boolean {
  if (!row) return false;
  return row.isCompactSummary === true || row.isVisibleInTranscriptOnly === true;
}
