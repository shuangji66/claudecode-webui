import { describe, expect, it } from "vitest";
import { authorizeFnosDir, classifyAuthorizeResult, classifyPickResult } from "./fnos";

describe("classifyAuthorizeResult", () => {
  it("code 0 + data true 视为授权成功", () => {
    expect(classifyAuthorizeResult({ code: 0, msg: "", data: true })).toEqual({ state: "ok" });
    // 只给 code 0（没有 data）也算成功：宿主对成功回包不总是带 data。
    expect(classifyAuthorizeResult({ code: 0 })).toEqual({ state: "ok" });
  });

  it("data 显式 false 是用户放弃，不是成功", () => {
    expect(classifyAuthorizeResult({ code: 0, data: false })).toEqual({ state: "denied", reason: "cancel" });
  });

  it("宿主用 Operation failed / 操作失败 表示用户关掉了确认框", () => {
    expect(classifyAuthorizeResult({ code: 1, msg: "Operation failed", data: false })).toEqual({
      state: "denied",
      reason: "cancel",
    });
    expect(classifyAuthorizeResult({ code: 1, msg: "操作失败" })).toEqual({ state: "denied", reason: "cancel" });
    expect(classifyAuthorizeResult({ code: 1, msg: "已取消" })).toEqual({ state: "denied", reason: "cancel" });
  });

  it("没有回包、或只有 code 1 无文案，都按取消处理", () => {
    expect(classifyAuthorizeResult(undefined)).toEqual({ state: "denied", reason: "cancel" });
    expect(classifyAuthorizeResult(null)).toEqual({ state: "denied", reason: "cancel" });
    expect(classifyAuthorizeResult({ code: 1 })).toEqual({ state: "denied", reason: "cancel" });
  });

  it("真实错误要带出原文，不能被当成取消", () => {
    expect(classifyAuthorizeResult({ code: 1, msg: "Permission denied" })).toEqual({
      state: "denied",
      reason: "message",
      message: "Permission denied",
    });
  });
});

describe("authorizeFnosDir", () => {
  it("不在飞牛宿主 iframe 里时跳过（直连端口 / 本地开发）", async () => {
    // jsdom 里 window.parent === window，等价于独立浏览器页面。
    await expect(authorizeFnosDir("/vol1/1000/demo")).resolves.toEqual({
      state: "skipped",
      reason: "standalone",
    });
  });
});

describe("classifyPickResult", () => {
  it("data 里带路径才算选中", () => {
    expect(classifyPickResult({ code: 0, msg: "", data: ["/vol1/1000/a"] })).toEqual({ state: "ok", path: "/vol1/1000/a" });
    // 空字符串不算选中
    expect(classifyPickResult({ code: 0, data: ["", "  "] })).toEqual({ state: "denied", reason: "cancel" });
  });

  it("code 0 + 空数组是「什么都没选」，不能误判成成功", () => {
    expect(classifyPickResult({ code: 0, data: [] })).toEqual({ state: "denied", reason: "cancel" });
  });

  it("取消与真实错误分开处理", () => {
    expect(classifyPickResult(undefined)).toEqual({ state: "denied", reason: "cancel" });
    expect(classifyPickResult({ code: 1, msg: "Operation failed", data: [] })).toEqual({ state: "denied", reason: "cancel" });
    expect(classifyPickResult({ code: 1, msg: "仅管理员可进行此操作" })).toEqual({
      state: "denied",
      reason: "message",
      message: "仅管理员可进行此操作",
    });
  });
});
