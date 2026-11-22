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
  disabled: false,
  server_name: "ccweb-web",
  command: "/bin/ccweb",
  mcp_supported: true,
};

function mount(status: SearchStatus = STATUS) {
  apiFetch.mockImplementation((path: string) => {
    if (path === "/api/search") return Promise.resolve(status);
    if (path === "/api/search/config") return Promise.resolve({ ...status, search_count: 5 });
    if (path === "/api/search/test") return Promise.resolve({ ok: true, latency_ms: 240, count: 3, results: [] });
    return Promise.resolve(status);
  });
  useSearchStore.setState({ status: null, error: null, busy: false, testing: false, test: null });
  render(<SearchSettings />);
}

/** 这块默认折叠成一行，表单要展开才在 DOM 里（省空间就是这个功能的目的）。 */
async function expand(expectSummary: RegExp | string = "未注册") {
  const header = screen.getByRole("button", { name: /内置搜索/ });
  // 先等状态回来（摘要里出现注册状态），再展开；否则展开的是一个还没回填的表单。
  await waitFor(() => expect(header).toHaveTextContent(expectSummary));
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

  // 注册由后端维护（`EnsureSearchMCP`）：保存配置即同步，界面不再给手工的
  // 「注册到 Claude / 重新注册 / 移除」——同一份配置两个入口会让「菜单里删了、
  // 设置里还写着已启用」这种状态自相矛盾。
  it("不给手工注册/移除按钮，只说明现在注册成什么", async () => {
    mount();
    await expand();
    expect(screen.queryByRole("button", { name: "注册到 Claude" })).toBeNull();
    expect(screen.queryByRole("button", { name: /重新注册|移除/ })).toBeNull();
    expect(screen.getByText(/再保存一次即可补上/)).toBeInTheDocument();
  });

  it("已注册时说明去用户级列表里停用，不在这一块另开一颗按钮", async () => {
    mount({ ...STATUS, attached: true });
    await expand("已注册");
    expect(screen.getByText(/已注册到用户级 MCP 配置/)).toBeInTheDocument();
    expect(screen.getByText(/在下面的用户级列表里「停用」/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /移除|重新注册/ })).toBeNull();
    expect(screen.getByRole("button", { name: /内置搜索/ })).toHaveTextContent("已注册");
  });

  // 停用与已注册是两回事：`List` 会把停用暂存里的条目一起列出来，只按「列表里有这一条」
  // 判的话面板会写着「已注册，要关就点停用」——而它早就关了，用户根本查不到搜索为什么没了。
  it("在 MCP 页停用之后说「已停用」，不再说已注册", async () => {
    mount({ ...STATUS, attached: false, disabled: true });
    const header = await screen.findByRole("button", { name: /内置搜索/ });
    await waitFor(() => expect(header).toHaveTextContent("已停用"));
    await expand("已停用");
    expect(screen.getByText(/下面的用户级列表里「启用」它/)).toBeInTheDocument();
    expect(screen.queryByText(/已注册到用户级 MCP 配置/)).toBeNull();
  });

  it("未启用时说明启用后会自动注册", async () => {
    mount({ ...STATUS, search_enabled: false, search_api_key_set: false });
    await expand();
    expect(screen.getByText(/会自动注册成 ccweb-web/)).toBeInTheDocument();
  });
});
