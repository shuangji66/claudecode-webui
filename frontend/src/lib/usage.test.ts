import { describe, expect, it } from "vitest";
import {
  applyUsageMessage,
  mergeUsage,
  usageFromTranscript,
  cacheHitRate,
  contextPercent,
  contextTokens,
  formatTokens,
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

  it("tok/s 用输出 token ÷ API 耗时；缺耗时返回 undefined", () => {
    expect(tokensPerSecond(7, 22)).toBeCloseTo(318.18, 1);
    expect(tokensPerSecond(7, 0)).toBeUndefined();
    expect(tokensPerSecond(7, undefined)).toBeUndefined();
    expect(tokensPerSecond(0, 22)).toBeUndefined();
  });

  it("token 数用 K/M 紧凑写法", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1024)).toBe("1K");
    expect(formatTokens(9312)).toBe("9.1K");
    expect(formatTokens(62.1 * 1024 * 1024)).toBe("62.1M");
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

  it("result 补上 contextWindow 与 API 耗时", () => {
    const snap = applyUsageMessage(undefined, RESULT)!;
    expect(snap.contextWindow).toBe(200000);
    expect(snap.apiMs).toBe(22);
    expect(snap.outputTokens).toBe(7);
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
    expect(snap.inputTokens).toBe(6781);
    expect(snap.cacheReadTokens).toBe(1792);
    expect(snap.cacheCreationTokens).toBe(0);
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
    expect(snap.outputTokens).toBe(5);
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
});
