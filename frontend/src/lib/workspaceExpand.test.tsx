import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import {
  ensureWorkspaceExpanded,
  expandedSnapshot,
  hasStoredExpanded,
  loadExpandedWorkspaces,
  parseExpandedWorkspaces,
  resetExpandedCache,
  setExpandedWorkspaces,
  toggleWorkspaceExpanded,
  useExpandedWorkspaces,
} from "./workspaceExpand";

const KEY = "ccweb-workspace-expanded";

describe("工作区展开状态", () => {
  beforeEach(() => {
    localStorage.clear();
    resetExpandedCache();
  });

  it("localStorage 里的东西不可信：只收非空字符串", () => {
    expect(parseExpandedWorkspaces(null)).toEqual([]);
    expect(parseExpandedWorkspaces("nope")).toEqual([]);
    expect(parseExpandedWorkspaces(["/w/a", "", 3, null, "/w/b"])).toEqual(["/w/a", "/w/b"]);
  });

  it("坏 JSON 当没设置过", () => {
    localStorage.setItem(KEY, "{not json");
    expect(loadExpandedWorkspaces().size).toBe(0);
  });

  it("切换会落盘，并且模块快照跟着变", () => {
    toggleWorkspaceExpanded("/w/a");
    expect(expandedSnapshot().has("/w/a")).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).toEqual(["/w/a"]);

    toggleWorkspaceExpanded("/w/a");
    expect(expandedSnapshot().has("/w/a")).toBe(false);
  });

  // 写盘时排序：同一个集合不会因为插入顺序不同写出不同的字符串，
  // 否则另一个标签页会凭空收到一次 storage 事件。
  it("落盘的顺序稳定", () => {
    setExpandedWorkspaces(["/w/b", "/w/a"]);
    const first = localStorage.getItem(KEY);
    setExpandedWorkspaces(["/w/a", "/w/b"]);
    expect(localStorage.getItem(KEY)).toBe(first);
  });

  // 「全部收起」是一份合法的偏好：存过之后就不能再被「自动展开当前工作区」撑回去，
  // 否则收起变成一个关不掉的开关。判定靠 hasStoredExpanded，不是「集合非空」。
  it("空集合也算存过（区分「从没存过」与「用户全收了」）", () => {
    expect(hasStoredExpanded()).toBe(false);
    setExpandedWorkspaces([]);
    expect(hasStoredExpanded()).toBe(true);
  });

  it("ensure 只在需要时写盘", () => {
    setExpandedWorkspaces(["/w/a"]);
    const write = vi.spyOn(Storage.prototype, "setItem");
    ensureWorkspaceExpanded("/w/a");
    expect(write).not.toHaveBeenCalled();
    ensureWorkspaceExpanded("/w/b");
    expect(write).toHaveBeenCalledTimes(1);
    write.mockRestore();
  });

  // 两个 Sidebar 实例（桌面常驻 + 移动端抽屉）读的是同一份快照：一边改了，
  // 另一边立刻跟上，不会各自画一张图。这条就是 `useSyncExternalStore` 那条路。
  it("订阅者能收到变更", () => {
    function Probe() {
      const expanded = useExpandedWorkspaces();
      return <span data-testid="probe">{[...expanded].sort().join(",")}</span>;
    }
    render(<Probe />);
    const mounted = screen.getByTestId("probe");
    expect(mounted).toHaveTextContent("");

    act(() => setExpandedWorkspaces(["/w/a"]));
    expect(mounted).toHaveTextContent("/w/a");

    act(() => toggleWorkspaceExpanded("/w/b"));
    expect(mounted).toHaveTextContent("/w/a,/w/b");
  });
});
