import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { useAppStore } from "../../store/useAppStore";

function renderSidebar(over: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  render(
    <Sidebar
      onToggleCollapse={() => {}}
      onOpenSettings={() => {}}
      onAddWorkspace={() => {}}
      onOpenHistory={() => {}}
      {...over}
    />,
  );
}

describe("Sidebar 品牌区", () => {
  beforeEach(() => {
    useAppStore.setState({ conversations: [], workspaces: [], currentWorkspace: "", activeId: null });
  });

  // 点标题/logo 会新建对话太容易误触：品牌区只做标识，「新对话」是独立按钮。
  it("品牌区不是按钮，点了不会新建会话", () => {
    renderSidebar();
    const brand = screen.getByText("Claude Code");
    expect(brand.closest("button")).toBeNull();
    expect(screen.getByText("CONSOLE").closest("button")).toBeNull();
  });
});

describe("Sidebar 历史记录入口", () => {
  beforeEach(() => {
    useAppStore.setState({ conversations: [], workspaces: [], currentWorkspace: "", activeId: null });
  });

  // 参照 DSH：功能入口在「新对话」与工作区之间的功能区，一行一个。
  it("历史记录在功能区（工作区上方），点击打开历史", () => {
    const onOpenHistory = vi.fn();
    renderSidebar({ onOpenHistory });

    const button = screen.getByRole("button", { name: "历史记录" });
    fireEvent.click(button);
    expect(onOpenHistory).toHaveBeenCalled();

    // DOM 顺序：历史记录必须排在「工作区」标题之前。
    const workspaces = screen.getByText("工作区");
    expect(button.compareDocumentPosition(workspaces) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
