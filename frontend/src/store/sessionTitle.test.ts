// 别处改了会话名（终端 /rename、IDE 插件、--name）之后，本机侧栏与页头要跟着变。
//
// 后端已经把名字并进 conversations.json（`NoteSessionTitle`），这条事件只是让
// **正看着这条对话的那台设备**立刻对齐——等下一次全量刷新的话，用户会看到
// 「终端里明明改过了，这里还是第一句话」。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "./useAppStore";

vi.mock("../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runtime")>();
  return {
    ...actual,
    apiFetch: vi.fn(async (path: string) => {
      if (path.startsWith("/api/sessions")) return { sessions: [] };
      if (path.startsWith("/api/conversations")) return { conversations: [] };
      return {};
    }),
  };
});

const SID = "aaaaaaaa-1111-2222-3333-444444444444";

describe("session.title（别处改名）", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      activeId: SID,
      conversations: [{ id: SID, cwd: "/w", title: "第一句话", messages: 3 }] as never,
      workspaces: [],
      sessions: [],
      items: {},
      conns: {},
      error: null,
    });
  });

  it("把列表里那一行的标题换成 CLI 报上来的名字", () => {
    useAppStore.getState().applyEvent(SID, { kind: "session.title", data: { title: "终端改的名字" } });
    expect(useAppStore.getState().conversations[0]?.title).toBe("终端改的名字");
  });

  it("空标题不动已有标题（宁可保留旧的，也不要显示空白）", () => {
    useAppStore.getState().applyEvent(SID, { kind: "session.title", data: { title: "   " } });
    expect(useAppStore.getState().conversations[0]?.title).toBe("第一句话");
  });

  it("只改目标会话，别的对话不受影响", () => {
    const other = "bbbbbbbb-1111-2222-3333-444444444444";
    useAppStore.setState((s) => ({
      conversations: [...s.conversations, { id: other, cwd: "/w", title: "另一条", messages: 1 }] as never,
    }));
    useAppStore.getState().applyEvent(SID, { kind: "session.title", data: { title: "改了" } });
    const list = useAppStore.getState().conversations;
    expect(list.find((c) => c.id === SID)?.title).toBe("改了");
    expect(list.find((c) => c.id === other)?.title).toBe("另一条");
  });
});
