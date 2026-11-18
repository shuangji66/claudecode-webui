import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { HistoryDialog } from "./HistoryDialog";
import { useAppStore } from "../../store/useAppStore";

const cwd = "/w/demo";

describe("HistoryDialog", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      workspaces: [{ path: cwd, name: "demo", last_used: "", exists: true }],
      conversations: [
        { id: "c-1", cwd, title: "会话甲", created_at: "", last_active: "2026-01-02T00:00:00Z", messages: 3, archived: false, live: false },
        { id: "c-2", cwd, title: "会话乙", created_at: "", last_active: "2026-01-01T00:00:00Z", messages: 1, archived: false, live: false },
      ],
      refreshConversations: vi.fn(async () => {}),
    });
  });

  // 手机上自动聚焦会立刻弹键盘，把大半个列表顶走。
  it("打开时搜索框不自动聚焦", () => {
    render(<HistoryDialog open onClose={() => {}} />);
    const box = screen.getByPlaceholderText("搜索历史会话");
    expect(document.activeElement).not.toBe(box);
  });

  // 去掉 autoFocus 不能连带把搜索弄坏：仍然按标题过滤。
  it("搜索仍按标题过滤", () => {
    render(<HistoryDialog open onClose={() => {}} />);
    expect(screen.getByText("会话甲")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("搜索历史会话"), { target: { value: "乙" } });

    expect(screen.queryByText("会话甲")).toBeNull();
    expect(screen.getByText("会话乙")).toBeInTheDocument();
  });

  // 底部多了「共 N 条对话」和一颗与右上角重复的「关闭」按钮，全是噪音：
  // 计数随搜索变化没有意义，关闭已有 × / Esc / 遮罩三条路。
  it("底部没有计数与多余的关闭按钮，只剩右上角那颗关闭", () => {
    const onClose = vi.fn();
    render(<HistoryDialog open onClose={onClose} />);

    expect(screen.queryByText(/共 \d+ 条对话/)).toBeNull();
    // 「关闭」只剩 Dialog 标题栏那颗图标按钮。
    const closes = screen.getAllByRole("button", { name: "关闭" });
    expect(closes).toHaveLength(1);

    fireEvent.click(closes[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
