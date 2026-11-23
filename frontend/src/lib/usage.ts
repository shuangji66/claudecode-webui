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
// 这里刻意**不做**的事：CLI 不提供「步骤数」「官方上下文百分比」，所以步数用工具调用
// 次数、上下文用 (input + cache_read + cache_creation) ÷ contextWindow —— 都是同一套
// 数据算出来的，不在界面上编造。
//
// tok/s 的口径（对齐 DSH 的速度计，见 `throughput`）：
//   - **分母只算 decode**：第一个 token 增量 → `message_delta`，不含首字延迟。
//     `message_start` → `message_delta` 会把这次请求的 TTFT 摊进分母，一句几十 token 的
//     短回复（工具循环里最常见）能因此读成实际速度的三分之一到七分之一；
//   - **分子分母都按窗口累加**：Σ输出 ÷ Σ生成耗时（最近 `SPEED_WINDOW` 次请求）。
//     单次请求的速度抖动极大（30 token 的 tool_use 与 800 token 的正文差好几倍），
//     拿最近一次请求的数当速度计，看起来就是「一会儿很高一会儿很低」；
//   - 攒不出来就不显示：上游把整段回复合并下发（算出来超过 `MAX_GENERATION_TPS`）时
//     宁可不显示，也不编。

import { interjectedPromptRows, isPromptRow, isTaskNotification } from "./transcriptRows";

/**
 * 取一条 user 行的正文文本（只用于「这条是不是后台任务通知」这一种判定）。
 *
 * 不复用 `normalize.textOfContent`：`normalize` 已经 import 了本文件，反向引用会成环
 * （见 `transcriptRows.ts` 的文件头）。这里只处理任务通知会出现的两种形态——
 * 纯字符串，以及 `[{type:"text",text}]`。
 *
 * **入参是整个 `message` 对象**（与 CLI 的帧一致），不是 `content`：直接往里塞一个
 * 对象进去会得到 `text.trim is not a function`（踩过一次）。
 */
function messageTextOf(message: unknown): string {
  const content = message && typeof message === "object" ? (message as { content?: unknown }).content : message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" ? (b as { text?: unknown }).text : undefined))
    .filter((t): t is string => typeof t === "string")
    .join("");
}

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
   * 最近一次请求的**纯生成耗时**（第一个 token 增量 → message_delta，毫秒）与那一次请求的
   * 输出。整轮输出 ÷ 整轮 API 耗时会把每次请求的首字延迟一起摊进去，长任务里能低到实际
   * 速度的三分之一；`message_start` → `message_delta` 同样含首字延迟，短回复能差好几倍。
   */
  genMs?: number;
  genTokens?: number;
  /**
   * 最近几次请求的速度样本（滚动窗口，最多 `SPEED_WINDOW` 条）。速度计读的是
   * Σ输出 ÷ Σ生成耗时，不是最近一次请求——单次请求的样本抖得厉害（工具循环里
   * 一次 tool_use 只有几十 token，和几百 token 的正文不是同一件事）。
   */
  speedSamples?: SpeedSample[];
  /** 本回合已量到的生成耗时 / 输出之和（= 这一轮自己的平均速度，给回答下面那行用）。 */
  turnGenMs?: number;
  turnGenTokens?: number;
  /** 输出里用于思考的 token；CLI 没给（或为 0）时为空。 */
  thinkingTokens?: number;
  /** 最近一回合的 API 耗时（整轮累计，与 `duration_api_ms` 同口径）。 */
  apiMs?: number;
  /**
   * 内部：最近一次请求的开始时刻（客户端时钟）。
   *
   * 它**不是** decode 起点（那个是 `requestFirstAt`），只在没收到任何 token 增量帧的中转上
   * 兜底当起点；回合结束时清掉。
   */
  requestStartedAt?: number;
  /** 内部：这次请求**第一个 token 增量**的到达时刻；decode 耗时从这里起算。 */
  requestFirstAt?: number;
  /**
   * 内部：第一个增量是思考还是正文。
   *
   * 用来认「中转没转发 thinking_delta」：`output_tokens` 含思考 token，一帧思考增量都没
   * 见到的话 decode 起点就无从判断（起点会是第一段正文，思考那几秒被白摘出分母），
   * 这时退回 `requestStartedAt`，宁可偏低也不虚高。
   */
  requestFirstKind?: "thinking" | "text";
}

/**
 * 一次请求的速度样本：这次请求纯生成的耗时与输出。
 *
 * `at` 是样本时刻，用来淘汰太旧的样本：半小时前（可能还是另一个模型）的速度不该继续
 * 算进「现在的速度」里。
 */
export interface SpeedSample {
  tokens: number;
  ms: number;
  at: number;
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

/**
 * 一条 assistant 帧 → CLI 的 `subagent_tokens` 口径：**最后一次请求**的 prompt + output。
 *
 * 镜像 CLI（2.1.330）的算法：`prompt_tokens = input + cache_creation + cache_read`，
 * 再加这次请求的 `output_tokens`；它不累加历史请求，所以长任务里这个数不会越滚越大
 * （`task_progress` / `task_notification` 的 `usage.total_tokens` 就是这么来的）。
 *
 * 只用来给子代理列表出**实时**数字：CLI 的进度事件只在子代理调用过工具之后才发，
 * 纯思考的子代理中途没有帧，而 `--forward-subagent-text` 转发的 assistant 帧一直带 usage。
 * `output_tokens` 为 0 的消息不算（流式中间态与工具预填充都是这种），返回 undefined。
 */
export function messageTokens(msg: unknown): number | undefined {
  if (!msg || typeof msg !== "object") return undefined;
  const m = msg as Record<string, unknown>;
  if (m.type !== "assistant") return undefined;
  const message = m.message;
  if (!message || typeof message !== "object") return undefined;
  const totals = totalsFromUsage((message as Record<string, unknown>).usage);
  if (!totals || totals.output <= 0) return undefined;
  return contextTokens(totals) + totals.output;
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

/**
 * 读 `compact_boundary` 的元数据。
 *
 * **字段名两边不同**：实时帧是 `compact_metadata` + `pre_tokens` / `post_tokens`（snake），
 * 转录里落盘成 `compactMetadata` + `preTokens` / `postTokens`（camel，2.1.329 实测）。
 * 只认一个的话，压缩提示与占用回落只在「实时看」或「重开对话」其中一边生效。
 */
export function compactMetaOf(m: Record<string, unknown>): {
  trigger: string;
  preTokens?: number;
  postTokens?: number;
} {
  const meta = (m.compact_metadata ?? m.compactMetadata) as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== "object") return { trigger: "" };
  const pick = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = meta[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  return {
    trigger: typeof meta.trigger === "string" ? meta.trigger : "",
    preTokens: pick("pre_tokens", "preTokens"),
    postTokens: pick("post_tokens", "postTokens"),
  };
}

/** 输出里用于思考的 token；字段缺失或为 0 时返回 undefined（不显示一行 0）。 */
function thinkingTokensOf(usage: unknown): number | undefined {
  const details = (usage as Record<string, unknown> | undefined)?.output_tokens_details;
  if (!details || typeof details !== "object") return undefined;
  const v = (details as Record<string, unknown>).thinking_tokens;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** 输出速度（tok/s）：输出 token ÷ 生成耗时。耗时缺失或为 0 时返回 undefined。 */
export function tokensPerSecond(outputTokens: number, apiMs: number | undefined): number | undefined {
  if (!apiMs || apiMs <= 0 || outputTokens <= 0) return undefined;
  return outputTokens / (apiMs / 1000);
}

/**
 * 速度窗口里保留几次请求的样本。
 *
 * 一轮工具循环里十几二十次请求，只留最后一次就是「速度计一会儿高一会儿低」；
 * 全都会留则换个模型之后半天不更新。8 次：短回复（几十 token）被长回复按 token
 * 加权盖住，窗口里只要有几百 token 的正文，读数就不再跳。
 */
const SPEED_WINDOW = 8;

/** 样本的有效期：超过半小时的样本在下一次测量时丢掉（换过模型就别再拿旧速度报数）。 */
const SPEED_SAMPLE_TTL_MS = 30 * 60_000;

/** 把一次请求的样本压进滚动窗口（先淘汰过期的，再截到 `SPEED_WINDOW` 条）。 */
function pushSpeedSample(prev: SpeedSample[] | undefined, sample: SpeedSample): SpeedSample[] {
  const cutoff = sample.at - SPEED_SAMPLE_TTL_MS;
  const kept = (prev ?? []).filter((s) => s.at >= cutoff && s.ms > 0 && s.tokens > 0);
  return [...kept, sample].slice(-SPEED_WINDOW);
}

/**
 * 合并两份速度样本（按样本自身去重，按时刻排序后只留窗口内的最后几条）。
 *
 * 为什么要合并而不是「谁优先」：持久化那份是上次落盘的、内存那份是这一轮刚量的，
 * 重连触发 resync 时整份覆盖会把本回合量到的样本抹掉（速度计退回上一轮的数）。
 */
export function mergeSpeedSamples(
  a: SpeedSample[] | undefined,
  b: SpeedSample[] | undefined,
): SpeedSample[] | undefined {
  if (!a?.length) return b?.length ? b.slice(-SPEED_WINDOW) : a;
  if (!b?.length) return a.slice(-SPEED_WINDOW);
  const seen = new Set<string>();
  const merged: SpeedSample[] = [];
  for (const sample of [...a, ...b]) {
    const key = `${sample.at}:${sample.ms}:${sample.tokens}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(sample);
  }
  merged.sort((x, y) => x.at - y.at);
  return merged.slice(-SPEED_WINDOW);
}

/**
 * 速度计读数（tok/s）：滚动窗口里 Σ输出 ÷ Σ生成耗时（加权，不是各次速度的平均）。
 *
 * 与 DSH 的 `decodeTokens ÷ decodeMs` 同一个口径：分母只算 decode（不含首字延迟），
 * 分子分母都按窗口累加。窗口为空（还没量到 / 全是合并下发的假样本）时退回
 * `genTokens / genMs`，再没有就不显示。
 */
export function throughput(snap: UsageSnapshot | undefined, now: number = Date.now()): number | undefined {
  if (!snap) return undefined;
  const samples = snap.speedSamples ?? [];
  if (samples.length > 0) {
    // 只算「现在还新鲜」的样本：速度计回答的是「此刻多快」，半小时前量到的数
    // 报出来只会让人以为上游还在那个速度上（关掉对话放一晚上/隔天重开最常见）。
    // TTL 只在 pushSpeedSample 里生效是不够的——那只覆盖「一直在跑」的会话。
    const cutoff = now - SPEED_SAMPLE_TTL_MS;
    let tokens = 0;
    let ms = 0;
    for (const s of samples) {
      if (s.tokens > 0 && s.ms > 0 && s.at >= cutoff) {
        tokens += s.tokens;
        ms += s.ms;
      }
    }
    // 窗口里一个新鲜样本都不剩：不显示，而不是拿旧的充数。
    return tokens > 0 && ms > 0 ? tokens / (ms / 1000) : undefined;
  }
  // 老快照（没有 speedSamples 字段）只有 genMs/genTokens 可用，按它兜底。
  return tokensPerSecond(snap.genTokens ?? 0, snap.genMs);
}

/**
 * 本回合的生成速度（tok/s）：这一轮所有已量到请求的 Σ输出 ÷ Σ生成耗时。
 *
 * 回答下面那行小字报的是「本轮消耗」，速度就取同一层的数；拿最近一次请求凑数的话，
 * 一轮三十次工具调用里最后一个往往是个短回复，读数与这一轮的实际速度无关。
 */
export function turnThroughput(snap: UsageSnapshot | undefined, now: number = Date.now()): number | undefined {
  if (!snap) return undefined;
  const tps = tokensPerSecond(snap.turnGenTokens ?? 0, snap.turnGenMs);
  return tps ?? throughput(snap, now);
}

/**
 * 进程在没有 `result` 帧的情况下结束（被杀 / 崩溃）：本回合的生成合计作废。
 *
 * 不清的话，同一 id 接着聊时「本回合速度」会把上一轮那半截生成量算进分子分母，
 * 读数偏低而且看不出原因。窗口样本（speedSamples）保留——它们是真实量到过的。
 */
export function settleTurnUsage(snap: UsageSnapshot | undefined): UsageSnapshot | undefined {
  if (!snap || (snap.turnGenMs === undefined && snap.turnGenTokens === undefined)) return snap;
  const next = { ...snap };
  delete next.turnGenMs;
  delete next.turnGenTokens;
  return next;
}

/**
 * 速度的显示文本（对齐 DSH）：≥10 取整，<10 留一位小数。
 *
 * 一位小数只给低区间：0.8 与 3.4 tok/s 的差别有意义（上游在压），而 210.4 那位小数
 * 只是抖动。
 */
export function formatSpeed(tps: number): string {
  const clamped = Number.isFinite(tps) ? Math.max(0, tps) : 0;
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
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
 *   （**上下文只认这里**，它是单次请求的数）；`content_block_delta` 只用来记下这次
 *   请求第一个 token 的时刻，`message_delta` 据此量出**纯生成耗时**（不含首字延迟），
 *   压进滚动窗口（`speedSamples`）与本回合合计（`turnGen*`）；
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

  // `system/thinking_tokens`：思考 token 的**实时估算**（redacted-thinking 阶段上游只发
  // ping，这条是唯一的进度信号）。它是估算值、不是计费口径，所以只写 thinkingTokens，
  // 绝不参与上下文/输出/合计任何一处计算。
  if (m.type === "system" && m.subtype === "thinking_tokens") {
    const est = typeof m.estimated_tokens === "number" ? m.estimated_tokens : undefined;
    if (est === undefined) return undefined;
    return { ...(prev ?? { contextTokens: 0 }), thinkingTokens: est };
  }

  // `system/compact_boundary`：压缩完成了，**上下文确实变小了**。
  //
  // 上下文占用只认「最近一次请求的输入侧」，而压缩不是一次请求：压缩完到下一次请求
  // 之间，快照里还留着压缩前那个数（实测压完 368.9K / 1M，实际只剩 9.0K），
  // 界面上就是「压了上下文，占用却没小」。所以压缩边界直接改写上下文占用：
  // `post_tokens` 是压缩后 CLI 自己算出来的实际大小，比任何推算都准。
  // 紧接着的那次请求会带着真实 usage 覆盖它，两者不会打架。
  // 明细（新输入 / 命中 / 新建缓存）与命中率描述的是「某一次请求」，压缩后已经过时，
  // 一并摘掉，等下一次请求填回来。
  if (m.type === "system" && m.subtype === "compact_boundary") {
    const post = compactMetaOf(m).postTokens;
    if (post === undefined || !(post > 0)) return undefined;
    const next: UsageSnapshot = { ...(prev ?? { contextTokens: 0 }), contextTokens: post };
    delete next.cacheHitRate;
    delete next.inputTokens;
    delete next.cacheReadTokens;
    delete next.cacheCreationTokens;
    return next;
  }

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
        requestFirstAt: undefined,
        requestFirstKind: undefined,
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
      const thinking = thinkingTokensOf(ev.usage);
      const next: UsageSnapshot = { ...(prev ?? { contextTokens: 0 }), outputTokens: totals.output };
      if (context > 0) {
        next.contextTokens = context;
        next.cacheHitRate = cacheHitRate(totals);
        Object.assign(next, inputParts(totals));
        countRequestInput(next, context);
      }
      countRequestOutput(next, totals.output);
      // 生成耗时只从**第一个 token 增量**算起（decode 口径）：`message_start` 到
      // `message_delta` 还含这次请求的首字延迟，短回复（工具循环里的 tool_use 常常只有
      // 几十 token）会被摊成实际速度的几分之一。中转不发增量帧时退回 start 帧。
      const started = prev?.requestStartedAt;
      const firstAt = prev?.requestFirstAt;
      delete next.requestStartedAt;
      delete next.requestFirstAt;
      // 这次请求有思考、但第一个增量是正文 → 中转没转发 thinking_delta（有的中转只转
      // 正文）。那样 decode 起点就落在思考结束之后，而分子里的 output 含着思考 token，
      // 速度会被虚抬好几倍；退回 `message_start`（含首字延迟，偏低不虚高）。
      const missedThinking = thinking !== undefined && (prev?.requestFirstKind ?? "text") === "text";
      const from = missedThinking ? started : (firstAt ?? started);
      delete next.requestFirstKind;
      const ms = from !== undefined && at > from ? at - from : undefined;
      if (ms !== undefined && totals.output > 0) {
        if (totals.output / (ms / 1000) <= MAX_GENERATION_TPS) {
          next.genMs = ms;
          next.genTokens = totals.output;
          next.speedSamples = pushSpeedSample(prev?.speedSamples, { tokens: totals.output, ms, at });
          next.turnGenMs = (prev?.turnGenMs ?? 0) + ms;
          next.turnGenTokens = (prev?.turnGenTokens ?? 0) + totals.output;
        } else {
          // 合并下发，量不出速度：清掉上一次的，别拿旧请求的数冒充这一次。
          // 窗口里已有的真样本照旧留着——它们量的是别的请求，不是这一次。
          delete next.genMs;
          delete next.genTokens;
        }
      }
      if (thinking !== undefined) next.thinkingTokens = thinking;
      return next;
    }
    // 逐字增量只用一个信息：这次请求的**第一个 token** 什么时候到（decode 起点）。
    // `--include-partial-messages` 下每个 token 都有一帧，但 token 计数只有
    // `message_delta` 才权威，所以其余增量不必让快照变一次（返回 undefined）。
    if (ev.type === "content_block_delta") {
      if (prev?.requestFirstAt !== undefined) return undefined;
      const delta = ev.delta as Record<string, unknown> | undefined;
      const piece =
        typeof delta?.text === "string"
          ? delta.text
          : typeof delta?.thinking === "string"
            ? delta.thinking
            : typeof delta?.partial_json === "string"
              ? delta.partial_json
              : "";
      // `ping` / `signature_delta` 这类没有正文，不算首字。
      if (!piece) return undefined;
      return {
        ...(prev ?? { contextTokens: 0 }),
        requestFirstAt: at,
        requestFirstKind: delta?.type === "thinking_delta" ? "thinking" : "text",
      };
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
    delete next.requestFirstAt;
    delete next.requestFirstKind;
    delete next.requestInputCounted;
    delete next.requestOutputCounted;
    // 回合结束：这一轮的生成耗时合计由 `TurnUsage` 带走（normalize 的 applyResult 从
    // 更新前的快照里取），快照里清空，下一轮从 0 重新累。滚动窗口 `speedSamples`
    // 不随回合清 —— 它是「这台机器现在的速度」，跨轮才稳。
    delete next.turnGenMs;
    delete next.turnGenTokens;
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

/**
 * 转录里这条 user 行是「用户的提问」（一轮的开始），而不是工具回包 / 命令回显 / 注入行。
 *
 * 判定在 `transcriptRows.isPromptRow`：原先这里自己写了一份，只挡 tool_result 与
 * 命令回显，`<task-notification>` 与附图注解会被当成提问（把上一轮的 token 结算掉）。
 * 与 `normalize` 共用同一份，别在本地另写。
 */
function isPromptLine(m: Record<string, unknown>): boolean {
  return isPromptRow(m);
}

/**
 * 从 claude 转录（jsonl 行）还原一次用量快照。
 *
 * 为什么需要它：页面重开 / 切回旧对话时 WS 上没有实时事件，store 里的快照是空的，
 * 底部那行统计就消失了。转录里其实都有：
 *   - `assistant` 行的 `message.usage`：那次请求的 input/cache/output；
 *   - `api-request` 行是请求发出时刻、`assistant` 行是回复落盘时刻，两者之差就是这次
 *     请求的**墙钟**耗时（实测慢速 mock：sleep 1.5s → 差值 1517ms）；
 *   - `cost-state` 行（只在 print 模式出现）作为兜底：累计 API 耗时取相邻差值。
 * 窗口转录里没有，由调用方用设置里的模型窗口兜底。
 *
 * 口径与实时路径对齐：上下文取**最后一次请求**；「本轮输入 / 输出 / API 耗时」是本轮
 * 所有请求之和（= `result.usage` / `duration_api_ms` 的口径）；会话累计是全转录求和。
 *
 * **这里不给生成速度（`genMs` / `genTokens`）**：转录只落到「回复写完了」这一刻，
 * 没有第一个 token 的时间，`api-request` → `assistant` 含着首字延迟。拿它当 tok/s 的
 * 分母，同一个对话「实时看 200、刷新后 60」，正是速度计看起来不准的一半原因。
 * 实测值随快照持久化（`PATCH /api/conversations {usage}`），重开对话由 `mergeUsage`
 * 优先取那份；转录这边只报 token 与墙钟耗时。
 */
export function usageFromTranscript(lines: unknown[], interjectedUUIDs?: readonly string[]): UsageSnapshot | undefined {
  let lastTotals: UsageTotals | undefined;
  let thinking: number | undefined;
  let prevApiMs = 0;
  let apiMsFromCost: number | undefined;
  let lastRequestAt: number | undefined;
  // 最后一轮：从最后一条提问行起算，遇到提问就清零。
  let turnInput = 0;
  let turnOutput = 0;
  let turnApiMs = 0;
  // 会话累计：所有请求之和（主转录已经滤掉 sidechain，不会混进子代理）。
  let sessionInput = 0;
  let sessionOutput = 0;
  let window: number | undefined;
  // 最近一次压缩之后上下文有多大（`compact_boundary` 的 `post_tokens`）。
  //
  // 上下文占用只认「最近一次请求的输入侧」，而压缩不是一次请求：压缩完到下一次请求
  // 之间，快照里还留着压缩前那个数（实测 368.9K / 1M，压缩后实际只剩 9.0K）。
  // 用户看到的就是「压了上下文，占用却没小」。后面只要发过请求就清掉它——那次请求的
  // 输入侧才是新的真实值。
  let compactedTokens: number | undefined;
  // 插话不切轮：它并进当前回合，不是新的一轮。名单来自宿主机记账
  // （`interjected_uuids`），不做推断——见 transcriptRows.interjectedPromptRows。
  const interjected = interjectedPromptRows(lines, interjectedUUIDs);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || typeof line !== "object") continue;
    const m = line as Record<string, unknown>;
    const ts = typeof m.timestamp === "string" ? Date.parse(m.timestamp) : NaN;
    if (m.type === "api-request") {
      if (Number.isFinite(ts)) lastRequestAt = ts;
    } else if (m.type === "system" && m.subtype === "compact_boundary") {
      const post = compactMetaOf(m).postTokens;
      if (post !== undefined && post > 0) compactedTokens = post;
    } else if (m.type === "user") {
      // 后台任务的唤醒通知是**新的一轮**（与 `normalize.turnsFromTranscript` 同一口径：
      // CLI 的 turnIndex 在这里递增）。不切的话，「本轮消耗」会把等待子代理的那几段
      // 一起算进来——界面上就是「本轮 87.2M tok」这种把四次唤醒加在一起的天文数字。
      const wake = isTaskNotification(messageTextOf(m.message));
      if (!wake && !isPromptLine(m)) continue;
      // 插话并进当前回合，不重置「本轮」的累计（与 `normalize.turnsFromTranscript` 同一口径）。
      if (!wake && interjected.has(index)) continue;
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
      // 真的发过一次请求：它的输入侧才是新的上下文，压缩留下的那个数作废。
      compactedTokens = undefined;
      turnInput += contextTokens(t);
      turnOutput += t.output;
      sessionInput += contextTokens(t);
      sessionOutput += t.output;
      if (requestMs !== undefined) turnApiMs += requestMs;
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
  // 压缩之后还没发过新请求：上下文占用按压缩后的实际大小报（见上面 compactedTokens）。
  const compacted = compactedTokens !== undefined;
  if (!lastTotals && apiMs === undefined && !compacted) return undefined;
  return {
    contextTokens: compacted ? compactedTokens! : lastTotals ? contextTokens(lastTotals) : 0,
    // 命中率与三项明细描述的是「最近一次请求」，压缩之后它们已经过时，不给。
    cacheHitRate: compacted ? undefined : lastTotals ? cacheHitRate(lastTotals) : undefined,
    ...(compacted || !lastTotals ? {} : inputParts(lastTotals)),
    outputTokens: turnOutput,
    turnInputTokens: turnInput,
    sessionInputTokens: sessionInput || undefined,
    sessionOutputTokens: sessionOutput || undefined,
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
    speedSamples: snap.speedSamples,
    turnGenMs: snap.turnGenMs,
    turnGenTokens: snap.turnGenTokens,
    thinkingTokens: snap.thinkingTokens,
    apiMs: snap.apiMs,
  };
}

/**
 * 合并两份快照：转录回放给的是「最近一次请求」的 token 数（更准），
 * 持久化那份补上转录里没有的 API 耗时与上下文窗口。
 *
 * **速度只认持久化那份**（`genMs` / `speedSamples` / `turnGenMs` 都是实测值）：
 * 转录里只有 `api-request` → `assistant` 的时间差，含首字延迟，拿去当生成速度正是
 * 那个「一刷新就变小一半」的来源（见 `usageFromTranscript`）。
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
    genMs: base.genMs ?? live.genMs,
    genTokens: base.genTokens ?? live.genTokens,
    // 样本取并集：两边都可能带来对方没有的那几次请求（持久化的是上次落盘的，
    // live 可能是这一轮刚量的）。整份替换会让速度计在一方为空时抖一下。
    speedSamples: mergeSpeedSamples(base.speedSamples, live.speedSamples),
    turnGenMs: base.turnGenMs ?? live.turnGenMs,
    turnGenTokens: base.turnGenTokens ?? live.turnGenTokens,
    thinkingTokens: live.thinkingTokens ?? base.thinkingTokens,
    apiMs: live.apiMs ?? base.apiMs,
    contextWindow: live.contextWindow ?? base.contextWindow,
  };
}
