import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { McpSettings } from "./McpSettings";
import { SystemDialogs } from "../common/SystemDialogs";
import { useMcpStore } from "../../store/useMcpStore";
import { useAppStore } from "../../store/useAppStore";

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

function seedWorkspaces(paths: string[], names: Record<string, string> = {}) {
  useAppStore.setState({
    workspaces: paths.map((path) => ({ path, name: names[path] ?? path.split("/").pop() ?? path, last_used: "", exists: true })),
  });
}

function setup(cwd = "/data/ws") {
  useMcpStore.setState({ cwd: "", data: { user: [], project: [], project_root: "", user_path: "", project_path: "" }, probes: {}, error: null, busy: false, probing: null });
  seedWorkspaces(["/data/ws"]);
  render(
    <>
      <SystemDialogs />
      <McpSettings cwd={cwd} />
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

  // 自动化任务的 ccweb-schedule 由 ccweb 每次启动写回配置：改完下次启动被覆盖、
  // 删掉下次启动又长回来。所以这一行只留探测与启停，没有编辑/删除。
  it("内置服务只留探测与启停，普通服务照旧有编辑与删除", async () => {
    const builtin = {
      name: "ccweb-schedule",
      scope: "user",
      type: "stdio",
      command: "/bin/ccweb",
      args: ["mcp-schedule"],
      always_load: true,
      builtin: true,
      disabled: false,
      config_path: "/claude/.claude.json",
    };
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
      return Promise.resolve({ ...PAYLOAD, user: [...PAYLOAD.user, builtin] });
    });
    setup();

    await screen.findByText("ccweb-schedule");
    expect(screen.getByText("内置")).toBeInTheDocument();
    // 按行断言：内置那一行只有探测与停用，没有编辑/删除。
    const row = screen.getByText("ccweb-schedule").closest(".rounded-xl") as HTMLElement;
    expect(within(row).getByRole("button", { name: "探测" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "停用" })).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "编辑" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "删除" })).toBeNull();
    // 普通服务（github / 项目级的 old）两样都在。
    expect(screen.getAllByRole("button", { name: "编辑" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "删除" })).toHaveLength(2);
  });

  it("项目级配置写到所选工作区，不跟随当前对话", async () => {
    useMcpStore.setState({ cwd: "", data: { user: [], project: [], project_root: "", user_path: "", project_path: "" }, probes: {}, error: null, busy: false, probing: null });
    // 当前对话在 /data/ws，但用户要把服务加到 /data/other。
    seedWorkspaces(["/data/ws", "/data/other"]);
    render(
      <>
        <SystemDialogs />
        <McpSettings cwd="/data/ws" />
      </>,
    );
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/mcp?cwd=%2Fdata%2Fws", undefined));

    fireEvent.click(screen.getByRole("button", { name: "工作区" }));
    fireEvent.click(screen.getByRole("option", { name: /other/ }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/mcp?cwd=%2Fdata%2Fother", undefined));

    fireEvent.click(screen.getByRole("button", { name: /添加/ }));
    fireEvent.change(screen.getByPlaceholderText("github"), { target: { value: "mydb" } });
    fireEvent.click(screen.getByRole("button", { name: "作用域" }));
    fireEvent.click(screen.getByRole("option", { name: /项目级/ }));
    fireEvent.change(screen.getByPlaceholderText("npx"), { target: { value: "node" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "MCP 服务" })).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/mcp", expect.objectContaining({ method: "POST" })));
    // 列表加载也是 POST 之外的 /api/mcp 调用，别取到 GET 那一条。
    const post = apiFetch.mock.calls.find(([path, init]) => path === "/api/mcp" && (init as { method?: string } | null)?.method === "POST");
    expect(JSON.parse((post?.[1] as { body: string }).body).cwd).toBe("/data/other");
  });

  it("添加弹窗里也能选工作区，保存写到所选目录", async () => {
    useMcpStore.setState({ cwd: "", data: { user: [], project: [], project_root: "", user_path: "", project_path: "" }, probes: {}, error: null, busy: false, probing: null });
    seedWorkspaces(["/data/ws", "/data/other"]);
    render(
      <>
        <SystemDialogs />
        <McpSettings cwd="/data/ws" />
      </>,
    );
    await screen.findByText("github");
    fireEvent.click(screen.getByRole("button", { name: /添加/ }));

    const dialog = screen.getByRole("dialog", { name: "MCP 服务" });
    fireEvent.change(within(dialog).getByPlaceholderText("github"), { target: { value: "mydb" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "作用域" }));
    fireEvent.click(screen.getByRole("option", { name: /项目级/ }));
    // 弹窗内的工作区下拉（aria-label 为「目标工作区」，与页面顶部那个区分开）。
    fireEvent.click(within(dialog).getByRole("button", { name: "目标工作区" }));
    fireEvent.click(screen.getByRole("option", { name: /other/ }));
    expect(within(dialog).getByText(/写入 \/data\/other\/\.mcp\.json/)).toBeInTheDocument();
    // 背景列表跟着切到新工作区（加载期间「保存」是禁用的，等它落定再点）。
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/mcp?cwd=%2Fdata%2Fother", undefined));
    fireEvent.change(within(dialog).getByPlaceholderText("npx"), { target: { value: "node" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/mcp", expect.objectContaining({ method: "POST" })));
    const post = apiFetch.mock.calls.find(([path, init]) => path === "/api/mcp" && (init as { method?: string } | null)?.method === "POST");
    expect(JSON.parse((post?.[1] as { body: string }).body).cwd).toBe("/data/other");
  });

  it("没有工作区时不允许提交项目级服务（否则会白填一遍再吃 400）", async () => {
    useMcpStore.setState({ cwd: "", data: { user: [], project: [], project_root: "", user_path: "", project_path: "" }, probes: {}, error: null, busy: false, probing: null });
    seedWorkspaces([]);
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
