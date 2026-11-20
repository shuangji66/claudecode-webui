import { afterEach, describe, expect, it, vi } from "vitest";
import { hasFinePointer } from "./pointer";

describe("hasFinePointer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // jsdom 没有 matchMedia：读不到就按桌面处理，不然每个测试都要桩一个。
  it("读不到 matchMedia 时按桌面（有精确指针）处理", () => {
    expect(hasFinePointer()).toBe(true);
  });

  it("按 (pointer: fine) 的匹配结果回答", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(pointer: fine)" }));
    expect(hasFinePointer()).toBe(true);

    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(hasFinePointer()).toBe(false);
  });
});
