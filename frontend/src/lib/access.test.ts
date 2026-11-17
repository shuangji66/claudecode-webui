import { describe, expect, it } from "vitest";
import { TCP_PORT_MAX, TCP_PORT_MIN, validTCPPort } from "./access";

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
