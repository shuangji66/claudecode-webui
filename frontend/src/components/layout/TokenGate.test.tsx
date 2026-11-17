import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TokenGate } from "./TokenGate";
import { getToken } from "../../lib/runtime";

// TCP 端口启用访问鉴权后，首屏就是这一页：输错必须给出「密码不正确」，
// 而不是把错误凭据存下来、刷新后变成「无法连接服务」。
describe("TokenGate", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("密码错误时显示提示且不保存凭据", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "密码不正确" }), { status: 401 })),
    );
    const onSaved = vi.fn();
    render(<TokenGate onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText("访问密码"), { target: { value: "wrong" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "进入" }));
    });

    expect(await screen.findByText("密码不正确，请重试。")).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    expect(getToken()).toBe("");
  });

  it("密码正确时只保存会话令牌，不保存密码", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ token: "sess-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();
    render(<TokenGate onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText("访问密码"), { target: { value: "p@ss" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "进入" }));
    });

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(getToken()).toBe("sess-token");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ password: "p@ss" });
  });

  it("本地凭据失效时给出说明", () => {
    render(<TokenGate onSaved={() => {}} stale />);
    expect(screen.getByText(/本地登录已失效/)).toBeTruthy();
  });

  it("密码框默认隐藏，眼睛按钮可切换明文", () => {
    render(<TokenGate onSaved={() => {}} />);
    const input = screen.getByLabelText("访问密码") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "显示密码" }));
    expect(input.type).toBe("text");
  });
});
