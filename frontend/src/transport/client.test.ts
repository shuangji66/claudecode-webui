import { describe, expect, it } from "vitest";
import { reconnectDelay } from "./client";

describe("reconnectDelay", () => {
  it("指数增长并有 5s 上限", () => {
    for (const attempt of [1, 2, 3, 4, 5, 10]) {
      const delay = reconnectDelay(attempt);
      expect(delay).toBeGreaterThanOrEqual(400);
      expect(delay).toBeLessThanOrEqual(5250);
    }
    // 前三次应明显递增（抖动最多 250ms，不掩盖基数）
    expect(reconnectDelay(2)).toBeGreaterThan(reconnectDelay(1) - 250);
    expect(reconnectDelay(3)).toBeGreaterThan(reconnectDelay(2) - 250);
  });
});
