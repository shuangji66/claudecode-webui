import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SearchSettings } from "./SearchSettings";
import { useSearchStore } from "../../store/useSearchStore";
import type { SearchStatus } from "../../transport/types";

const apiFetch = vi.fn();
vi.mock("../../lib/runtime", () => ({
  apiFetch: (path: string, init?: unknown) => apiFetch(path, init),
}));

const STATUS: SearchStatus = {
  base_url: "https://api.deepseek.com/v1/tools",
  search_count: 10,
  search_enabled: true,
  search_api_key_set: true,
  search_api_key_masked: "****abcd",
  attached: false,
  always_load: false,
  server_name: "ccweb-web",
  command: "/bin/ccweb",
  mcp_supported: true,
};

function mount(status: SearchStatus = STATUS) {
  apiFetch.mockImplementation((path: string) => {
    if (path === "/api/search") return Promise.resolve(status);
    if (path === "/api/search/config") return Promise.resolve({ ...status, search_count: 5 });
    if (path === "/api/search/test") return Promise.resolve({ ok: true, latency_ms: 240, count: 3, results: [] });
    if (path === "/api/search/attach") return Promise.resolve({ ...status, attached: true });
    return Promise.resolve(status);
  });
  useSearchStore.setState({ status: null, error: null, busy: false, testing: false, test: null });
  render(<SearchSettings />);
}

/** 这块默认折叠成一行，表单要展开才在 DOM 里（省空间就是这个功能的目的）。 */
async function expand() {
  const header = screen.getByRole("button", { name: /内置搜索/ });
  // 先等状态回来（摘要里出现注册状态），再展开；否则展开的是一个还没回填的表单。
  await waitFor(() => expect(header).toHaveTextContent("未注册"));
  fireEvent.click(header);
  await screen.findByDisplayValue("https://api.deepseek.com/v1/tools");
}

beforeEach(() => {
  apiFetch.mockReset();
});

describe("SearchSettings 内置搜索", () => {
  it("默认折叠成一行：只露标题与状态，表单不渲染", async () => {
    mount();
    const header = await screen.findByRole("button", { name: /内置搜索/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    // 收起时也看得出「注册没注册」，不用点开确认。
    await waitFor(() => expect(header).toHaveTextContent("未注册"));
    expect(screen.queryByDisplayValue("https://api.deepseek.com/v1/tools")).toBeNull();

    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByDisplayValue("https://api.deepseek.com/v1/tools")).toBeInTheDocument();
  });

  it("回填基地址与条数，密钥只显示脱敏值", async () => {
    mount();
    await expand();
    expect(screen.getByDisplayValue("10")).toBeInTheDocument();
    // 已保存的密钥只体现在 placeholder 上，连脱敏串都不显示。
    expect(screen.queryByText("****abcd")).toBeNull();
    expect(screen.getByPlaceholderText("已保存，留空则不修改").getAttribute("placeholder")).not.toContain("****");
    // 密钥输入框本身永远是空的：它只用来换新密钥。
    expect(screen.getByPlaceholderText("已保存，留空则不修改")).toHaveValue("");
  });

  it("条数超出 1–50 时给中文提示且不发请求", async () => {
    mount();
    await expand();
    const count = screen.getByDisplayValue("10");
    fireEvent.change(count, { target: { value: "99" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText(/结果条数必须在 1–50 之间/)).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalledWith("/api/search/config", expect.anything());
  });

  it("测试连接显示结果条数与耗时", async () => {
    mount();
    await expand();
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText(/连接正常 · 3 条结果 · 240ms/)).toBeInTheDocument();
  });

  it("启用且有密钥时可以注册，注册后变成「已注册 + 移除」", async () => {
    mount();
    await expand();
    fireEvent.click(screen.getByRole("button", { name: "注册到 Claude" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/search/attach", expect.anything()));
    expect(await screen.findByRole("button", { name: /移除/ })).toBeInTheDocument();
    expect(screen.getByText(/已注册到用户级 MCP 配置/)).toBeInTheDocument();
    // 收起后那一行也跟着变，不用点开就能看到注册状态。
    expect(screen.getByRole("button", { name: /内置搜索/ })).toHaveTextContent("已注册");
  });

  it("未启用或没有密钥时注册按钮不可点", async () => {
    mount({ ...STATUS, search_enabled: false, search_api_key_set: false });
    await expand();
    expect(screen.getByRole("button", { name: "注册到 Claude" })).toBeDisabled();
  });
});
