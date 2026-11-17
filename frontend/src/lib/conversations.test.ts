import { describe, expect, it } from "vitest";
import { belongs, conversationStatus, latestConversation, pinnedFirst, sortByRecent, workspaceFor } from "./conversations";
import type { ConversationInfo, WorkspaceEntry } from "../transport/types";

function conv(id: string, cwd: string, last: string, archived = false): ConversationInfo {
  return {
    id,
    cwd,
    title: id,
    created_at: last,
    last_active: last,
    messages: 1,
    archived,
    live: false,
  };
}

describe("conversations", () => {
  it("belongs 只按路径段匹配", () => {
    expect(belongs("/work", "/work")).toBe(true);
    expect(belongs("/work/sub", "/work")).toBe(true);
    expect(belongs("/work2", "/work")).toBe(false);
    expect(belongs("/work/", "/work")).toBe(true);
  });

  it("workspaceFor 选最长授权目录", () => {
    const ws = [
      { path: "/data", name: "d", last_used: "", exists: true },
      { path: "/data/proj", name: "p", last_used: "", exists: true },
    ] as WorkspaceEntry[];
    expect(workspaceFor("/data/proj/src", ws)).toBe("/data/proj");
    expect(workspaceFor("/other", ws)).toBe("");
  });

  it("pinnedFirst 把置顶提到最前，组内顺序不变", () => {
    const list = [conv("a", "/w", "2026-01-03T00:00:00Z"), conv("b", "/w", "2026-01-02T00:00:00Z"), conv("c", "/w", "2026-01-01T00:00:00Z")];
    list[2].pinned = true;
    // 最近更新排序后 c 仍会被提到最前；其余保持原相对顺序。
    expect(pinnedFirst(sortByRecent(list)).map((c) => c.id)).toEqual(["c", "a", "b"]);
    expect(pinnedFirst(list).map((c) => c.id)).toEqual(["c", "a", "b"]);
    // 没有置顶时是纯拷贝，不改变顺序也不改原数组。
    const plain = pinnedFirst([list[0], list[1]]);
    expect(plain.map((c) => c.id)).toEqual(["a", "b"]);
    expect(list.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("latestConversation 跳过归档并按最近活跃排序", () => {
    const list = [conv("a", "/work", "2026-01-01T00:00:00Z"), conv("b", "/work", "2026-02-01T00:00:00Z", true), conv("c", "/work/sub", "2026-03-01T00:00:00Z")];
    expect(latestConversation("/work", list)?.id).toBe("c");
    expect(sortByRecent(list).map((c) => c.id)).toEqual(["c", "b", "a"]);
  });
});

describe("conversationStatus", () => {
  const base = { pending: 0, live: true, state: "ready", done: false };

  it("优先级：待审批 > 进行中 > 完成未看 > 活跃 > 未运行", () => {
    // 需要审批时即使进程正忙也先报审批
    expect(conversationStatus({ ...base, pending: 1, state: "busy", done: true })).toBe("approval");
    expect(conversationStatus({ ...base, state: "busy" })).toBe("ongoing");
    expect(conversationStatus({ ...base, state: "starting" })).toBe("ongoing");
    expect(conversationStatus({ ...base, done: true })).toBe("done");
    expect(conversationStatus(base)).toBe("active");
    expect(conversationStatus({ ...base, live: false, state: undefined })).toBe("off");
  });

  it("进程已经不在时，残留的完成标记仍然显示绿点", () => {
    expect(conversationStatus({ pending: 0, live: false, done: true })).toBe("done");
  });
});
