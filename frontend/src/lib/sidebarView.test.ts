import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_VIEW,
  FLAT_KEY,
  applyOrder,
  flattenWorkspaceTree,
  loadOrder,
  loadView,
  matchArchive,
  moveBefore,
  moveStep,
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

  it("moveBefore 把一项挪到另一项前面", () => {
    expect(moveBefore([], list, "c", "a")).toEqual(["c", "a", "b"]);
    expect(moveBefore([], list, "a", "c")).toEqual(["b", "c", "a"]);
  });

  it("跨组（找不到 id）时顺序不变，但返回完整顺序", () => {
    const order = ["a", "b"];
    expect(moveBefore(order, list, "zzz", "a")).toEqual(["a", "b", "c"]);
    expect(moveStep(order, list, "zzz", 1)).toEqual(["a", "b", "c"]);
  });

  it("moveStep 上移/下移一格，越界不动", () => {
    expect(moveStep([], list, "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveStep([], list, "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveStep([], list, "a", -1)).toEqual(["a", "b", "c"]);
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
