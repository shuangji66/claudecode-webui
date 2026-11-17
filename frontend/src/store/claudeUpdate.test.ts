import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn(async (path: string) => {
  if (path === "/api/claude/status") {
    return {
      platform: "linux-x64",
      dir: "/data/claude/versions",
      installed: [{ version: "2.1.325", path: "/data/claude/versions/2.1.325/claude", size: 1, installed_at: "" }],
      active: "2.1.325",
      source: "npmmirror",
      latest: "2.1.326",
      update_available: true,
      job: null,
    };
  }
  return {};
});

vi.mock("../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runtime")>();
  return { ...actual, apiFetch };
});

const { useAppStore } = await import("./useAppStore");

describe("claude 更新推送（系统通道）", () => {
  beforeEach(() => {
    apiFetch.mockClear();
    useAppStore.setState({ claude: null, claudeError: null, info: null, items: {} });
  });

  it("收到 claude.update 后拉一次状态，并把更新标记交给界面", async () => {
    useAppStore.getState().applyEvent("", {
      kind: "claude.update",
      data: { active: "2.1.325", latest: "2.1.326" },
    });

    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/claude/status"));
    await vi.waitFor(() => expect(useAppStore.getState().claude?.latest).toBe("2.1.326"));
    expect(useAppStore.getState().claude?.update_available).toBe(true);
  });

  it("系统通道的事件不写进任何会话的桶（空 sid 也不能污染 items）", async () => {
    useAppStore.getState().applyEvent("", { kind: "claude.update", data: { latest: "2.1.326" } });

    const s = useAppStore.getState();
    expect(s.items[""]).toBeUndefined();
    expect(s.states[""]).toBeUndefined();
    expect(s.perms[""]).toBeUndefined();
  });
});
