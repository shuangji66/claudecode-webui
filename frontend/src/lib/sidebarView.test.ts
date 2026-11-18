import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_VIEW,
  FLAT_KEY,
  applyOrder,
  canDrop,
  dropHalf,
  flattenWorkspaceTree,
  loadOrder,
  loadView,
  matchArchive,
  moveBefore,
  moveStep,
  moveTo,
  parseView,
  saveOrder,
  saveView,
} from "./sidebarView";
import type { ConversationInfo, WorkspaceEntry } from "../transport/types";

function conv(id: string, over: Partial<ConversationInfo> = {}): ConversationInfo {
  return {
    id,
    cwd: "/w",
    title: id,
    created_at: "",
    last_active: "2026-01-01T00:00:00Z",
    messages: 1,
    archived: false,
    live: false,
    ...over,
  };
}

function ws(path: string): WorkspaceEntry {
  return { path, name: path.split("/").pop() || path, last_used: "", exists: true };
}

describe("parseView", () => {
  it("非法值回落默认", () => {
    expect(parseView(null)).toEqual(DEFAULT_VIEW);
    expect(parseView({ group: "nope", sort: 1, archive: "x" })).toEqual(DEFAULT_VIEW);
    expect(parseView({ group: "tree", sort: "manual", archive: "all" })).toEqual({
      group: "tree",
      sort: "manual",
      archive: "all",
    });
  });
});

describe("matchArchive", () => {
  it("三种筛选各管一段", () => {
    const live = conv("a");
    const archived = conv("b", { archived: true });
    expect([live, archived].filter((c) => matchArchive(c, "hide")).map((c) => c.id)).toEqual(["a"]);
    expect([live, archived].filter((c) => matchArchive(c, "only")).map((c) => c.id)).toEqual(["b"]);
    expect([live, archived].filter((c) => matchArchive(c, "all"))).toHaveLength(2);
  });
});

describe("手动顺序", () => {
  const list = [
    conv("a", { last_active: "2026-01-03T00:00:00Z" }),
    conv("b", { last_active: "2026-01-02T00:00:00Z" }),
    conv("c", { last_active: "2026-01-01T00:00:00Z" }),
  ];

  it("order 里有的按 order，没出现的按最近更新排在后面", () => {
    expect(applyOrder(list, ["c", "a"]).map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(applyOrder(list, []).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("moveBefore / moveTo 的落点就是提示线画的地方", () => {
    expect(moveBefore([], list, "c", "a")).toEqual(["c", "a", "b"]);
    // 「插到 c 前面」就是 a、b 之间的位置——旧实现（不复位下标）会落到 c 后面，
    // 用户看到提示线在上沿、松手却跑到下沿，正是这轮改掉的问题。
    expect(moveBefore([], list, "a", "c")).toEqual(["b", "a", "c"]);
    expect(moveTo([], list, "a", "c", "after")).toEqual(["b", "c", "a"]);
    expect(moveTo([], list, "c", "a", "before")).toEqual(["c", "a", "b"]);
    expect(moveTo([], list, "b", "b", "after")).toEqual(["a", "b", "c"]);
  });

  it("跨组（找不到 id）时顺序不变，但返回完整顺序", () => {
    const order = ["a", "b"];
    expect(moveBefore(order, list, "zzz", "a")).toEqual(["a", "b", "c"]);
    expect(moveTo(order, list, "a", "zzz", "after")).toEqual(["a", "b", "c"]);
    expect(moveStep(order, list, "zzz", 1)).toEqual(["a", "b", "c"]);
  });

  it("moveStep 上移/下移一格，越界不动", () => {
    expect(moveStep([], list, "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveStep([], list, "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveStep([], list, "a", -1)).toEqual(["a", "b", "c"]);
  });
});

describe("拖拽落点（dropHalf / canDrop）", () => {
  const rect = { top: 100, height: 28 };

  it("以中线分上下半；正好在中线上算下半", () => {
    expect(dropHalf(100, rect)).toBe("before");
    expect(dropHalf(113, rect)).toBe("before");
    expect(dropHalf(114, rect)).toBe("after");
    expect(dropHalf(127, rect)).toBe("after");
  });

  // 置顶由 pinnedFirst 最后统一排序：允许跨置顶组落位的话，
  // 提示线画在最上面、松手却被拉回置顶项之后，看着像没生效。
  it("同组、不是自己、置顶状态一致才给落点", () => {
    const dragged = { id: "a", groupKey: "/w", pinned: false };
    expect(canDrop(dragged, { id: "b", pinned: false }, "/w")).toBe(true);
    expect(canDrop(dragged, { id: "b", pinned: true }, "/w")).toBe(false);
    expect(canDrop(dragged, { id: "a", pinned: false }, "/w")).toBe(false);
    expect(canDrop(dragged, { id: "b", pinned: false }, "/other")).toBe(false);
    // 没有 pinned 字段的旧数据按「未置顶」处理。
    expect(canDrop(dragged, { id: "b" }, "/w")).toBe(true);
  });
});

describe("flattenWorkspaceTree", () => {
  it("子工作区挂在最近的父工作区下，并按路径排序", () => {
    const flat = flattenWorkspaceTree([
      ws("/vol1/work"),
      ws("/vol1/work/app"),
      ws("/vol1/work/app/sub"),
      ws("/tmp"),
    ]);
    expect(flat.map((x) => [x.workspace.path, x.depth])).toEqual([
      ["/tmp", 0],
      ["/vol1/work", 0],
      ["/vol1/work/app", 1],
      ["/vol1/work/app/sub", 2],
    ]);
  });

  it("互不包含时都是根", () => {
    const flat = flattenWorkspaceTree([ws("/a"), ws("/b")]);
    expect(flat.map((x) => x.depth)).toEqual([0, 0]);
  });
});

describe("localStorage 持久化", () => {
  beforeEach(() => localStorage.clear());

  it("视图与手动顺序都能存能读", () => {
    saveView({ group: "flat", sort: "manual", archive: "only" });
    expect(loadView()).toEqual({ group: "flat", sort: "manual", archive: "only" });

    saveOrder({ [FLAT_KEY]: ["a", "b"] });
    expect(loadOrder()).toEqual({ [FLAT_KEY]: ["a", "b"] });
  });

  it("坏数据不抛错", () => {
    localStorage.setItem("ccweb-sidebar-view", "{not json");
    expect(loadView()).toEqual(DEFAULT_VIEW);
    localStorage.setItem("ccweb-session-order", JSON.stringify({ x: [1, "a", null] }));
    expect(loadOrder()).toEqual({ x: ["a"] });
  });
});
