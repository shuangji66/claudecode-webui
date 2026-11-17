import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PluginsSettings } from "./PluginsSettings";
import { stopPluginPolling, usePluginStore } from "../../store/usePluginStore";
import { EMPTY_PLUGINS } from "../../lib/plugins";
import type { PluginAvailable, PluginAvailablePage, PluginDetailsPayload, PluginsPayload } from "../../transport/types";

const apiFetch = vi.fn();
vi.mock("../../lib/runtime", () => ({
  apiFetch: (path: string, init?: unknown) => apiFetch(path, init),
}));

const PAYLOAD: PluginsPayload = {
  supported: true,
  home: "/home/claude",
  installed: [
    {
      id: "hello@pt-market",
      version: "0.1.0",
      scope: "user",
      enabled: true,
      install_path: "/home/claude/.claude/plugins/cache/pt-market/hello/0.1.0",
      has_mcp_servers: false,
    },
  ],
  marketplaces: [{ name: "pt-market", source: "directory", install_location: "/tmp/m" }],
  available_total: 1,
  available_at: "2026-11-17T16:00:00Z",
  job: null,
};

const PAGE_ONE: PluginAvailablePage = {
  items: [{ plugin_id: "hello@pt-market", name: "hello", description: "demo plugin", marketplace: "pt-market" }],
  matched: 1,
  total: 1,
  offset: 0,
  limit: 20,
};

const DETAILS: PluginDetailsPayload = {
  id: "hello@pt-market",
  details: { text: "hello 0.1.0\n\nComponent inventory\n  Hooks (1)  SessionStart", skills: 0, agents: 0, hooks: 1, mcp_servers: 0 },
  inspect: { found: true, dir: "/tmp/m/plugins/hello", hooks: true, mcp_servers: false, commands: 1, skills: 0 },
};

function doneJob(kind: string) {
  return { kind, target: "hello@pt-market", phase: "done" as const, started_at: new Date().toISOString() };
}

/** 目录接口的默认桩：返回一页，并按 offset 追加（模拟服务端分页）。 */
function pageOf(all: PluginAvailable[], qs: string): PluginAvailablePage {
  const params = new URLSearchParams(qs);
  const offset = Number(params.get("offset") ?? 0);
  const limit = Number(params.get("limit") ?? 20);
  const q = (params.get("q") ?? "").toLowerCase();
  const matched = q ? all.filter((p) => (p.name + p.description).toLowerCase().includes(q)) : all;
  return {
    items: matched.slice(offset, offset + limit),
    matched: matched.length,
    total: all.length,
    offset,
    limit,
    fetched_at: "2026-11-17T16:00:00Z",
  };
}

let catalog: PluginAvailable[] = PAGE_ONE.items;
/** GET /api/plugins 的返回；组件挂载一定会 load 一次，所以按用例改它而不是只改 store。 */
let listPayload: PluginsPayload = PAYLOAD;

beforeEach(() => {
  stopPluginPolling();
  catalog = PAGE_ONE.items;
  listPayload = PAYLOAD;
  usePluginStore.setState({
    data: PAYLOAD,
    details: null,
    error: null,
    busy: false,
    job: null,
    cwd: "/ws",
    loaded: true,
    avail: { items: [], matched: 0, total: 0, loading: false, query: "", market: "", hideInstalled: false },
  });
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string) => {
    if (path.startsWith("/api/plugins/details")) return Promise.resolve(DETAILS);
    if (path.startsWith("/api/plugins/available")) {
      const qs = path.split("?")[1] ?? "";
      return Promise.resolve(pageOf(catalog, qs));
    }
    if (path.startsWith("/api/plugins/install")) return Promise.resolve({ job: doneJob("install") });
    if (path.startsWith("/api/plugins/enabled")) return Promise.resolve({ job: doneJob("disable") });
    if (path.startsWith("/api/plugins")) return Promise.resolve(listPayload);
    return Promise.resolve({});
  });
});

describe("PluginsSettings", () => {
  it("列出已安装插件与其作用域", async () => {
    render(<PluginsSettings cwd="/ws" />);
    expect(await screen.findByText("hello@pt-market")).toBeTruthy();
    expect(screen.getByText("0.1.0")).toBeTruthy();
    expect(screen.getByText("用户级")).toBeTruthy();
  });

  it("停用按钮发出 enabled=false", async () => {
    render(<PluginsSettings cwd="/ws" />);
    fireEvent.click(await screen.findByText("停用"));
    await waitFor(() => {
      const call = apiFetch.mock.calls.find(([p]) => String(p).startsWith("/api/plugins/enabled"));
      expect(call).toBeTruthy();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toMatchObject({
        id: "hello@pt-market",
        scope: "user",
        enabled: false,
      });
    });
  });

  it("详情是页内视图：展示组件清单与风险提示，并能返回列表", async () => {
    render(<PluginsSettings cwd="/ws" />);
    fireEvent.click((await screen.findAllByText("详情"))[0]);
    expect(await screen.findByText(/Component inventory/)).toBeTruthy();
    expect(screen.getByText(/只在信任来源时启用/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByText("返回"));
    expect((await screen.findAllByText("详情")).length).toBeGreaterThan(0);
    expect(screen.queryByText("返回")).toBeNull();
  });

  it("详情里可以直接重装", async () => {
    render(<PluginsSettings cwd="/ws" />);
    fireEvent.click((await screen.findAllByText("详情"))[0]);
    await screen.findByText(/Component inventory/);
    fireEvent.click(screen.getByText("重新安装"));
    await waitFor(() => {
      expect(apiFetch.mock.calls.some(([p]) => String(p).startsWith("/api/plugins/install"))).toBe(true);
    });
  });

  it("claude 不支持 plugin 子命令时给出原因而不是一堆按钮", async () => {
    usePluginStore.setState({
      data: { ...PAYLOAD, supported: false, reason: "unknown command 'plugin'", installed: [] },
      loaded: true,
    });
    render(<PluginsSettings cwd="/ws" />);
    expect(screen.getByText(/unknown command/)).toBeTruthy();
  });

  // 读取失败（500/断网）不能显示成「版本不支持」：那会让用户去升级 claude。
  it("读取失败时显示错误与重试，不说版本不支持", async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/api/plugins")) return Promise.reject(new Error("读取插件列表失败: 状态文件损坏"));
      return Promise.resolve({});
    });
    usePluginStore.setState({ data: { ...PAYLOAD, supported: false, installed: [] }, error: null, loaded: true });
    render(<PluginsSettings cwd="/ws" />);
    expect(await screen.findByText(/状态文件损坏/)).toBeTruthy();
    expect(screen.getByText("重试")).toBeTruthy();
    expect(screen.queryByText(/不支持 plugin 子命令/)).toBeNull();
  });
});

describe("PluginsSettings · 大目录", () => {
  const bigCatalog = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      plugin_id: `p${i}@big`,
      name: `plugin-${i}`,
      description: `demo plugin number ${i}`,
      marketplace: "big",
    }));

  it("首屏直接读落盘缓存的第一页（不必手动刷新）", async () => {
    catalog = bigCatalog(300);
    listPayload = { ...PAYLOAD, available_total: 300 };
    usePluginStore.setState({ data: listPayload, loaded: true });
    render(<PluginsSettings cwd="/ws" />);
    // 一页 20 条：不依赖排序，只数条数。
    await waitFor(() => expect(screen.getAllByText(/^plugin-\d+$/)).toHaveLength(20));
    expect(screen.getByText(/300 个/)).toBeTruthy();
    expect(apiFetch.mock.calls.some(([p]) => String(p).includes("offset=0"))).toBe(true);
  });

  it("「显示更多」按 offset 取下一页并追加", async () => {
    catalog = bigCatalog(300);
    listPayload = { ...PAYLOAD, available_total: 300 };
    usePluginStore.setState({ data: listPayload, loaded: true });
    render(<PluginsSettings cwd="/ws" />);
    await waitFor(() => expect(screen.getAllByText(/^plugin-\d+$/)).toHaveLength(20));
    fireEvent.click(screen.getByText(/显示更多/));
    await waitFor(() => expect(screen.getAllByText(/^plugin-\d+$/)).toHaveLength(40));
    expect(apiFetch.mock.calls.some(([p]) => String(p).includes("offset=20"))).toBe(true);
    // 页内列表不会因为「显示更多」就变成 300 条。
    expect(screen.queryByText("plugin-299")).toBeNull();
  });

  it("搜索把 q 交给服务端（防抖后只发一次）", async () => {
    catalog = bigCatalog(300);
    listPayload = { ...PAYLOAD, available_total: 300 };
    usePluginStore.setState({ data: listPayload, loaded: true });
    render(<PluginsSettings cwd="/ws" />);
    await waitFor(() => expect(screen.getAllByText(/^plugin-\d+$/)).toHaveLength(20));
    const before = apiFetch.mock.calls.filter(([p]) => String(p).includes("/api/plugins/available")).length;
    fireEvent.change(screen.getByPlaceholderText("搜索插件名或说明"), { target: { value: "number 217" } });
    await waitFor(() => expect(screen.getByText("plugin-217")).toBeTruthy());
    const after = apiFetch.mock.calls.filter(([p]) => String(p).includes("/api/plugins/available")).length;
    expect(after - before).toBe(1);
    expect(apiFetch.mock.calls.some(([p]) => String(p).includes("q=number+217"))).toBe(true);
  });

  it("「只看未安装」把条件交给服务端", async () => {
    catalog = bigCatalog(5);
    listPayload = { ...PAYLOAD, available_total: 5 };
    usePluginStore.setState({ data: listPayload, loaded: true });
    render(<PluginsSettings cwd="/ws" />);
    await waitFor(() => expect(screen.getAllByText(/^plugin-\d+$/)).toHaveLength(5));
    fireEvent.click(screen.getByLabelText("只看未安装"));
    await waitFor(() => {
      expect(apiFetch.mock.calls.some(([p]) => String(p).includes("hide_installed=1"))).toBe(true);
    });
  });

  it("没有命中时给出空态文案", async () => {
    catalog = bigCatalog(5);
    listPayload = { ...PAYLOAD, available_total: 5 };
    usePluginStore.setState({ data: listPayload, loaded: true });
    render(<PluginsSettings cwd="/ws" />);
    await waitFor(() => expect(screen.getAllByText(/^plugin-\d+$/)).toHaveLength(5));
    fireEvent.change(screen.getByPlaceholderText("搜索插件名或说明"), { target: { value: "zzz" } });
    expect(await screen.findByText(/没有匹配/)).toBeTruthy();
  });

  it("还没读到目录时显示「读取中」，不说版本不支持", async () => {
    apiFetch.mockImplementation(() => new Promise(() => {}));
    usePluginStore.setState({ data: EMPTY_PLUGINS, error: null, loaded: false });
    render(<PluginsSettings cwd="/ws" />);
    expect(await screen.findByText("读取插件状态…")).toBeTruthy();
    expect(screen.queryByText(/不支持 plugin 子命令/)).toBeNull();
  });
});
