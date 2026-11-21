import { describe, expect, it } from "vitest";
import { LOGIN_TTL_DEFAULT, LOGIN_TTL_MAX, LOGIN_TTL_MIN, TCP_PORT_MAX, TCP_PORT_MIN, clampLoginTTL, validTCPPort } from "./access";

describe("validTCPPort", () => {
  it("接受范围内端口", () => {
    expect(validTCPPort(TCP_PORT_MIN)).toBe(true);
    expect(validTCPPort("3141")).toBe(true);
    expect(validTCPPort(TCP_PORT_MAX)).toBe(true);
  });

  it("拒绝特权端口与越界端口", () => {
    expect(validTCPPort(80)).toBe(false);
    expect(validTCPPort("1024")).toBe(false);
    expect(validTCPPort(65536)).toBe(false);
    expect(validTCPPort(0)).toBe(false);
  });

  it("拒绝非整数与空值", () => {
    expect(validTCPPort("3141.5")).toBe(false);
    expect(validTCPPort("")).toBe(false);
    expect(validTCPPort("abc")).toBe(false);
  });
});

describe("clampLoginTTL", () => {
  it("落在 12/24/36/48/60/72 这些档位上", () => {
    for (const v of [12, 24, 36, 48, 60, 72]) expect(clampLoginTTL(v)).toBe(v);
  });

  it("不在档位上的值归到最近档位", () => {
    expect(clampLoginTTL(28)).toBe(24);
    expect(clampLoginTTL(30)).toBe(36); // 正好一半时向上归（Math.round）
    expect(clampLoginTTL(31)).toBe(36);
    expect(clampLoginTTL(7)).toBe(LOGIN_TTL_MIN);
  });

  it("越界与脏值夹到两端或默认值", () => {
    expect(clampLoginTTL(0)).toBe(LOGIN_TTL_MIN);
    expect(clampLoginTTL(1000)).toBe(LOGIN_TTL_MAX);
    expect(clampLoginTTL(Number.NaN)).toBe(LOGIN_TTL_DEFAULT);
  });
});
