import { describe, expect, it } from "vitest";
import { SILENT_WARN_MS, isSilentLongEnough, silentFor, silentSeconds } from "./silence";

describe("silentFor", () => {
  it("按最后一次有声算沉默时长", () => {
    expect(silentFor(100_000, 100_000 - 16_000, 0)).toBe(16_000);
  });

  // 刚发出 prompt 还没收到任何帧：沉默从发出那一刻开始算。
  // 沿用上一轮的旧帧时间会在一进对话就误报「上游很久没响应」。
  it("还没收到过帧时从本回合起点算", () => {
    expect(silentFor(100_000, undefined, 100_000 - 20_000)).toBe(20_000);
  });

  it("帧时间早于起点时以起点为准（不会把上一轮的等待算进来）", () => {
    expect(silentFor(100_000, 50_000, 95_000)).toBe(5_000);
  });

  // 同一毫秒内的竞态可能让帧时间戳比 now 还新，别报出负的沉默时长。
  it("不返回负数", () => {
    expect(silentFor(100_000, 100_500, 0)).toBe(0);
    expect(silentFor(Number.NaN, undefined, 0)).toBe(0);
  });
});

describe("isSilentLongEnough", () => {
  it("阈值是 15 秒，恰好相等也算越过", () => {
    expect(SILENT_WARN_MS).toBe(15_000);
    expect(isSilentLongEnough(14_999)).toBe(false);
    expect(isSilentLongEnough(15_000)).toBe(true);
  });
});

describe("silentSeconds", () => {
  // 15.9 秒说「15 秒」：向上取整会让人以为比实际更久。
  it("向下取整", () => {
    expect(silentSeconds(15_900)).toBe(15);
    expect(silentSeconds(0)).toBe(0);
    expect(silentSeconds(-5)).toBe(0);
  });
});
