import { describe, expect, it } from "vitest";
import {
  AUTH_CALLBACK_PATH,
  authCallbackPath,
  authStatusOutcome,
  authSucceeded,
  isAuthCallbackPath,
  newAuthState,
  readAuthResult,
} from "./fnosAuth";

describe("回调页路径", () => {
  it("挂在应用前缀下面", () => {
    expect(authCallbackPath("/app/ClaudeCode")).toBe("/app/ClaudeCode/callback");
    expect(authCallbackPath("/app/ClaudeCode/")).toBe("/app/ClaudeCode/callback");
    expect(authCallbackPath("")).toBe("/callback");
  });

  // 认错路径会把授权回来的用户丢进完整应用壳层（令牌门 / WS），所以只认这一条。
  it("只认「前缀 + /callback」，尾斜杠容错", () => {
    expect(isAuthCallbackPath("/app/ClaudeCode/callback", "/app/ClaudeCode")).toBe(true);
    expect(isAuthCallbackPath("/app/ClaudeCode/callback/", "/app/ClaudeCode")).toBe(true);
    expect(isAuthCallbackPath("/callback", "")).toBe(true);
    expect(isAuthCallbackPath("/app/ClaudeCode/", "/app/ClaudeCode")).toBe(false);
    expect(isAuthCallbackPath("/app/ClaudeCode", "/app/ClaudeCode")).toBe(false);
    expect(isAuthCallbackPath("/app/Other/callback", "/app/ClaudeCode")).toBe(false);
  });

  it("常量与服务端路由对齐", () => {
    expect(AUTH_CALLBACK_PATH).toBe("/callback");
  });
});

describe("readAuthResult", () => {
  const search =
    "?status=success&method=pickUserFile&appName=ClaudeCode&state=abc" +
    `&path=${encodeURIComponent('["/vol1/home/user"]')}`;

  it("解析 query 里的全部字段", () => {
    const r = readAuthResult(search);
    expect(r).toEqual({
      status: "success",
      error: undefined,
      method: "pickUserFile",
      appName: "ClaudeCode",
      state: "abc",
      paths: ["/vol1/home/user"],
    });
  });

  it("接受完整 URL 与 URLSearchParams", () => {
    expect(readAuthResult(`http://nas/app/ClaudeCode/callback${search}`).paths).toEqual(["/vol1/home/user"]);
    expect(readAuthResult(new URLSearchParams(search.slice(1))).status).toBe("success");
  });

  it("取消时没有路径，状态是 cancel", () => {
    const r = readAuthResult("?status=cancel&error=access_denied&state=abc");
    expect(r.status).toBe("cancel");
    expect(r.error).toBe("access_denied");
    expect(r.paths).toEqual([]);
  });

  // path 是 JSON 数组：坏 JSON 或被塞了非字符串都不能让页面抛错。
  it("path 不是合法字符串数组时当空", () => {
    expect(readAuthResult("?path=%5B%22%2Fa%22%2C1%2Cnull%5D").paths).toEqual(["/a"]);
    expect(readAuthResult("?path=not-json").paths).toEqual([]);
    expect(readAuthResult("?path=%22%2Fa%22").paths).toEqual([]);
    expect(readAuthResult("").paths).toEqual([]);
  });
});

describe("授权结论", () => {
  const ok = readAuthResult('?status=success&state=abc&path=["/a"]');

  it("发起方校验 state", () => {
    expect(authSucceeded(ok, "abc")).toBe(true);
    // 别的页面编一条 success 不能冒充这次授权。
    expect(authSucceeded(ok, "other")).toBe(false);
    expect(authSucceeded(ok, "")).toBe(false);
    expect(authSucceeded(readAuthResult("?status=cancel&state=abc"), "abc")).toBe(false);
  });

  it("回调页只看状态给结论", () => {
    expect(authStatusOutcome(ok)).toBe("ok");
    expect(authStatusOutcome(readAuthResult("?status=cancel"))).toBe("cancel");
    expect(authStatusOutcome(readAuthResult("?error=access_denied"))).toBe("cancel");
    expect(authStatusOutcome(readAuthResult("?status=error&error=boom"))).toBe("error");
    expect(authStatusOutcome(readAuthResult(""))).toBe("error");
  });
});

describe("newAuthState", () => {
  it("每次都不一样，且非空", () => {
    const a = newAuthState();
    const b = newAuthState();
    expect(a).not.toBe("");
    expect(a).not.toBe(b);
  });
});
