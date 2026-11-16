import { describe, expect, it } from "vitest";
import { belongs, latestConversation, sortByRecent, workspaceFor } from "./conversations";
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

  it("latestConversation 跳过归档并按最近活跃排序", () => {
    const list = [conv("a", "/work", "2026-01-01T00:00:00Z"), conv("b", "/work", "2026-02-01T00:00:00Z", true), conv("c", "/work/sub", "2026-03-01T00:00:00Z")];
    expect(latestConversation("/work", list)?.id).toBe("c");
    expect(sortByRecent(list).map((c) => c.id)).toEqual(["c", "b", "a"]);
  });
});
