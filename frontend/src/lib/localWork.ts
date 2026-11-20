// 「CLI 在自己干活、根本没在等上游」的状态。
//
// 为什么需要它：`TurnTimer` 在「N 秒没有任何帧」时补一句「上游 Ns 没有响应」。
// 那句话的前提是「这一段时间本该有上游字节」——但有几类操作压根不等上游：
//
//   - **上下文压缩**（手动 `/compact` 与自动压缩）：CLI 自己发一次摘要请求，
//     期间只有一条 `system/status {status:"compacting"}`，之后到 `compact_boundary`
//     之间一个字节都没有。实测一次手动压缩 25.3 秒（`compact_boundary.duration_ms`），
//     而 CLI 自己的压缩心跳是 **30 秒**一次——我们的 15 秒阈值必然在中间误报
//     「上游 18s 没有响应」（截图复现过）。压缩失败时 CLI 会自己报
//     `compact_result: "failed"` + 原因，轮不到前端猜。
//   - **hook 命令**（`hook_started` → `hook_response` 之间）：hook 是用户自己配的
//     本地进程，跑多久与上游无关。
//
// 所以把这些状态单独记一份：有它的时候不说「上游没有响应」，改说「正在做什么」。
// 判据只认 CLI 自己报的帧，不按「已经等了多久」猜——猜错的方向是把真正的上游故障
// 说成正常。
//
// 与 `ChatPane.waitingUpstream`（有工具在跑）是同一类判断的两个来源：那个看消息流里
// 有没有未完成的工具卡片，这个看 CLI 的状态帧。两者都要过。

export interface LocalWork {
  /** CLI 正在压缩上下文。 */
  compacting: boolean;
  /**
   * 压缩摘要已经流出来的字符数（`compact_output_chars`）。
   *
   * CLI 的 schema 原话：这个数在涨就说明摘要在被写；不涨则什么都证明不了
   * （可能在等一个后台写好的摘要）。所以它只用来让「正在压缩」这句提示带上
   * 一个会动的数字，**不能**反过来拿它判死。
   */
  compactChars: number;
  /** 正在运行的 hook（`hook_started` 之后、`hook_response` 之前）。 */
  hooks: readonly LocalHook[];
}

/** 一个正在跑的 hook。`id` 只用来配对结束，显示的是 `name`。 */
export interface LocalHook {
  /** `hook_id`：CLI 用它配对 `hook_started` / `hook_response`。 */
  id: string;
  /** `hook_name`（`PostToolUse:Read`、`SessionStart`…）；为空时退回 id。 */
  name: string;
}

export const NO_LOCAL_WORK: LocalWork = { compacting: false, compactChars: 0, hooks: [] };

/** 有没有「本地在干活」的状态。 */
export function hasLocalWork(work: LocalWork): boolean {
  return work.compacting || work.hooks.length > 0;
}

/**
 * 从一条 CLI 帧更新状态（纯函数）。
 *
 * 只认三类信号：
 *   - `system/status` 的 `compacting` / `requesting`：压缩的开始与结束；
 *     结束也认 `status: null`（CLI 清理时就是这么发的）；
 *   - `system/compact_boundary`：压缩边界，上下文已经是压缩后的了；
 *   - 真正的上游帧（`stream_event` / `assistant` / `result`）：有字节回来就说明
 *     不在压缩里了，把 `compacting` 清掉。
 */
export function localWorkFrom(prev: LocalWork, msg: unknown): LocalWork {
  if (!msg || typeof msg !== "object") return prev;
  const m = msg as Record<string, unknown>;

  switch (m.type) {
    case "system":
      break;
    case "stream_event":
    case "assistant":
    case "result":
      // 上游真的出声了：压缩早已结束（`compact_boundary` 之后才轮到新请求）。
      return prev.compacting ? { ...prev, compacting: false, compactChars: 0 } : prev;
    default:
      return prev;
  }

  const subtype = typeof m.subtype === "string" ? m.subtype : "";
  if (subtype === "status") {
    if (m.status === "compacting") {
      // **`compact_output_chars` 可能整条 absence**：CLI 的压缩心跳是
      // `{type:"sdk_status", status:"compacting"}`，每 30 秒一次、不带这个字段
      // （二进制的 `sZ` → `Gus`）。把它当成 0 的话，界面上「已写 12K 字」会每 30 秒
      // 跳回 0，看着像进度在倒退。所以：**字段缺席时保留上一次的数**，
      // 只有 CLI 明确给出数字（含 0，代表新一轮摘要从 0 开始）才覆盖。
      const raw = m.compact_output_chars;
      const chars =
        typeof raw === "number" && Number.isFinite(raw) && raw >= 0
          ? raw
          : // 缺席：沿用上一次；从没给过就是 0。
            prev.compactChars;
      // 同一个 count 连发很多条时对象引用不变，避免每条都让 store 记一次。
      if (prev.compacting && prev.compactChars === chars) return prev;
      return { ...prev, compacting: true, compactChars: chars };
    }
    // `requesting` 是「在等上游」；`null` 是 CLI 自己清理这个状态。
    if (m.status === "requesting" || m.status === null) {
      return prev.compacting ? { ...prev, compacting: false, compactChars: 0 } : prev;
    }
    return prev;
  }
  if (subtype === "compact_boundary") {
    return prev.compacting ? { ...prev, compacting: false, compactChars: 0 } : prev;
  }
  if (subtype === "hook_started") {
    const id = typeof m.hook_id === "string" && m.hook_id ? m.hook_id : "";
    // 没有 id 的帧无法配对结束，按「不记」处理：记下来就永远清不掉。
    if (!id || prev.hooks.some((h) => h.id === id)) return prev;
    // `hook_name` 才是给人看的那个（实测 `PostToolUse:Read`）；缺了退回 id，
    // 至少还能指出是哪一个。
    const name = typeof m.hook_name === "string" && m.hook_name ? m.hook_name : id;
    return { ...prev, hooks: [...prev.hooks, { id, name }] };
  }
  if (subtype === "hook_response") {
    const id = typeof m.hook_id === "string" ? m.hook_id : "";
    if (!id || !prev.hooks.some((h) => h.id === id)) return prev;
    return { ...prev, hooks: prev.hooks.filter((h) => h.id !== id) };
  }
  return prev;
}
