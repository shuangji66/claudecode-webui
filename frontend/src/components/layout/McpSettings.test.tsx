import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { McpSettings } from "./McpSettings";
import { SystemDialogs } from "../common/SystemDialogs";
import { useMcpStore } from "../../store/useMcpStore";

const apiFetch = vi.fn();
vi.mock("../../lib/runtime", () => ({
  apiFetch: (path: string, init?: unknown) => apiFetch(path, init),
}));

const PAYLOAD = {
  user: [
    {
      name: "github",
      scope: "user",
      type: "stdio",
      command: "npx",
      args: ["-y", "server-github"],
      disabled: false,
      config_path: "/claude/.claude.json",
    },
  ],
  project: [
    {
      name: "old",
      scope: "project",
      type: "http",
      url: "https://example.com/mcp",
      disabled: true,
      config_path: "/data/ws/.mcp.json",
    },
  ],
  project_root: "/data/ws",
  user_path: "/claude/.claude.json",
  project_path: "/data/ws/.mcp.json",
};

function setup() {
  useMcpStore.setState({ cwd: "", data: { user: [], project: [], project_root: "", user_path: "", project_path: "" }, probes: {}, error: null, busy: false, probing: null });
  render(
    <>
      <SystemDialogs />
      <McpSettings cwd="/data/ws" />
    </>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string) => {
    if (path.startsWith("/api/search")) {
      return Promise.resolve({
        base_url: "https://api.deepseek.com/v1/tools",
        search_count: 10,
        search_enabled: false,
        search_api_key_set: false,
        search_api_key_masked: "",
        attached: false,
        server_name: "ccweb-web",
        command: "/bin/ccweb",
        mcp_supported: true,
      });
    }
    return Promise.resolve(PAYLOAD);
  });
});

describe("McpSettings", () => {
  it("按作用域列出服务，停用项标注并禁止探测", async () => {
    setup();
    expect(await screen.findByText("github")).toBeInTheDocument();
    expect(screen.getByText("npx -y server-github")).toBeInTheDocument();
    expect(screen.getByText("old")).toBeInTheDocument();
    expect(screen.getByText("已停用")).toBeInTheDocument();
    // 停用中的服务没有进程可探测，按钮必须禁用（而不是点了报 409）。
    expect(screen.getAllByRole("button", { name: /探测/ })[1]).toBeDisabled();
  });

  it("请求带上 cwd（项目级配置跟着工作区走）", async () => {
    setup();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/mcp?cwd=%2Fdata%2Fws", undefined));
  });

  it("没有工作区时不允许提交项目级服务（否则会白填一遍再吃 400）", async () => {
    useMcpStore.setState({ cwd: "", data: { user: [], project: [], project_root: "", user_path: "", project_path: "" }, probes: {}, error: null, busy: false, probing: null });
    render(
      <>
        <SystemDialogs />
        <McpSettings cwd="" />
      </>,
    );
    await screen.findByText("还没有用户级服务。");
    fireEvent.click(screen.getByRole("button", { name: /添加/ }));

    fireEvent.change(screen.getByPlaceholderText("github"), { target: { value: "mydb" } });
    fireEvent.click(screen.getByRole("button", { name: "作用域" }));
    fireEvent.click(screen.getByRole("option", { name: /项目级/ }));
    fireEvent.change(screen.getByPlaceholderText("npx"), { target: { value: "node" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "MCP 服务" })).getByRole("button", { name: "保存" }));

    expect(await screen.findByText(/先选一个工作区，才能添加项目级服务/)).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalledWith("/api/mcp", expect.anything());
  });

  it("表单校验：stdio 缺命令时给出人话提示，不发请求", async () => {
    setup();
    // 等列表加载完（加载期间「添加」是禁用的，点了不会开弹窗）。
    await screen.findByText("github");
    fireEvent.click(screen.getByRole("button", { name: /添加/ }));

    const name = screen.getByPlaceholderText("github");
    fireEvent.change(name, { target: { value: "mydb" } });
    // 页面顶部「内置搜索」也有一个「保存」，这里限定在 MCP 编辑弹窗内。
    fireEvent.click(within(screen.getByRole("dialog", { name: "MCP 服务" })).getByRole("button", { name: "保存" }));

    expect(await screen.findByText(/stdio 类型必须填命令/)).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalledWith("/api/mcp", expect.anything());
    expect(screen.getByRole("dialog", { name: "MCP 服务" })).toBeInTheDocument();
  });
});
