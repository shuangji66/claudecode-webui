import { describe, expect, it } from "vitest";
import {
  applyUsageMessage,
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

  it("message_delta 只更新输出 token，不清掉上下文", () => {
    const start = applyUsageMessage(undefined, MESSAGE_START)!;
    const snap = applyUsageMessage(start, {
      type: "stream_event",
      event: { type: "message_delta", usage: { output_tokens: 7 } },
    })!;
    expect(snap.contextTokens).toBe(9312);
    expect(snap.outputTokens).toBe(7);
  });

  it("result 补上 contextWindow 与 API 耗时", () => {
    const snap = applyUsageMessage(undefined, RESULT)!;
    expect(snap.contextWindow).toBe(200000);
    expect(snap.apiMs).toBe(22);
    expect(snap.outputTokens).toBe(7);
  });

  it("不认识的消息不产生快照", () => {
    expect(applyUsageMessage(undefined, { type: "assistant" })).toBeUndefined();
    expect(applyUsageMessage(undefined, "nope")).toBeUndefined();
  });
});
