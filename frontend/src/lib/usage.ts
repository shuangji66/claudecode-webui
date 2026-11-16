// 用量统计：把 claude CLI 真实吐出来的 token 数据折成面板上的几个数。
//
// 数据来源（2.1.325 实测，stream-json）：
//   - `stream_event` 的 `message_start.message.usage` / `message_delta.usage`：每次请求的
//     input / cache_read / cache_creation / output，流式期间就能拿到；
//   - `result.usage`：本回合最后一次请求的用量；
//   - `result.modelUsage.<model>.contextWindow`：模型上下文窗口（init 里没有）。
//
// 这里刻意**不做**的事：CLI 不提供「步骤数」「实时 tok/s」「官方上下文百分比」，
// 所以步数用工具调用次数、tok/s 用输出 token ÷ API 耗时、上下文用
// (input + cache_read + cache_creation) ÷ contextWindow —— 都是同一套数据算出来的，
// 不在界面上编造。

/** 一次请求的 token 用量（字段名与 CLI 一致，这里转成驼峰）。 */
export interface UsageTotals {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
}

/** 某个会话当前的用量快照。 */
export interface UsageSnapshot {
  /** 最近一次请求的输入侧 token 总量 = 上下文占用。 */
  contextTokens: number;
  /** 模型上下文窗口；CLI 没给时为空。 */
  contextWindow?: number;
  /** 缓存命中率 0..1（cache_read / 输入侧总量）。 */
  cacheHitRate?: number;
  /** 最近一回合的输出 token 与 API 耗时，用于 tok/s。 */
  outputTokens?: number;
  apiMs?: number;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 把 CLI 的 usage 对象（snake_case）折成 UsageTotals；字段全缺时返回 undefined。 */
export function totalsFromUsage(usage: unknown): UsageTotals | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const totals: UsageTotals = {
    input: num(u.input_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheCreation: num(u.cache_creation_input_tokens),
    output: num(u.output_tokens),
  };
  if (totals.input + totals.cacheRead + totals.cacheCreation + totals.output === 0) return undefined;
  return totals;
}

/** 上下文占用 = 这次请求送出去的输入侧 token（含缓存命中与新建缓存）。 */
export function contextTokens(u: UsageTotals): number {
  return u.input + u.cacheRead + u.cacheCreation;
}

/** 缓存命中率：命中 token / 输入侧总量；输入侧为 0 时没有意义，返回 undefined。 */
export function cacheHitRate(u: UsageTotals): number | undefined {
  const total = contextTokens(u);
  if (total <= 0) return undefined;
  return u.cacheRead / total;
}

/** 输出速度（tok/s）：输出 token ÷ API 耗时。耗时缺失或为 0 时返回 undefined。 */
export function tokensPerSecond(outputTokens: number, apiMs: number | undefined): number | undefined {
  if (!apiMs || apiMs <= 0 || outputTokens <= 0) return undefined;
  return outputTokens / (apiMs / 1000);
}

/** 上下文占窗口的百分比（0..100 的整数）；缺窗口或窗口为 0 时返回 undefined。 */
export function contextPercent(context: number, window: number | undefined): number | undefined {
  if (!window || window <= 0 || context <= 0) return undefined;
  return Math.min(100, Math.round((context / window) * 100));
}

/** 12.4K / 1.2M 这种紧凑写法（按 1024 进位，和上下文窗口的习惯一致）。 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1024) return String(Math.round(n));
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, "")}K`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * 从一条 CLI 原始消息更新快照。
 *
 * - `stream_event` 的 message_start / message_delta：流式期间就能更新上下文与输出；
 * - `result`：回合结束，补上 modelUsage 里的 contextWindow 与 API 耗时。
 * 不认识的形状原样返回，调用方据此决定要不要 set。
 */
export function applyUsageMessage(prev: UsageSnapshot | undefined, msg: unknown): UsageSnapshot | undefined {
  if (!msg || typeof msg !== "object") return undefined;
  const m = msg as Record<string, unknown>;

  if (m.type === "stream_event") {
    const ev = m.event as Record<string, unknown> | undefined;
    if (!ev) return undefined;
    if (ev.type === "message_start") {
      const totals = totalsFromUsage((ev.message as Record<string, unknown> | undefined)?.usage);
      if (!totals) return undefined;
      return {
        ...prev,
        contextTokens: contextTokens(totals),
        cacheHitRate: cacheHitRate(totals),
        outputTokens: totals.output,
      };
    }
    if (ev.type === "message_delta") {
      const totals = totalsFromUsage(ev.usage);
      if (!totals) return undefined;
      // 没有 message_start（例如中途接上的流）时上下文未知，先记 0，等 result 补。
      if (!prev) return { contextTokens: 0, outputTokens: totals.output };
      return { ...prev, outputTokens: totals.output };
    }
    return undefined;
  }

  if (m.type === "result") {
    const totals = totalsFromUsage(m.usage);
    const apiMs = typeof m.duration_api_ms === "number" ? m.duration_api_ms : undefined;
    // modelUsage 是 { 模型名: { contextWindow, ... } }；多模型时取最后一个（本回合实际用的）。
    let window: number | undefined;
    const modelUsage = m.modelUsage as Record<string, unknown> | undefined;
    if (modelUsage) {
      for (const entry of Object.values(modelUsage)) {
        const w = (entry as Record<string, unknown> | undefined)?.contextWindow;
        if (typeof w === "number" && w > 0) window = w;
      }
    }
    if (!totals && window === undefined && apiMs === undefined) return undefined;
    const next: UsageSnapshot = {
      contextTokens: totals ? contextTokens(totals) : (prev?.contextTokens ?? 0),
      cacheHitRate: totals ? cacheHitRate(totals) : prev?.cacheHitRate,
      contextWindow: window ?? prev?.contextWindow,
      outputTokens: totals?.output ?? prev?.outputTokens,
      apiMs,
    };
    return next;
  }

  return undefined;
}
