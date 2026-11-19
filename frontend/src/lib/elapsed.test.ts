import { describe, expect, it } from "vitest";
import { formatDuration, formatDurationWords, formatElapsed } from "./elapsed";

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

// 收起行那一句「已完成，用时 3 分 15 秒」：读它的时候不想做算术，所以用口语写法。
describe("formatDurationWords（口语写法）", () => {
  it("分秒按中文习惯拼", () => {
    expect(formatDurationWords(195_000)).toBe("3 分 15 秒");
    expect(formatDurationWords(45_000)).toBe("45 秒");
    expect(formatDurationWords(120_000)).toBe("2 分");
  });

  it("0 的位省掉（有分钟就不再报「0 秒」）", () => {
    expect(formatDurationWords(180_000)).toBe("3 分");
    expect(formatDurationWords(0)).toBe("0 秒");
  });

  it("一小时以上带小时位", () => {
    expect(formatDurationWords(3_723_000)).toBe("1 小时 2 分 3 秒");
    expect(formatDurationWords(3_600_000)).toBe("1 小时");
  });

  it("毫秒四舍五入到秒，负数与非数值按 0", () => {
    expect(formatDurationWords(195_600)).toBe("3 分 16 秒");
    expect(formatDurationWords(-5000)).toBe("0 秒");
    expect(formatDurationWords(Number.NaN)).toBe("0 秒");
  });
});
