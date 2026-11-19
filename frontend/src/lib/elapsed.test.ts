import { describe, expect, it } from "vitest";
import { formatDuration, formatElapsed } from "./elapsed";

describe("formatElapsed", () => {
  it("不到 1 分钟按秒显示", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(999)).toBe("0s");
    expect(formatElapsed(12_000)).toBe("12s");
    expect(formatElapsed(59_900)).toBe("59s");
  });

  it("1 分钟以上按 m:ss 显示，秒数补零", () => {
    expect(formatElapsed(60_000)).toBe("1:00");
    expect(formatElapsed(125_000)).toBe("2:05");
    expect(formatElapsed(3_599_000)).toBe("59:59");
  });

  it("超过 1 小时带小时位", () => {
    expect(formatElapsed(3_600_000)).toBe("1:00:00");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
  });

  it("负值与非数值按 0 处理，不出现「-1s」或 NaN", () => {
    expect(formatElapsed(-5000)).toBe("0s");
    expect(formatElapsed(Number.NaN)).toBe("0s");
  });
});

describe("formatDuration（已结束的耗时）", () => {
  it("一律给分:秒，秒数补零", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(12_000)).toBe("00:12");
    expect(formatDuration(59_900)).toBe("01:00");
    expect(formatDuration(293_100)).toBe("04:53");
    expect(formatDuration(293_600)).toBe("04:54"); // 四舍五入到秒
    expect(formatDuration(3_599_000)).toBe("59:59");
  });

  it("到 1 小时才带小时位", () => {
    expect(formatDuration(3_600_000)).toBe("1:00:00");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
  });

  it("毫秒四舍五入到秒", () => {
    expect(formatDuration(400)).toBe("00:00");
    expect(formatDuration(1_400)).toBe("00:01");
    expect(formatDuration(1_600)).toBe("00:02");
  });

  it("负值与非数值按 0 处理", () => {
    expect(formatDuration(-5000)).toBe("00:00");
    expect(formatDuration(Number.NaN)).toBe("00:00");
  });
});
