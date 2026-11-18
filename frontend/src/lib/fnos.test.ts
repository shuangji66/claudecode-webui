import { describe, expect, it } from "vitest";
import {
  authorizeFnosDir,
  canPickFnos,
  canRevealInFnos,
  classifyAuthorizeResult,
  classifyPickResult,
  isFnosApp,
} from "./fnos";

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

describe("isFnosApp", () => {
  it("认出飞牛 App WebView 的 UA", () => {
    expect(isFnosApp("Mozilla/5.0 (iPhone) FNAppType/ios FNAppVer/1.38.0")).toBe(true);
    expect(isFnosApp("Mozilla/5.0 (Linux; Android 14) FNOS/1.38.0")).toBe(true);
    expect(isFnosApp("Mozilla/5.0 FNAppVer/1.40.1")).toBe(true);
  });

  it("普通浏览器 / 桌面 iframe 的 UA 不算 App", () => {
    expect(isFnosApp("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120")).toBe(false);
    expect(isFnosApp("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1")).toBe(false);
    expect(isFnosApp("")).toBe(false);
  });
});

describe("canPickFnos", () => {
  // `@` 菜单里的「从飞牛选择」：只要宿主内且不是 TCP 通道。
  it("宿主内 + unix 通道（或未知通道）才给入口", () => {
    expect(canPickFnos({ channel: "unix", inHost: true })).toBe(true);
    expect(canPickFnos({ inHost: true })).toBe(true);
  });

  it("不在宿主里或 TCP 端口访问都不给", () => {
    expect(canPickFnos({ channel: "unix", inHost: false })).toBe(false);
    expect(canPickFnos({ channel: "tcp", inHost: true })).toBe(false);
  });
});

describe("canRevealInFnos", () => {
  // 三个条件缺一不可：宿主内、有工作区路径、不是 TCP 端口通道。
  it("宿主内 + 有工作区 + unix 通道才显示", () => {
    expect(canRevealInFnos({ path: "/vol1/1000/ws", channel: "unix", inHost: true })).toBe(true);
    // channel 缺省（老后端 / 还没拿到 info）按 unix 处理。
    expect(canRevealInFnos({ path: "/vol1/1000/ws", inHost: true })).toBe(true);
  });

  it("不在宿主里（独立浏览器 / make dev）不显示", () => {
    expect(canRevealInFnos({ path: "/vol1/1000/ws", channel: "unix", inHost: false })).toBe(false);
  });

  it("TCP 端口访问不显示：那条路上页面没有飞牛宿主", () => {
    expect(canRevealInFnos({ path: "/vol1/1000/ws", channel: "tcp", inHost: true })).toBe(false);
  });

  it("还没有工作区路径时不显示", () => {
    expect(canRevealInFnos({ path: "", channel: "unix", inHost: true })).toBe(false);
    expect(canRevealInFnos({ path: "   ", channel: "unix", inHost: true })).toBe(false);
  });
});
