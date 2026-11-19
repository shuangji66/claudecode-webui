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
  /** 本回合的输出 token 合计（整轮累计口径，与 `turnInputTokens` 配套）。 */
  outputTokens?: number;
  /**
   * 本回合的**输入侧合计**（含缓存读取与写入），来自 `result.usage` 或转录里本回合所有
   * assistant 行之和。这是「这一轮一共吃了多少 token」，与 `contextTokens`（当前上下文多大）
   * 是两回事：一轮几十次请求会把它累到几百万，而窗口始终只有那么大。
   */
  turnInputTokens?: number;
  /** 会话累计消耗：所有已发生请求的输入侧合计（含缓存），转录回放时重算。 */
  sessionInputTokens?: number;
  /** 会话累计消耗：所有已发生请求的输出合计。 */
  sessionOutputTokens?: number;
  /**
   * **当前回合里已经发出去的请求**的输入侧 / 输出合计（含缓存）。
   *
   * 会话累计只在 `result` 到达时才有权威值，首轮跑完之前弹层里就没有「合计 / 输入 /
   * 输出」这三行（手机上第一轮尤其明显：整轮都在跑，只能看到一个光秃秃的占用条）。
   * 所以流式阶段先把每一次请求的量计在这里，由 `sessionTotals` 与会话累计一起显示；
   * `result` 一到，`result.usage`（整轮汇总）折进 `session*Tokens`，这两个归零——
   * 不归零同一批 token 会被算两遍。
   */
  turnCountedInputTokens?: number;
  turnCountedOutputTokens?: number;
  /** 内部：当前这次请求的输入侧是否已经计进 `turnCountedInputTokens`（start / delta 只算一遍）。 */
  requestInputCounted?: boolean;
  /** 内部：当前这次请求已经计进 `turnCountedOutputTokens` 的输出（个别中转会连发多条 delta）。 */
  requestOutputCounted?: number;
  /**
   * 最近一次请求的**纯生成耗时**（message_start → message_delta，毫秒）与那一次请求的输出。
   * tok/s 只认这一对：整轮输出 ÷ 整轮 API 耗时会把每次请求的首字延迟一起摊进去，
   * 长任务里能低到实际速度的三分之一。
   */
  genMs?: number;
  genTokens?: number;
  /** 输出里用于思考的 token；CLI 没给（或为 0）时为空。 */
  thinkingTokens?: number;
  /** 最近一回合的 API 耗时（整轮累计，与 `duration_api_ms` 同口径）。 */
  apiMs?: number;
  /** 内部：最近一次请求的开始时刻（客户端时钟），只用来量 genMs，回合结束时清掉。 */
  requestStartedAt?: number;
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

/**
 * 缓存命中率的显示文案：≥99% 时保留一位小数，否则取整。
 *
 * 高命中率区间里整数没有分辨力——99.2% 与 99.9% 都显示成「99%」和「100%」，
 * 看不出缓存到底有没有被吃满（长会话里这是最常看的一个数）。低区间反过来，
 * 小数位只是噪音。正好 100%（命中 == 输入侧）直接写 100%，不写成 100.0%。
 */
export function formatCacheHit(rate: number): string {
  const pct = rate * 100;
  if (pct < 99) return `${Math.round(pct)}%`;
  // 99.96 这类四舍五入到「100.0」的照旧写 100%，别画出一个假的精确度。
  const one = pct.toFixed(1);
  return one === "100.0" ? "100%" : `${one}%`;
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

/**
 * 12.4K / 1.2M / 1.2B 这种紧凑写法（按 1024 进位，和上下文窗口的习惯一致）。
 *
 * 长任务里会话累计能到十亿级（一轮几十次请求、每次输入侧几十万），没有 `B` 一档时
 * 会写成 `1144.4M`——三位数加单位既难读又容易和 M 混淆。
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1024) return String(Math.round(n));
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, "")}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")}M`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, "")}B`;
}

/**
 * 生成速度的上限：真模型没有超过这个数的。超过它只说明上游把整段回复合并后才下发
 * （流式两帧几乎同时到达），那时候量出来的「速度」是假的，宁可不显示。
 */
const MAX_GENERATION_TPS = 1000;

/**
 * 把「这次请求的输入侧」计进本回合的即时累计（只算一次）。
 *
 * `message_start` 与 `message_delta` 都可能带输入侧（官方形状在 start、自建中转常反过来），
 * 同一次请求两帧都带时不能加两遍，所以用一个标记认「这次请求已经记过了」。
 */
function countRequestInput(snap: UsageSnapshot, inputSide: number): void {
  if (snap.requestInputCounted || inputSide <= 0) return;
  snap.requestInputCounted = true;
  snap.turnCountedInputTokens = (snap.turnCountedInputTokens ?? 0) + inputSide;
}

/**
 * 把「这次请求的输出」计进本回合的即时累计。
 *
 * `output_tokens` 在同一次请求里是**累计值**（start 给 1、delta 给最终值），所以只加增量；
 * 个别中转会连发多条 delta，增量口径天然不会重复。
 */
function countRequestOutput(snap: UsageSnapshot, output: number): void {
  const counted = snap.requestOutputCounted ?? 0;
  if (output <= counted) return;
  snap.requestOutputCounted = output;
  snap.turnCountedOutputTokens = (snap.turnCountedOutputTokens ?? 0) + (output - counted);
}

/**
 * 弹层要显示的会话累计（输入 / 输出 / 合计）。
 *
 * 权威值是 `session*Tokens`，但它只在 `result` 到达时才有——首轮跑完之前弹层里
 * 「合计 / 输入 / 输出」那三行是空的，手机上整轮在跑时就只剩一根占用条。所以再加一份
 * **本回合已经发出去的请求**的即时累计；`result` 一到即时累计归零、数值并进会话累计，
 * 同一批 token 不会算两遍。
 */
export function sessionTotals(snap: UsageSnapshot | undefined): {
  input: number;
  output: number;
  total: number;
} {
  const input = (snap?.sessionInputTokens ?? 0) + (snap?.turnCountedInputTokens ?? 0);
  const output = (snap?.sessionOutputTokens ?? 0) + (snap?.turnCountedOutputTokens ?? 0);
  return { input, output, total: input + output };
}

/**
 * 从一条 CLI 原始消息更新快照。
 *
 * - `stream_event` 的 message_start / message_delta：流式期间就能更新上下文与输出
 *   （**上下文只认这里**，它是单次请求的数）；顺带用两帧的到达时刻量出这一请求的
 *   纯生成耗时（`genMs` / `genTokens`），tok/s 靠它，不靠整轮平均；
 * - `result`：回合结束，补上窗口、整轮输出与整轮输入（`turnInputTokens`，这是「消耗」），
 *   并把本回合加进会话累计。它的 usage 是整轮累计，所以不碰上下文。
 *
 * `at` 是这条消息的到达时刻（毫秒）。默认取当前时间，测试里传固定值。
 * 不认识的形状原样返回，调用方据此决定要不要 set。
 */
export function applyUsageMessage(
  prev: UsageSnapshot | undefined,
  msg: unknown,
  at: number = Date.now(),
): UsageSnapshot | undefined {
  if (!msg || typeof msg !== "object") return undefined;
  const m = msg as Record<string, unknown>;

  if (m.type === "stream_event") {
    const ev = m.event as Record<string, unknown> | undefined;
    if (!ev) return undefined;
    if (ev.type === "message_start") {
      const usage = (ev.message as Record<string, unknown> | undefined)?.usage;
      const totals = totalsFromUsage(usage);
      // 新请求开始了：记下时刻，等 message_delta 到达时量这一段生成花了多久。
      // 只有 output 占位的 start 也要记（官方形状的输入侧全在 delta 里）。
      const started = {
        ...(prev ?? { contextTokens: 0 }),
        requestStartedAt: at,
        requestInputCounted: false,
        requestOutputCounted: 0,
      };
      if (!totals) return started;
      // 只有带输入侧时才更新上下文（start 里只有 output 的时候别把已知的上下文抹成 0）。
      // 已知窗口时再挡一层：超过窗口的数不可能是「这次请求的上下文」（自建中转可能把
      // 累计值塞进单条 usage），宁可保留上一份也不画不可能的数字。
      const context = plausibleContext(contextTokens(totals), prev?.contextWindow);
      const next: UsageSnapshot = { ...started, outputTokens: totals.output };
      if (context > 0) {
        next.contextTokens = context;
        next.cacheHitRate = cacheHitRate(totals);
        Object.assign(next, inputParts(totals));
        countRequestInput(next, context);
      }
      countRequestOutput(next, totals.output);
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
        countRequestInput(next, context);
      }
      countRequestOutput(next, totals.output);
      // 纯生成耗时：start 帧到 delta 帧（start 是上游开始回话，已含首字延迟之外的部分）。
      const started = prev?.requestStartedAt;
      delete next.requestStartedAt;
      if (started !== undefined && at > started && totals.output > 0) {
        const ms = at - started;
        if (totals.output / (ms / 1000) <= MAX_GENERATION_TPS) {
          next.genMs = ms;
          next.genTokens = totals.output;
        } else {
          // 合并下发，量不出速度：清掉上一次的，别拿旧请求的数冒充这一次。
          delete next.genMs;
          delete next.genTokens;
        }
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
    // 上下文，所以这里只取「整轮」这一层真正成立的数：窗口、整轮输出、整轮输入、API 耗时；
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
    const turnInput = totals ? contextTokens(totals) : undefined;
    const next: UsageSnapshot = {
      ...(prev ?? { contextTokens: 0 }),
      contextTokens: context,
      contextWindow: known,
      outputTokens: totals?.output ?? prev?.outputTokens,
      apiMs: apiMs ?? prev?.apiMs,
    };
    delete next.requestStartedAt;
    delete next.requestInputCounted;
    delete next.requestOutputCounted;
    if (turnInput !== undefined) {
      next.turnInputTokens = turnInput;
      // 会话累计：只在本进程里滚（`prev` 在就说明这一路的事件都看到了）。`prev` 空着
      // 说明这是刚接上的半场，宁可不给数，也不要给一个从 0 起跳的假总量。
      if (prev) {
        // `result.usage` 是本回合的权威汇总：流式阶段按请求攒下的即时累计（`turnCounted*`）
        // 在这里被它取代，**不能相加**，否则同一批 token 会被算两遍。
        next.sessionInputTokens = (prev.sessionInputTokens ?? 0) + turnInput;
        if (totals) next.sessionOutputTokens = (prev.sessionOutputTokens ?? 0) + totals.output;
      }
    } else if (prev && totals === undefined) {
      // 这条 result 没带 `usage`（中断 / 进程收尾时常见，有的版本只给 modelUsage）。
      // 那一轮**确实发过请求**，流式阶段按请求攒下的即时累计就是唯一的数：并进会话
      // 累计再清掉，别把它留在 `turnCounted*` 里——下一轮的即时累计会接着往上加，
      // 弹层里「合计 / 输入 / 输出」在整轮里都虚高上一轮那一截（复现过：1000 + 2000
      // 报成 3000）。并进去而不是直接丢，是因为那些 token 真的花掉了。
      next.sessionInputTokens = (prev.sessionInputTokens ?? 0) + (prev.turnCountedInputTokens ?? 0);
      next.sessionOutputTokens = (prev.sessionOutputTokens ?? 0) + (prev.turnCountedOutputTokens ?? 0);
    }
    // 回合结束，即时累计一律清空（不管上面走了哪条分支）：它的生命周期就是「一个回合」。
    delete next.turnCountedInputTokens;
    delete next.turnCountedOutputTokens;
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

/** 转录里这条 user 行是「用户的提问」（一轮的开始），而不是工具回包或命令回显。 */
function isPromptLine(m: Record<string, unknown>): boolean {
  const content = (m.message as Record<string, unknown> | undefined)?.content;
  if (typeof content === "string") {
    const text = content.trim();
    // /model 这类本地命令的回显也是 user 行，它不结束也不开始一轮。
    return text !== "" && !text.startsWith("<command-name>") && !text.startsWith("<local-command-");
  }
  if (!Array.isArray(content)) return false;
  return !content.some((b) => (b as Record<string, unknown> | undefined)?.type === "tool_result");
}

/**
 * 从 claude 转录（jsonl 行）还原一次用量快照。
 *
 * 为什么需要它：页面重开 / 切回旧对话时 WS 上没有实时事件，store 里的快照是空的，
 * 底部那行统计就消失了。转录里其实都有：
 *   - `assistant` 行的 `message.usage`：那次请求的 input/cache/output；
 *   - `api-request` 行是请求发出时刻、`assistant` 行是回复落盘时刻，两者之差就是这次
 *     请求的耗时（实测慢速 mock：sleep 1.5s → 差值 1517ms）；
 *   - `cost-state` 行（只在 print 模式出现）作为兜底：累计 API 耗时取相邻差值。
 * 窗口转录里没有，由调用方用设置里的模型窗口兜底。
 *
 * 口径与实时路径对齐：上下文取**最后一次请求**；「本轮输入 / 输出 / API 耗时」是本轮
 * 所有请求之和（= `result.usage` / `duration_api_ms` 的口径）；会话累计是全转录求和。
 */
export function usageFromTranscript(lines: unknown[]): UsageSnapshot | undefined {
  let lastTotals: UsageTotals | undefined;
  let thinking: number | undefined;
  let prevApiMs = 0;
  let apiMsFromCost: number | undefined;
  let lastRequestAt: number | undefined;
  // 最近一次请求自己的耗时与输出（算 tok/s 用），与「整轮」区分开。
  let genMs: number | undefined;
  let genTokens: number | undefined;
  // 最后一轮：从最后一条提问行起算，遇到提问就清零。
  let turnInput = 0;
  let turnOutput = 0;
  let turnApiMs = 0;
  // 会话累计：所有请求之和（主转录已经滤掉 sidechain，不会混进子代理）。
  let sessionInput = 0;
  let sessionOutput = 0;
  let window: number | undefined;
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    const m = line as Record<string, unknown>;
    const ts = typeof m.timestamp === "string" ? Date.parse(m.timestamp) : NaN;
    if (m.type === "api-request") {
      if (Number.isFinite(ts)) lastRequestAt = ts;
    } else if (m.type === "user") {
      if (!isPromptLine(m)) continue;
      turnInput = 0;
      turnOutput = 0;
      turnApiMs = 0;
    } else if (m.type === "assistant") {
      const usage = (m.message as Record<string, unknown> | undefined)?.usage;
      const t = totalsFromUsage(usage);
      const th = thinkingTokensOf(usage);
      if (th !== undefined) thinking = th;
      // 请求结束就要清掉起点，否则下一条 assistant 会算出一条跨两次请求的耗时。
      const requestMs =
        lastRequestAt !== undefined && Number.isFinite(ts) && ts >= lastRequestAt ? ts - lastRequestAt : undefined;
      lastRequestAt = undefined;
      if (!t) continue;
      lastTotals = t;
      turnInput += contextTokens(t);
      turnOutput += t.output;
      sessionInput += contextTokens(t);
      sessionOutput += t.output;
      if (requestMs !== undefined) {
        turnApiMs += requestMs;
        genMs = requestMs;
        genTokens = t.output;
      }
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
  const apiMs = turnApiMs > 0 ? turnApiMs : apiMsFromCost;
  if (!lastTotals && apiMs === undefined) return undefined;
  return {
    contextTokens: lastTotals ? contextTokens(lastTotals) : 0,
    cacheHitRate: lastTotals ? cacheHitRate(lastTotals) : undefined,
    ...(lastTotals ? inputParts(lastTotals) : {}),
    outputTokens: turnOutput,
    turnInputTokens: turnInput,
    sessionInputTokens: sessionInput || undefined,
    sessionOutputTokens: sessionOutput || undefined,
    genMs,
    genTokens,
    thinkingTokens: thinking,
    apiMs,
    contextWindow: window,
  };
}

/**
 * 丢掉被判定为「累加值」的上下文与它派生出来的明细，只留下窗口 / 输出 / 消耗 / 耗时
 * 这些与「单次请求的上下文」无关、仍然成立的信息。
 */
function withoutContext(snap: UsageSnapshot): UsageSnapshot {
  return {
    contextTokens: 0,
    contextWindow: snap.contextWindow,
    outputTokens: snap.outputTokens,
    turnInputTokens: snap.turnInputTokens,
    sessionInputTokens: snap.sessionInputTokens,
    sessionOutputTokens: snap.sessionOutputTokens,
    genMs: snap.genMs,
    genTokens: snap.genTokens,
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
    turnInputTokens: live.turnInputTokens ?? base.turnInputTokens,
    sessionInputTokens: live.sessionInputTokens ?? base.sessionInputTokens,
    sessionOutputTokens: live.sessionOutputTokens ?? base.sessionOutputTokens,
    genMs: live.genMs ?? base.genMs,
    genTokens: live.genTokens ?? base.genTokens,
    thinkingTokens: live.thinkingTokens ?? base.thinkingTokens,
    apiMs: live.apiMs ?? base.apiMs,
    contextWindow: live.contextWindow ?? base.contextWindow,
  };
}
