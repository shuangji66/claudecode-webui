import { describe, expect, it } from "vitest";
import {
  applyUsageMessage,
  mergeUsage,
  usageFromTranscript,
  cacheHitRate,
  contextPercent,
  contextTokens,
  formatCacheHit,
  formatTokens,
  sessionTotals,
  tokensPerSecond,
  totalsFromUsage,
} from "./usage";

// 下面两条是 2.1.325 实测抓到的真实帧（本地 mock API，一个 7 token 的回合）。
const MESSAGE_START = {
  type: "stream_event",
  event: {
    type: "message_start",
    message: {
      id: "msg_1",
      model: "claude-sonnet-4-5",
      usage: { input_tokens: 12, cache_creation_input_tokens: 300, cache_read_input_tokens: 9000, output_tokens: 1 },
    },
  },
};

const RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  duration_ms: 341,
  duration_api_ms: 22,
  total_cost_usd: 0.003966,
  usage: { input_tokens: 12, cache_creation_input_tokens: 300, cache_read_input_tokens: 9000, output_tokens: 7 },
  modelUsage: {
    "claude-sonnet-4-5": { inputTokens: 12, outputTokens: 7, cacheReadInputTokens: 9000, contextWindow: 200000, maxOutputTokens: 32000 },
  },
};

describe("usage totals", () => {
  it("把 CLI 的 usage 折成驼峰字段", () => {
    expect(totalsFromUsage(RESULT.usage)).toEqual({ input: 12, cacheRead: 9000, cacheCreation: 300, output: 7 });
  });

  it("全零或形状不对时返回 undefined（不显示假的 0）", () => {
    expect(totalsFromUsage(undefined)).toBeUndefined();
    expect(totalsFromUsage({})).toBeUndefined();
    expect(totalsFromUsage({ input_tokens: 0, output_tokens: 0 })).toBeUndefined();
  });

  it("上下文 = 输入侧总量，命中率 = 命中 / 输入侧", () => {
    const totals = totalsFromUsage(RESULT.usage)!;
    expect(contextTokens(totals)).toBe(9312);
    expect(cacheHitRate(totals)).toBeCloseTo(9000 / 9312, 5);
    expect(contextPercent(contextTokens(totals), 200000)).toBe(5);
    expect(contextPercent(0, 200000)).toBeUndefined();
    expect(contextPercent(9312, undefined)).toBeUndefined();
  });

  // 高命中率区间整数没有分辨力：99.2% 与 99.9% 都挤成 99%，看不出缓存吃满没有。
  it("缓存命中率 ≥99% 保留一位小数，其余取整", () => {
    expect(formatCacheHit(9000 / 9312)).toBe("97%");
    expect(formatCacheHit(0.985)).toBe("99%"); // 98.5 未到 99，取整
    expect(formatCacheHit(0.992)).toBe("99.2%");
    expect(formatCacheHit(0.9994)).toBe("99.9%");
    // 四舍五入到 100.0 的照旧写 100%，不画一个假的精确度。
    expect(formatCacheHit(0.9996)).toBe("100%");
    expect(formatCacheHit(1)).toBe("100%");
    expect(formatCacheHit(0)).toBe("0%");
  });

  it("tok/s 用输出 token ÷ API 耗时；缺耗时返回 undefined", () => {
    expect(tokensPerSecond(7, 22)).toBeCloseTo(318.18, 1);
    expect(tokensPerSecond(7, 0)).toBeUndefined();
    expect(tokensPerSecond(7, undefined)).toBeUndefined();
    expect(tokensPerSecond(0, 22)).toBeUndefined();
  });

  it("token 数用 K/M 紧凑写法（1024 进位）", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1024)).toBe("1K");
    expect(formatTokens(9312)).toBe("9.1K");
    expect(formatTokens(62.1 * 1024 * 1024)).toBe("62.1M");
  });

  // 长任务的会话累计能到十亿级：没有 B 一档时会写成「1144.4M」，三位数加单位难读。
  it("十亿级用 B 一档", () => {
    expect(formatTokens(1.2 * 1024 ** 3)).toBe("1.2B");
    expect(formatTokens(1024 ** 3)).toBe("1B");
    expect(formatTokens(1024 ** 3 - 1)).toBe("1024M");
  });
});

describe("applyUsageMessage", () => {
  it("message_start 给出上下文与缓存命中", () => {
    const snap = applyUsageMessage(undefined, MESSAGE_START)!;
    expect(snap.contextTokens).toBe(9312);
    expect(snap.cacheHitRate).toBeCloseTo(9000 / 9312, 5);
  });

  it("message_start 同时给出输入侧三项明细（新输入 / 新建缓存 / 命中缓存）", () => {
    const snap = applyUsageMessage(undefined, MESSAGE_START)!;
    expect(snap.inputTokens).toBe(12);
    expect(snap.cacheCreationTokens).toBe(300);
    expect(snap.cacheReadTokens).toBe(9000);
  });

  it("message_delta 只更新输出 token，不清掉上下文", () => {
    const start = applyUsageMessage(undefined, MESSAGE_START)!;
    const snap = applyUsageMessage(start, {
      type: "stream_event",
      event: { type: "message_delta", usage: { output_tokens: 7 } },
    })!;
    expect(snap.contextTokens).toBe(9312);
    expect(snap.outputTokens).toBe(7);
  });

  // 自建中转实测：message_start 只有全 0 占位，输入侧 token 落在 message_delta。
  // 以前这里只取 output_tokens，导致整个回合都显示不出上下文占用，只能等 result。
  it("message_delta 带输入侧时更新上下文与缓存命中", () => {
    const snap = applyUsageMessage(undefined, {
      type: "stream_event",
      event: {
        type: "message_delta",
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 1792, input_tokens: 6781, output_tokens: 10 },
      },
    })!;
    expect(snap.contextTokens).toBe(8573);
    expect(snap.cacheHitRate).toBeCloseTo(1792 / 8573, 5);
    expect(snap.outputTokens).toBe(10);
    expect(snap.inputTokens).toBe(6781);
    expect(snap.cacheReadTokens).toBe(1792);
    expect(snap.cacheCreationTokens).toBe(0);
  });

  it("已有快照时，message_delta 的输入侧覆盖旧上下文", () => {
    const start = applyUsageMessage(undefined, MESSAGE_START)!;
    const snap = applyUsageMessage(start, {
      type: "stream_event",
      event: { type: "message_delta", usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 3 } },
    })!;
    expect(snap.contextTokens).toBe(100);
    expect(snap.outputTokens).toBe(3);
  });

  // 压缩完到下一次请求之间不会再有 usage 帧：不认 compact_boundary 的 post_tokens 的话，
  // 底栏会一直显示压缩前的占用（实测 368704 / 1000000 → 实际 9254）。
  it("compact_boundary 用 post_tokens 改写上下文占用", () => {
    const before = applyUsageMessage(undefined, MESSAGE_START)!;
    const snap = applyUsageMessage(before, {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 368934, post_tokens: 9254 },
    })!;
    expect(snap.contextTokens).toBe(9254);
    // 明细与命中率描述的是上一次请求，压缩之后已经过时，等新请求填回来。
    expect(snap.cacheHitRate).toBeUndefined();
    expect(snap.inputTokens).toBeUndefined();
    expect(snap.cacheReadTokens).toBeUndefined();
  });

  it("compact_boundary 缺 post_tokens 时不动快照", () => {
    const before = applyUsageMessage(undefined, MESSAGE_START)!;
    expect(
      applyUsageMessage(before, { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto" } }),
    ).toBeUndefined();
  });

  it("压缩后的下一次请求覆盖回真实占用", () => {
    let snap = applyUsageMessage(undefined, MESSAGE_START)!;
    snap = applyUsageMessage(snap, {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 368934, post_tokens: 9254 },
    })!;
    snap = applyUsageMessage(snap, {
      type: "stream_event",
      event: { type: "message_start", message: { usage: { input_tokens: 40, cache_read_input_tokens: 9800, output_tokens: 1 } } },
    })!;
    expect(snap.contextTokens).toBe(9840);
    expect(snap.cacheHitRate).toBeCloseTo(9800 / 9840, 5);
  });

  it("result 补上 contextWindow 与 API 耗时", () => {
    const snap = applyUsageMessage(undefined, RESULT)!;
    expect(snap.contextWindow).toBe(200000);
    expect(snap.apiMs).toBe(22);
    expect(snap.outputTokens).toBe(7);
    // result 的 usage 是整轮累计，不是任何一次请求的上下文：没有单次请求的数据时宁可不显示。
    expect(snap.contextTokens).toBe(0);
  });

  // 长任务实测：一轮 213 次工具调用、3 轮下来 result.usage 累到 9.1M（cache_read 8.9M），
  // 而窗口只有 976.6K。以前把它当上下文占用，进度环直接顶满 100%。
  it("result 的整轮累计不覆盖上一次请求的上下文（长任务被 cache_read 挤爆）", () => {
    const start = applyUsageMessage(undefined, MESSAGE_START)!;
    const snap = applyUsageMessage(start, {
      type: "result",
      subtype: "success",
      duration_api_ms: 772490,
      usage: {
        input_tokens: 144486,
        cache_read_input_tokens: 8_950_000,
        cache_creation_input_tokens: 0,
        output_tokens: 30_600,
      },
      modelUsage: { "cn:deepseek-v4.1-flash": { contextWindow: 1_000_000 } },
    })!;
    expect(snap.contextTokens).toBe(9312);
    expect(snap.cacheReadTokens).toBe(9000);
    expect(snap.cacheHitRate).toBeCloseTo(9000 / 9312, 5);
    expect(contextPercent(snap.contextTokens, snap.contextWindow)).toBe(1);
    // 整轮这一层真正成立的数照旧更新：本回合输出、API 耗时、窗口。
    expect(snap.outputTokens).toBe(30_600);
    expect(snap.apiMs).toBe(772490);
    expect(snap.contextWindow).toBe(1_000_000);
  });

  // tok/s 的旧算法是「整轮输出 ÷ 整轮 API 耗时」：一次 34.7s 的回合里有 4 次请求，
  // 每次的首字延迟都摊在分母上，读出来 70 tok/s，而实际生成速度是它的三倍。
  it("按消息到达时刻量出纯生成速度，不被整轮平均拖慢", () => {
    const started = applyUsageMessage(
      undefined,
      {
        type: "stream_event",
        event: { type: "message_start", message: { usage: { input_tokens: 410, cache_read_input_tokens: 10_400, output_tokens: 1 } } },
      },
      1_000,
    )!;
    const done = applyUsageMessage(
      started,
      { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 400 } } },
      3_000,
    )!;
    expect(done.genMs).toBe(2000);
    expect(done.genTokens).toBe(400);
    expect(tokensPerSecond(done.genTokens ?? 0, done.genMs)).toBeCloseTo(200, 5);

    // 回合结束后整轮口径仍然保留（面板上的「本回合 API 耗时」），但 tok/s 继续用 gen。
    const result = applyUsageMessage(done, {
      type: "result",
      duration_api_ms: 11_300,
      usage: { input_tokens: 1640, cache_read_input_tokens: 41_600, output_tokens: 793 },
    })!;
    expect(result.apiMs).toBe(11_300);
    expect(tokensPerSecond(result.genTokens ?? 0, result.genMs)).toBeCloseTo(200, 5);
    // 旧口径：793 ÷ 11.3s = 70 tok/s，正是被误解成「模型很慢」的那个数。
    expect(Math.round(tokensPerSecond(result.outputTokens ?? 0, result.apiMs)!)).toBe(70);
  });

  it("上游把整段回复合并下发时不编造速度", () => {
    const started = applyUsageMessage(
      undefined,
      { type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } } },
      1_000,
    )!;
    const done = applyUsageMessage(
      started,
      { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 400 } } },
      1_010,
    )!;
    expect(done.genMs).toBeUndefined();
    expect(done.genTokens).toBeUndefined();
  });

  it("result 给出本轮消耗（输入含缓存 + 输出），并滚进会话累计", () => {
    const prev = { contextTokens: 9312, sessionInputTokens: 1_000_000, sessionOutputTokens: 1000 };
    const snap = applyUsageMessage(prev, {
      type: "result",
      duration_api_ms: 5000,
      usage: { input_tokens: 410, cache_read_input_tokens: 10_400, cache_creation_input_tokens: 0, output_tokens: 793 },
    })!;
    expect(snap.turnInputTokens).toBe(10_810);
    expect(snap.outputTokens).toBe(793);
    expect(snap.sessionInputTokens).toBe(1_010_810);
    expect(snap.sessionOutputTokens).toBe(1793);
  });

  it("刚接上半场（没有 prev）时不给会话累计，免得从 0 起跳", () => {
    const snap = applyUsageMessage(undefined, {
      type: "result",
      duration_api_ms: 5000,
      usage: { input_tokens: 410, cache_read_input_tokens: 10_400, output_tokens: 793 },
    })!;
    expect(snap.turnInputTokens).toBe(10_810);
    expect(snap.sessionInputTokens).toBeUndefined();
  });

  // 会话累计只在 result 到达时才有权威值：首轮跑完之前，弹层的「合计 / 输入 / 输出」
  // 本来整块都不显示（手机上整轮只能看到一根占用条）。流式阶段按请求记一份即时累计。
  it("流式阶段按请求累计本回合的输入 / 输出（供回合进行中显示）", () => {
    let snap = applyUsageMessage(
      undefined,
      {
        type: "stream_event",
        event: { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 1 } } },
      },
      1_000,
    )!;
    expect(snap.turnCountedInputTokens).toBe(1000);
    expect(snap.turnCountedOutputTokens).toBe(1);

    // 同一次请求的 delta 只补增量：输入侧已经记过（不能加第二遍），输出按最终值替换。
    snap = applyUsageMessage(
      snap,
      { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 400 } } },
      3_000,
    )!;
    expect(snap.turnCountedInputTokens).toBe(1000);
    expect(snap.turnCountedOutputTokens).toBe(400);

    // 同一回合的第二次请求（工具调用之后）：输入侧再计一次，输出继续累加。
    snap = applyUsageMessage(
      snap,
      {
        type: "stream_event",
        event: { type: "message_start", message: { usage: { input_tokens: 20, cache_read_input_tokens: 2000, output_tokens: 1 } } },
      },
      4_000,
    )!;
    snap = applyUsageMessage(
      snap,
      { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 50 } } },
      4_500,
    )!;
    expect(snap.turnCountedInputTokens).toBe(3020);
    expect(snap.turnCountedOutputTokens).toBe(450);
    expect(sessionTotals(snap)).toEqual({ input: 3020, output: 450, total: 3470 });
  });

  it("result 到达后即时累计清空、并进会话累计（同一批 token 不算两遍）", () => {
    const streaming = {
      contextTokens: 3020,
      turnCountedInputTokens: 3020,
      turnCountedOutputTokens: 450,
    };
    const snap = applyUsageMessage(streaming, {
      type: "result",
      duration_api_ms: 3000,
      usage: { input_tokens: 120, cache_read_input_tokens: 2900, output_tokens: 450 },
    })!;
    expect(snap.turnCountedInputTokens).toBeUndefined();
    expect(snap.turnCountedOutputTokens).toBeUndefined();
    // 会话累计 = result.usage 的整轮汇总（不是 3020 + 3020）
    expect(snap.sessionInputTokens).toBe(3020);
    expect(snap.sessionOutputTokens).toBe(450);
    expect(sessionTotals(snap)).toEqual({ input: 3020, output: 450, total: 3470 });
  });

  // 自建中转会把完整 usage 落在 message_delta、start 只给全 0 占位：不能因为
  // start 没数就漏掉输入侧，也不能两帧都带时加两遍。
  it("输入侧落在 message_delta 时照样计入即时累计", () => {
    let snap = applyUsageMessage(
      undefined,
      { type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 0 } } } },
      1_000,
    )!;
    expect(snap.turnCountedInputTokens).toBeUndefined();
    snap = applyUsageMessage(
      snap,
      {
        type: "stream_event",
        event: { type: "message_delta", usage: { input_tokens: 6781, cache_read_input_tokens: 1792, output_tokens: 10 } },
      },
      2_000,
    )!;
    expect(snap.turnCountedInputTokens).toBe(8573);
    expect(snap.turnCountedOutputTokens).toBe(10);
  });

  // 中断 / 进程收尾时 CLI 有时只给 modelUsage、不给 usage：那一轮确实发过请求，
  // 即时累计是唯一的数。不并进会话累计、也不清空的话，下一轮的即时累计会接着往上
  // 加，弹层里「合计 / 输入 / 输出」整轮都虚高上一轮那一截。
  it("result 没带 usage 时，即时累计并进会话累计后清空（不留给下一轮）", () => {
    let snap = applyUsageMessage(
      undefined,
      { type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 1000, output_tokens: 5 } } } },
      1_000,
    )!;
    expect(sessionTotals(snap).input).toBe(1000);

    snap = applyUsageMessage(
      snap,
      { type: "result", subtype: "error_during_execution", modelUsage: { m: { contextWindow: 200_000 } } },
      2_000,
    )!;
    // 那一轮的 1000 已经并进会话累计，即时累计归零。
    expect(snap.turnCountedInputTokens).toBeUndefined();
    expect(snap.sessionInputTokens).toBe(1000);

    // 第二轮：即时累计只算这一轮的 2000，不叠上一轮。
    snap = applyUsageMessage(
      snap,
      { type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 2000, output_tokens: 5 } } } },
      3_000,
    )!;
    expect(sessionTotals(snap).input).toBe(3000);
    expect(snap.turnCountedInputTokens).toBe(2000);
  });

  it("窗口已知时，超过窗口的旧上下文在回合末被清掉", () => {
    const snap = applyUsageMessage(
      { contextTokens: 9_100_000, cacheHitRate: 0.98, inputTokens: 141_100, cacheReadTokens: 8_900_000 },
      { type: "result", duration_api_ms: 1000, usage: { output_tokens: 12 }, modelUsage: { m: { contextWindow: 1_000_000 } } },
    )!;
    expect(snap.contextTokens).toBe(0);
    expect(snap.cacheHitRate).toBeUndefined();
    expect(snap.inputTokens).toBeUndefined();
    expect(snap.cacheReadTokens).toBeUndefined();
  });

  it("已知窗口时，超过窗口的流式上下文不采信（自建中转可能塞累计值）", () => {
    const prev = { contextTokens: 9312, contextWindow: 200000 };
    const snap = applyUsageMessage(prev, {
      type: "stream_event",
      event: { type: "message_delta", usage: { input_tokens: 12, cache_read_input_tokens: 900_000, output_tokens: 5 } },
    })!;
    expect(snap.contextTokens).toBe(9312);
    expect(snap.outputTokens).toBe(5);
  });

  it("result 带 usage 明细与思考 token（0 的不显示）", () => {
    const snap = applyUsageMessage(undefined, {
      type: "result",
      duration_api_ms: 5000,
      usage: {
        input_tokens: 6781,
        cache_read_input_tokens: 1792,
        cache_creation_input_tokens: 0,
        output_tokens: 2300,
        output_tokens_details: { thinking_tokens: 1200 },
      },
    })!;
    // 输入侧三项也是整轮累计，不再摊到面板上；思考 token 是整轮汇总，仍然有意义。
    expect(snap.inputTokens).toBeUndefined();
    expect(snap.cacheReadTokens).toBeUndefined();
    expect(snap.thinkingTokens).toBe(1200);

    const noThinking = applyUsageMessage(undefined, {
      type: "result",
      usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { thinking_tokens: 0 } },
    })!;
    expect(noThinking.thinkingTokens).toBeUndefined();
  });

  it("不认识的消息不产生快照", () => {
    expect(applyUsageMessage(undefined, { type: "assistant" })).toBeUndefined();
    expect(applyUsageMessage(undefined, "nope")).toBeUndefined();
  });
});

describe("usageFromTranscript", () => {
  // 真实转录里的一回合：assistant 行带 usage，cost-state 行带累计 API 耗时。
  const LINES = [
    { type: "user", message: { role: "user", content: "hi" } },
    {
      type: "assistant",
      message: { role: "assistant", usage: { input_tokens: 12, cache_creation_input_tokens: 300, cache_read_input_tokens: 9000, output_tokens: 7 } },
    },
    { type: "cost-state", totalAPIDuration: 23, modelUsage: { "claude-sonnet-4-5": { outputTokens: 7 } } },
  ];

  it("重开对话时能从转录还原上下文 / 缓存命中 / 输出", () => {
    const snap = usageFromTranscript(LINES)!;
    expect(snap.contextTokens).toBe(9312);
    expect(snap.cacheHitRate).toBeCloseTo(9000 / 9312, 5);
    expect(snap.outputTokens).toBe(7);
    expect(snap.apiMs).toBe(23);
    expect(snap.inputTokens).toBe(12);
    expect(snap.cacheReadTokens).toBe(9000);
    expect(snap.cacheCreationTokens).toBe(300);
  });

  it("多条 cost-state 时用差值算最近一回合的 API 耗时", () => {
    const snap = usageFromTranscript([
      ...LINES,
      { type: "assistant", message: { usage: { input_tokens: 12, cache_read_input_tokens: 9000, output_tokens: 5 } } },
      { type: "cost-state", totalAPIDuration: 40, modelUsage: {} },
    ])!;
    expect(snap.apiMs).toBe(17);
    // 同一轮里的两次请求：输出取和（这一轮一共写了 12 tok），上下文仍是最新那次请求的。
    expect(snap.outputTokens).toBe(12);
    expect(snap.turnInputTokens).toBe(9312 + 9012);
  });

  it("用 api-request → assistant 的时间戳算本回合 API 耗时（交互模式没有 cost-state）", () => {
    const snap = usageFromTranscript([
      { type: "api-request", timestamp: "2026-11-16T10:50:42.453Z" },
      {
        type: "assistant",
        timestamp: "2026-11-16T10:50:43.970Z",
        message: { usage: { input_tokens: 12, cache_read_input_tokens: 9000, output_tokens: 7 } },
      },
    ])!;
    expect(snap.apiMs).toBe(1517);
    expect(snap.outputTokens).toBe(7);
    expect(snap.contextTokens).toBe(9012);
  });

  it("转录里没有 usage 时返回 undefined，不编数字", () => {
    expect(usageFromTranscript([{ type: "user", message: { content: "hi" } }])).toBeUndefined();
    expect(usageFromTranscript([])).toBeUndefined();
  });

  // 压缩不是一次请求，边界行里才有压缩后的真实大小（`post_tokens`）。
  // 不认它的话，压缩完到下一次请求之间底栏还挂着压缩前的数——
  // 实测 368.9K / 1M 压完只剩 9.0K，界面上就是「压了上下文，占用却没小」。
  const BIG_TURN = {
    type: "assistant",
    message: { usage: { input_tokens: 320, cache_read_input_tokens: 368384, output_tokens: 2207 } },
  };
  const BOUNDARY = {
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "manual", pre_tokens: 368934, post_tokens: 9000 },
  };

  it("压缩之后按 post_tokens 报上下文，不留在压缩前的数上", () => {
    const snap = usageFromTranscript([
      { type: "user", message: { content: "hi" } },
      BIG_TURN,
      BOUNDARY,
      // 压缩后 CLI 塞回来的续接提示（一条 16KB 的 user 行），它不是新的一轮。
      { type: "user", isCompactSummary: true, message: { content: "This session is being continued from…" } },
    ])!;
    expect(snap.contextTokens).toBe(9000);
    // 明细与命中率描述的是「上一次请求」，压缩后已经过时。
    expect(snap.cacheHitRate).toBeUndefined();
    expect(snap.inputTokens).toBeUndefined();
  });

  it("压缩之后又发过请求时，以那次请求的输入侧为准", () => {
    const snap = usageFromTranscript([
      { type: "user", message: { content: "hi" } },
      BIG_TURN,
      BOUNDARY,
      { type: "user", message: { content: "接着来" } },
      { type: "assistant", message: { usage: { input_tokens: 100, cache_read_input_tokens: 4400, output_tokens: 50 } } },
    ])!;
    expect(snap.contextTokens).toBe(4500);
    expect(snap.inputTokens).toBe(100);
  });
});

describe("mergeUsage", () => {
  it("转录的 token 数优先，持久化那份补 API 耗时与窗口", () => {
    const persisted = { contextTokens: 5000, contextWindow: 200000, apiMs: 40, outputTokens: 3 };
    const live = { contextTokens: 9312, cacheHitRate: 0.96, outputTokens: 7 };
    expect(mergeUsage(persisted, live)).toEqual({
      contextTokens: 9312,
      cacheHitRate: 0.96,
      outputTokens: 7,
      apiMs: 40,
      contextWindow: 200000,
    });
  });

  it("只有一边时原样返回；都没有返回 undefined", () => {
    const only = { contextTokens: 1 };
    expect(mergeUsage(undefined, only)).toBe(only);
    expect(mergeUsage(only, undefined)).toBe(only);
    expect(mergeUsage(undefined, undefined)).toBeUndefined();
  });

  // 旧版本会把 result.usage（整轮累计）写进 conversations.json，重开对话时不能又画回来。
  it("持久化那份超过了窗口就只留窗口/耗时，不再当成上下文", () => {
    const persisted = { contextTokens: 9_100_000, contextWindow: 1_000_000, apiMs: 40, outputTokens: 3 };
    expect(mergeUsage(persisted, undefined)).toEqual({
      contextTokens: 0,
      contextWindow: 1_000_000,
      apiMs: 40,
      outputTokens: 3,
    });

    const live = { contextTokens: 151_000, cacheHitRate: 0.98, outputTokens: 7 };
    expect(mergeUsage(persisted, live)).toEqual({
      contextTokens: 151_000,
      cacheHitRate: 0.98,
      outputTokens: 7,
      apiMs: 40,
      contextWindow: 1_000_000,
    });
  });
});
