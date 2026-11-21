import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isValidWaitLabel,
  normalizeWaitLabel,
  resetWaitLabelCache,
  setWaitLabel,
  waitLabel,
  waitLabelWidth,
} from "./waitLabel";

// 口径：显示宽度 6–12，汉字（以及全角 / 假名 / emoji 这类宽字符）算 2，其余算 1。
// 中英混写没有额外限制——「等待中ab」是 6+2=8，合法。
describe("waitLabelWidth", () => {
  it("汉字算 2，字母数字算 1", () => {
    expect(waitLabelWidth("少女祈祷")).toBe(8);
    expect(waitLabelWidth("abcdef")).toBe(6);
    expect(waitLabelWidth("等待中ab")).toBe(8);
  });

  it("首尾空白不算宽度", () => {
    expect(waitLabelWidth("  少女祈祷  ")).toBe(8);
    expect(waitLabelWidth("")).toBe(0);
  });

  it("全角标点与 emoji 按宽字符算 2", () => {
    expect(waitLabelWidth("好好")).toBe(4);
    expect(waitLabelWidth("🐟")).toBe(2);
  });

  // 组合 emoji 里的拼接符不占位：同一个表情不该因为输入法写法不同得出不同宽度。
  it("ZWJ 与变体选择符不计宽", () => {
    expect(waitLabelWidth("\u200d\ufe0f")).toBe(0);
  });
});

describe("isValidWaitLabel", () => {
  it("宽度刚好 6 与 12 都合法", () => {
    expect(isValidWaitLabel("abcdef")).toBe(true); // 6
    expect(isValidWaitLabel("少女祈祷中")).toBe(true); // 10
    expect(isValidWaitLabel("少女祈祷中啊")).toBe(true); // 12
    expect(isValidWaitLabel("claude2fast1")).toBe(true); // 12
  });

  it("宽度不足 6 或多于 12 都不合法", () => {
    expect(isValidWaitLabel("abcde")).toBe(false); // 5
    expect(isValidWaitLabel("少女")).toBe(false); // 4
    expect(isValidWaitLabel("少女祈祷中啊呀")).toBe(false); // 14
    expect(isValidWaitLabel("claude2fast12")).toBe(false); // 13
  });

  // 早先「只许纯汉字或纯字母数字」的口径会把这些判成非法，而它们都是正常文案。
  it("中英混写合法（按宽度算）", () => {
    expect(isValidWaitLabel("等待中ab")).toBe(true); // 8
    expect(isValidWaitLabel("少女ab")).toBe(true); // 6
    expect(isValidWaitLabel("少女a")).toBe(false); // 5
  });

  it("空串合法（= 用内置文案），纯空白也算空", () => {
    expect(isValidWaitLabel("")).toBe(true);
    expect(isValidWaitLabel("   ")).toBe(true);
    expect(isValidWaitLabel("  少女祈祷  ")).toBe(true);
  });
});

describe("normalizeWaitLabel", () => {
  it("合法值去掉首尾空白后保留", () => {
    expect(normalizeWaitLabel("  少女祈祷 ")).toBe("少女祈祷");
    expect(normalizeWaitLabel("abcdef")).toBe("abcdef");
  });

  // 盘上的值不可信（手改、别的版本写的）：认不出就当没设置，计时行退回内置文案，
  // 不要让一句太长的自定义把秒数挤出那一行。
  it("不合法 / 空 / null 一律折成空串", () => {
    expect(normalizeWaitLabel("ab")).toBe("");
    expect(normalizeWaitLabel("少女祈祷中啊呀")).toBe("");
    expect(normalizeWaitLabel("")).toBe("");
    expect(normalizeWaitLabel("   ")).toBe("");
    expect(normalizeWaitLabel(null)).toBe("");
    expect(normalizeWaitLabel(undefined)).toBe("");
  });
});

describe("waitLabel 的读写", () => {
  beforeEach(() => {
    localStorage.clear();
    resetWaitLabelCache();
  });

  afterEach(() => {
    localStorage.clear();
    resetWaitLabelCache();
  });

  it("默认是空串（用内置文案），没有键", () => {
    expect(waitLabel()).toBe("");
    expect(localStorage.getItem("ccweb-wait-label")).toBeNull();
  });

  it("写进去的是 trim 后的值，读回来一致", () => {
    setWaitLabel("  少女祈祷  ");
    expect(localStorage.getItem("ccweb-wait-label")).toBe("少女祈祷");
    expect(waitLabel()).toBe("少女祈祷");
  });

  it("空串等于清掉设置（不留一个空键）", () => {
    setWaitLabel("少女祈祷");
    setWaitLabel("");
    expect(localStorage.getItem("ccweb-wait-label")).toBeNull();
    expect(waitLabel()).toBe("");
  });

  it("不合法的值不会被写进盘里", () => {
    setWaitLabel("少女祈祷");
    setWaitLabel("ab");
    expect(localStorage.getItem("ccweb-wait-label")).toBe("少女祈祷");
  });

  it("盘上已有的不合法值读出来是空串", () => {
    localStorage.setItem("ccweb-wait-label", "claude2fast12");
    expect(waitLabel()).toBe("");
  });
});
