import { describe, expect, it } from "vitest";
import { belongs, conversationStatus, latestConversation, pinnedFirst, samePath, sortByRecent, timeValue, workspaceFor } from "./conversations";
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

  // 与 belongs 的差别就在「不认子目录」：需要「就是这一层」的地方不能拿 belongs 凑。
  it("samePath 只认同一个目录", () => {
    expect(samePath("/work", "/work")).toBe(true);
    expect(samePath("/work/", "/work")).toBe(true);
    expect(samePath("/work/sub", "/work")).toBe(false);
    expect(samePath("/work2", "/work")).toBe(false);
    // 空路径等于「没有 cwd」，不能因为两边都空就说它们相同。
    expect(samePath("", "")).toBe(false);
    expect(samePath(undefined, "")).toBe(false);
    expect(samePath(undefined, "/work")).toBe(false);
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

  // 后端给的是 Go 的 RFC3339（时区偏移随值走），前端乐观更新写的是 `Z`：
  // 按字符串比大小会把同一时刻的两条定死一个错误顺序（实测过）。
  it("sortByRecent 按真实时刻排，不按时区字面量", () => {
    const list = [
      conv("local-tz", "/w", "2026-01-05T10:00:00.123456789+08:00"), // = 02:00:00.123Z
      conv("utc", "/w", "2026-01-05T02:00:00.5Z"),
      conv("older", "/w", "2026-01-05T09:00:00+08:00"), // = 01:00Z
    ];
    expect(sortByRecent(list).map((c) => c.id)).toEqual(["utc", "local-tz", "older"]);
  });

  it("timeValue 解析不了按最旧算，不抛错", () => {
    expect(timeValue(undefined)).toBe(0);
    expect(timeValue("")).toBe(0);
    expect(timeValue("not-a-time")).toBe(0);
    expect(timeValue("2026-01-05T02:00:00Z")).toBe(Date.parse("2026-01-05T02:00:00Z"));
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
