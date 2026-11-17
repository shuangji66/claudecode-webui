import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { AccessError, apiUrl, runtimeBase, wsUrl, setToken, getToken, loginAccess } from "./runtime";

function setBase(href: string | null) {
  document.head.querySelectorAll("base").forEach((b) => b.remove());
  if (href !== null) {
    const el = document.createElement("base");
    el.setAttribute("href", href);
    document.head.appendChild(el);
  }
}

describe("runtimeBase", () => {
  afterEach(() => setBase(null));

  it("从 <base> 读取前缀并去掉尾斜杠", () => {
    setBase("/app/ccweb/");
    expect(runtimeBase()).toBe("/app/ccweb");
  });

  it("没有 <base> 时为空（根路径部署）", () => {
    setBase(null);
    expect(runtimeBase()).toBe("");
  });

  it("apiUrl 拼在 base 之后", () => {
    setBase("/app/ccweb/");
    expect(apiUrl("/api/info")).toBe("/app/ccweb/api/info");
    expect(apiUrl("api/info")).toBe("/app/ccweb/api/info");
  });
});

describe("wsUrl", () => {
  afterEach(() => setBase(null));

  it("带上 base、会话 id 与令牌", () => {
    setBase("/app/ccweb/");
    const u = wsUrl("sess 1", "tok&x");
    expect(u).toContain("ws://localhost:3000/app/ccweb/ws?id=sess%201");
    expect(u).toContain("token=tok%26x");
  });

  it("无令牌时不带 token 参数", () => {
    setBase(null);
    expect(wsUrl("s", "")).not.toContain("token=");
  });

  it("会话 id 为空时是系统通道：不带 id，令牌用 ? 起头", () => {
    setBase("/app/ccweb/");
    expect(wsUrl("", "tok")).toBe("ws://localhost:3000/app/ccweb/ws?token=tok");
    expect(wsUrl("", "")).toBe("ws://localhost:3000/app/ccweb/ws");
  });
});

describe("token 存储", () => {
  beforeEach(() => localStorage.clear());

  it("可写入与读取", () => {
    setToken("abc");
    expect(getToken()).toBe("abc");
  });

  it("空串等于清除", () => {
    setToken("abc");
    setToken("");
    expect(getToken()).toBe("");
  });
});

describe("loginAccess", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setBase(null);
  });

  it("POST 密码换会话令牌，不带 Authorization", async () => {
    setBase(null);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ token: "sess-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loginAccess("p@ss")).resolves.toBe("sess-token");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ password: "p@ss" });
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("401 抛 AccessError，携带后端原因", async () => {
    setBase(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "密码不正确" }), { status: 401 })),
    );
    await expect(loginAccess("wrong")).rejects.toMatchObject({ status: 401, message: "密码不正确" });
    await expect(loginAccess("wrong")).rejects.toBeInstanceOf(AccessError);
  });

  it("409（端口访问未开启）同样带状态码", async () => {
    setBase(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "端口访问未开启" }), { status: 409 })),
    );
    await expect(loginAccess("x")).rejects.toMatchObject({ status: 409 });
  });
});
