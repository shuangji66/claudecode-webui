// 用量统计：把 claude CLI 真实吐出来的 token 数据折成面板上的几个数。
//
// 数据来源（2.1.325 实测，stream-json）：
//   - `stream_event` 的 `message_start.message.usage` / `message_delta.usage`：**单次请求**的
//     input / cache_read / cache_creation / output，流式期间就能拿到 —— 上下文占用只能认它；
//   - `result.usage` / `result.modelUsage`：**整轮累计**（SDK 类型里写明 usage 是主循环的
//     per-turn 汇总、modelUsage 更是跨轮累计，和 `duration_api_ms` 同一个口径）。一轮里
//     几十上百次请求会把 cache_read 加到一起（长任务实测能到 900 万，而窗口只有 100 万）；
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
  /**
   * 输入侧的三项明细（最近一次请求）：新输入 / 命中缓存 / 新建缓存。
   * 三者相加就是 `contextTokens`；都是 CLI 给的原始数字，不是换算。
   */
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** 最近一回合的输出 token 与 API 耗时，用于 tok/s。 */
  outputTokens?: number;
  /** 输出里用于思考的 token；CLI 没给（或为 0）时为空。 */
  thinkingTokens?: number;
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

/** 输入侧三项明细：新输入 / 命中缓存 / 新建缓存（原始数字，供详情面板摊开）。 */
export function inputParts(
  u: UsageTotals,
): Pick<UsageSnapshot, "inputTokens" | "cacheReadTokens" | "cacheCreationTokens"> {
  return { inputTokens: u.input, cacheReadTokens: u.cacheRead, cacheCreationTokens: u.cacheCreation };
}

/**
 * 上下文数不可能超过窗口：超过的只能是「把一次回合里多次请求加在一起」的数
 * （`result.usage` / `result.modelUsage` 就是这个口径）。这种数在界面上毫无意义——
 * 长任务实测 9.1M / 976.6K，进度环直接顶满 100%。所以已知窗口时直接判为无效（返回 0），
 * 让界面继续用上一次**单次请求**的值，而不是把不可能的数字画出来。
 */
export function plausibleContext(context: number, window: number | undefined): number {
  if (!(context > 0)) return 0;
  if (window && window > 0 && context > window) return 0;
  return context;
}

/** 输出里用于思考的 token；字段缺失或为 0 时返回 undefined（不显示一行 0）。 */
function thinkingTokensOf(usage: unknown): number | undefined {
  const details = (usage as Record<string, unknown> | undefined)?.output_tokens_details;
  if (!details || typeof details !== "object") return undefined;
  const v = (details as Record<string, unknown>).thinking_tokens;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
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
 * - `stream_event` 的 message_start / message_delta：流式期间就能更新上下文与输出
 *   （**上下文只认这里**，它是单次请求的数）；
 * - `result`：回合结束，补上 modelUsage 里的 contextWindow 与 API 耗时，以及整轮输出
 *   ——它的 usage 是整轮累计，不碰上下文。
 * 不认识的形状原样返回，调用方据此决定要不要 set。
 */
export function applyUsageMessage(prev: UsageSnapshot | undefined, msg: unknown): UsageSnapshot | undefined {
  if (!msg || typeof msg !== "object") return undefined;
  const m = msg as Record<string, unknown>;

  if (m.type === "stream_event") {
    const ev = m.event as Record<string, unknown> | undefined;
    if (!ev) return undefined;
    if (ev.type === "message_start") {
      const usage = (ev.message as Record<string, unknown> | undefined)?.usage;
      const totals = totalsFromUsage(usage);
      if (!totals) return undefined;
      // 只有带输入侧时才更新上下文（start 里只有 output 的时候别把已知的上下文抹成 0）。
      // 已知窗口时再挡一层：超过窗口的数不可能是「这次请求的上下文」（自建中转可能把
      // 累计值塞进单条 usage），宁可保留上一份也不画不可能的数字。
      const context = plausibleContext(contextTokens(totals), prev?.contextWindow);
      const next: UsageSnapshot = { ...(prev ?? { contextTokens: 0 }), outputTokens: totals.output };
      if (context > 0) {
        next.contextTokens = context;
        next.cacheHitRate = cacheHitRate(totals);
        Object.assign(next, inputParts(totals));
      }
      const thinking = thinkingTokensOf(usage);
      if (thinking !== undefined) next.thinkingTokens = thinking;
      return next;
    }
    if (ev.type === "message_delta") {
      const totals = totalsFromUsage(ev.usage);
      if (!totals) return undefined;
      // 官方协议里 message_delta 只带 output_tokens，输入侧在 message_start；
      // 但自建中转常常反过来：message_start 给全 0 占位，完整 usage（含 input/cache）
      // 落在 message_delta（实测：start = {input:0,output:0}，delta = {input:6781,
      // cache_read:1792,output:10}）。所以这里**两样都看**：
      //   有输入侧 → 直接更新上下文与缓存命中；
      //   没有（官方形状）→ 保留上一份上下文，只更新输出。
      // 回合进行中不更新上下文的话，整个回合都显示不出占用，只能等 result。
      const context = plausibleContext(contextTokens(totals), prev?.contextWindow);
      const next: UsageSnapshot = { ...(prev ?? { contextTokens: 0 }), outputTokens: totals.output };
      if (context > 0) {
        next.contextTokens = context;
        next.cacheHitRate = cacheHitRate(totals);
        Object.assign(next, inputParts(totals));
      }
      const thinking = thinkingTokensOf(ev.usage);
      if (thinking !== undefined) next.thinkingTokens = thinking;
      return next;
    }
    return undefined;
  }

  if (m.type === "result") {
    // `result.usage` / `modelUsage` 是**整轮累计**（见文件头）：一轮里几十上百次请求的
    // 输入侧会加在一起，长任务实测累到 900 万，而窗口只有 100 万。它不是任何一次请求的
    // 上下文，所以这里只取「整轮」这一层真正成立的三个数：窗口、输出、API 耗时；
    // 上下文与命中率保持上一次单次请求（message_start / message_delta）的值。
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
    const known = window ?? prev?.contextWindow;
    // 上一份快照可能已经被累计值污染（旧版本就是这么算的）：窗口这一刻已知，顺手把不可能的
    // 数清掉，否则进度环会一直顶在 100% 上，直到用户刷新页面。
    const context = plausibleContext(prev?.contextTokens ?? 0, known);
    const next: UsageSnapshot = {
      ...(prev ?? { contextTokens: 0 }),
      contextTokens: context,
      contextWindow: known,
      outputTokens: totals?.output ?? prev?.outputTokens,
      apiMs: apiMs ?? prev?.apiMs,
    };
    if (context === 0) {
      // 明细与命中率都是从那个不可能的上下文算出来的，一起摘掉。
      delete next.cacheHitRate;
      delete next.inputTokens;
      delete next.cacheReadTokens;
      delete next.cacheCreationTokens;
    }
    const thinking = thinkingTokensOf(m.usage) ?? prev?.thinkingTokens;
    if (thinking !== undefined) next.thinkingTokens = thinking;
    return next;
  }

  return undefined;
}

/**
 * 从 claude 转录（jsonl 行）还原一次用量快照。
 *
 * 为什么需要它：页面重开 / 切回旧对话时 WS 上没有实时事件，store 里的快照是空的，
 * 底部那行统计就消失了。转录里其实都有：
 *   - `assistant` 行的 `message.usage`：最近一次请求的 input/cache/output（与实时一致）；
 *   - `api-request` 行是请求发出时刻、`assistant` 行是回复落盘时刻，两者之差就是这次
 *     请求的 API 耗时（实测慢速 mock：sleep 1.5s → 差值 1517ms），用它算 tok/s；
 *   - `cost-state` 行（只在 print 模式出现）作为兜底：累计 API 耗时取相邻差值。
 * 窗口转录里没有，由调用方用设置里的模型窗口兜底。
 */
export function usageFromTranscript(lines: unknown[]): UsageSnapshot | undefined {
  let totals: UsageTotals | undefined;
  let thinking: number | undefined;
  let prevApiMs = 0;
  let apiMsFromTs: number | undefined;
  let apiMsFromCost: number | undefined;
  let lastRequestAt: number | undefined;
  let window: number | undefined;
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    const m = line as Record<string, unknown>;
    const ts = typeof m.timestamp === "string" ? Date.parse(m.timestamp) : NaN;
    if (m.type === "api-request") {
      if (Number.isFinite(ts)) lastRequestAt = ts;
    } else if (m.type === "assistant") {
      const usage = (m.message as Record<string, unknown> | undefined)?.usage;
      const t = totalsFromUsage(usage);
      if (t) totals = t;
      const th = thinkingTokensOf(usage);
      if (th !== undefined) thinking = th;
      if (lastRequestAt !== undefined && Number.isFinite(ts) && ts >= lastRequestAt) {
        apiMsFromTs = ts - lastRequestAt;
      }
      lastRequestAt = undefined;
    } else if (m.type === "cost-state") {
      if (typeof m.totalAPIDuration === "number") {
        // 每条 cost-state 都是累计值：与本条之前的差值才是「最近一回合」的 API 耗时。
        apiMsFromCost = Math.max(0, m.totalAPIDuration - prevApiMs);
        prevApiMs = m.totalAPIDuration;
      }
      const modelUsage = m.modelUsage as Record<string, unknown> | undefined;
      if (modelUsage) {
        for (const entry of Object.values(modelUsage)) {
          const w = (entry as Record<string, unknown> | undefined)?.contextWindow;
          if (typeof w === "number" && w > 0) window = w;
        }
      }
    }
  }
  const apiMs = apiMsFromTs ?? apiMsFromCost;
  if (!totals && apiMs === undefined) return undefined;
  return {
    contextTokens: totals ? contextTokens(totals) : 0,
    cacheHitRate: totals ? cacheHitRate(totals) : undefined,
    ...(totals ? inputParts(totals) : {}),
    outputTokens: totals?.output,
    thinkingTokens: thinking,
    apiMs,
    contextWindow: window,
  };
}

/**
 * 丢掉被判定为「累加值」的上下文与它派生出来的明细，只留下窗口 / 输出 / 耗时
 * 这些与「单次请求」无关、仍然成立的信息。
 */
function withoutContext(snap: UsageSnapshot): UsageSnapshot {
  return {
    contextTokens: 0,
    contextWindow: snap.contextWindow,
    outputTokens: snap.outputTokens,
    thinkingTokens: snap.thinkingTokens,
    apiMs: snap.apiMs,
  };
}

/**
 * 合并两份快照：转录回放给的是「最近一次请求」的 token 数（更准），
 * 持久化那份补上转录里没有的 API 耗时与上下文窗口。
 */
export function mergeUsage(
  persisted: UsageSnapshot | undefined,
  live: UsageSnapshot | undefined,
): UsageSnapshot | undefined {
  if (!persisted) return live;
  // 持久化那份可能是旧版本按 `result.usage`（整轮累计）写下来的，长任务里能到几百万：
  // 超过窗口就只保留窗口/耗时/输出，别把不可能的数字又画回界面上。
  const known = live?.contextWindow ?? persisted.contextWindow;
  const base =
    plausibleContext(persisted.contextTokens, known) === persisted.contextTokens
      ? persisted
      : withoutContext(persisted);
  if (!live) return base;
  return {
    contextTokens: live.contextTokens || base.contextTokens,
    cacheHitRate: live.cacheHitRate ?? base.cacheHitRate,
    inputTokens: live.inputTokens ?? base.inputTokens,
    cacheReadTokens: live.cacheReadTokens ?? base.cacheReadTokens,
    cacheCreationTokens: live.cacheCreationTokens ?? base.cacheCreationTokens,
    outputTokens: live.outputTokens ?? base.outputTokens,
    thinkingTokens: live.thinkingTokens ?? base.thinkingTokens,
    apiMs: live.apiMs ?? base.apiMs,
    contextWindow: live.contextWindow ?? base.contextWindow,
  };
}
