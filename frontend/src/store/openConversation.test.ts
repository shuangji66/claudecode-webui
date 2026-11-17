import { beforeEach, describe, expect, it, vi } from "vitest";

// 会话起不来（claude 没装 / 版本被删 / 409）时，转录仍然要回放：
// 历史是磁盘上的 jsonl，跟子进程没有关系。曾经 catch 分支直接 return，
// 界面显示「开始新的对话」，看起来像整个对话丢了。
const transcript = {
  id: "c1",
  cwd: "/w",
  lines: [
    { type: "user", message: { role: "user", content: "旧问题" }, timestamp: "2026-01-01T00:00:00Z" },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "旧回答" }], model: "m" },
      timestamp: "2026-01-01T00:00:05Z",
    },
  ],
};

const calls: string[] = [];

vi.mock("../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runtime")>();
  return {
    ...actual,
    apiFetch: vi.fn(async (path: string) => {
      calls.push(path);
      if (path.startsWith("/api/history/transcript")) return transcript;
      if (path.startsWith("/api/session")) throw new Error("manager: claudebin: 未安装 claude");
      return {};
    }),
  };
});

const { useAppStore } = await import("./useAppStore");

describe("openConversation：会话启动失败", () => {
  beforeEach(() => {
    calls.length = 0;
    useAppStore.setState({
      activeId: null,
      conversations: [{ id: "c1", cwd: "/w", title: "旧对话", messages: 2 }] as never,
      workspaces: [],
      sessions: [],
      items: {},
      error: null,
      starting: false,
    });
  });

  it("仍然回放转录，并保留失败原因", async () => {
    const ok = await useAppStore.getState().openConversation("c1");

    expect(ok).toBe(false);
    const s = useAppStore.getState();
    const items = s.items.c1 ?? [];
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(items[1]).toMatchObject({ kind: "assistant", text: "旧回答" });
    expect(s.error).toContain("未安装 claude");
    expect(calls.some((p) => p.startsWith("/api/history/transcript"))).toBe(true);
  });
});
