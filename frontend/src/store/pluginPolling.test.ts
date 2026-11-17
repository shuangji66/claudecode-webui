// 插件任务的轮询：一次网络抖动不能把「正在安装」永久卡在界面上。
//
// 轮询用模块级的 pollTimer 记「是不是已经在轮询」。定时器触发后句柄不会被清空，
// 所以出错时（网关抖动、前端刚重连）必须自己置空——否则 load() 里那个
// `!pollTimer` 永远为假，之后谁都不会再去问任务状态，用户只能刷新页面。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Step = { fail?: boolean };

const steps: Step[] = [];
const calls: string[] = [];

vi.mock("../lib/runtime", () => ({
  apiFetch: vi.fn(async (url: string) => {
    calls.push(url);
    if (url.startsWith("/api/plugins/available")) {
      return { items: [], matched: 0, total: 0, offset: 0, limit: 20 };
    }
    const step = steps.shift() ?? {};
    if (step.fail) throw new Error("网络抖动");
    return {
      supported: true,
      reason: "",
      home: "/home/claude",
      installed: [],
      marketplaces: [],
      available_total: 0,
      // 任务一直在跑：只有轮询能发现它什么时候结束。
      job: { kind: "install", target: "demo@m", phase: "running", started_at: "2026-01-01T00:00:00Z" },
    };
  }),
}));

const { usePluginStore, stopPluginPolling } = await import("./usePluginStore");

const POLL_MS = 1200;

function pluginCalls(): number {
  return calls.filter((u) => u === "/api/plugins?cwd=").length;
}

describe("插件任务轮询", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    steps.length = 0;
    calls.length = 0;
    stopPluginPolling();
    usePluginStore.setState({ cwd: "", busy: false, error: null, job: null, loaded: false });
  });

  afterEach(() => {
    stopPluginPolling();
    vi.useRealTimers();
  });

  it("轮询遇到一次失败后，重新 load 仍然能接着轮询", async () => {
    steps.push({}); // load 读到「正在跑」
    await usePluginStore.getState().load("");
    expect(usePluginStore.getState().busy).toBe(true);

    // 第一次轮询就失败：界面报错，但不能就此放弃这个任务。
    steps.push({ fail: true });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(usePluginStore.getState().error).toContain("网络抖动");
    const before = pluginCalls();

    // 用户点「重试」→ load：这次要能重新挂上轮询。
    steps.push({});
    await usePluginStore.getState().load("");
    expect(usePluginStore.getState().busy).toBe(true);

    // 再走一个轮询周期，必须真的又发了一次请求。
    steps.push({});
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(pluginCalls()).toBeGreaterThan(before + 1);
  });
});
