import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HistoryPage } from "./HistoryPage";
import { useAppStore } from "../../store/useAppStore";
import { askConfirm } from "../common/SystemDialogs";

vi.mock("../common/SystemDialogs", () => ({ askConfirm: vi.fn(), askPrompt: vi.fn() }));

const cwd = "/w/demo";

describe("HistoryPage", () => {
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
    render(<HistoryPage onClose={() => {}} />);
    const box = screen.getByPlaceholderText("搜索历史会话");
    expect(document.activeElement).not.toBe(box);
  });

  // 去掉 autoFocus 不能连带把搜索弄坏：仍然按标题过滤。
  it("搜索仍按标题过滤", () => {
    render(<HistoryPage onClose={() => {}} />);
    expect(screen.getByText("会话甲")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("搜索历史会话"), { target: { value: "乙" } });

    expect(screen.queryByText("会话甲")).toBeNull();
    expect(screen.getByText("会话乙")).toBeInTheDocument();
  });

  // 底部多了「共 N 条对话」和一颗与右上角重复的「关闭」按钮，全是噪音：
  // 计数随搜索变化没有意义，关闭已有 × / Esc / 遮罩三条路。
  it("底部没有计数与多余的关闭按钮，只剩右上角那颗关闭", () => {
    const onClose = vi.fn();
    render(<HistoryPage onClose={onClose} />);

    expect(screen.queryByText(/共 \d+ 条对话/)).toBeNull();
    // 「关闭」只剩 Dialog 标题栏那颗图标按钮。
    const closes = screen.getAllByRole("button", { name: "关闭" });
    expect(closes).toHaveLength(1);

    fireEvent.click(closes[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("HistoryPage 行操作", () => {
  const archiveConversation = vi.fn(async () => true);
  const deleteConversation = vi.fn(async () => true);
  const askConfirmMock = vi.mocked(askConfirm);

  beforeEach(() => {
    localStorage.clear();
    archiveConversation.mockClear();
    deleteConversation.mockClear();
    askConfirmMock.mockReset();
    useAppStore.setState({
      workspaces: [{ path: cwd, name: "demo", last_used: "", exists: true }],
      conversations: [
        { id: "c-1", cwd, title: "会话甲", created_at: "", last_active: "2026-01-02T00:00:00Z", messages: 3, archived: false, live: false },
        { id: "c-2", cwd, title: "会话乙", created_at: "", last_active: "2026-01-01T00:00:00Z", messages: 1, archived: true, live: false },
      ],
      refreshConversations: vi.fn(async () => {}),
      archiveConversation,
      deleteConversation,
    });
  });

  // 一列 /vol1/@appshare/... 只是噪音：路径留在 title 里悬浮可见就够了。
  it("行里不再显示工作区路径", () => {
    render(<HistoryPage onClose={() => {}} />);
    expect(screen.queryByText(cwd)).toBeNull();
    // 但路径仍可通过悬浮提示看到。
    expect(screen.getAllByTitle(cwd)).toHaveLength(2);
  });

  // 固定按钮：已归档的行是「取消归档」，未归档的行是「归档」——同一颗按钮两种语义，
  // 给未归档的行摆一颗点了没反应的「取消归档」等于骗人。
  it("右侧有固定的归档 / 删除按钮，按行状态切换语义", () => {
    render(<HistoryPage onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "归档 会话甲" }));
    expect(archiveConversation).toHaveBeenCalledWith("c-1", true);

    fireEvent.click(screen.getByRole("button", { name: "取消归档 会话乙" }));
    expect(archiveConversation).toHaveBeenCalledWith("c-2", false);

    expect(screen.getByRole("button", { name: "删除 会话甲" })).toBeInTheDocument();
  });

  // 同一颗图标两种语义，只靠 tooltip 分辨不出来：已归档行的「取消归档」用主题色，
  // 未归档行的「归档」保持灰色。
  it("「取消归档」用主题色，「归档」仍是灰色", () => {
    render(<HistoryPage onClose={() => {}} />);

    const unarchive = screen.getByRole("button", { name: "取消归档 会话乙" });
    expect(unarchive.className).toContain("text-brand");
    expect(unarchive.className).not.toContain("text-muted");

    const archive = screen.getByRole("button", { name: "归档 会话甲" });
    expect(archive.className).toContain("text-muted");
    expect(archive.className).not.toContain("text-brand");
  });

  // 已归档的对话不能点进去（对齐 DSH）：这一页在「全部 / 仅已归档」下会列出它们，
  // 误点一下就等于把刚归档的那条又拉回对话区。要打开得先点右侧那颗「取消归档」。
  it("已归档的行点了不打开，只提示先取消归档", async () => {
    const openConversation = vi.fn(async () => true);
    useAppStore.setState({ openConversation, toast: null });
    render(<HistoryPage onClose={() => {}} />);

    fireEvent.click(screen.getByText("会话乙"));
    expect(openConversation).not.toHaveBeenCalled();
    expect(useAppStore.getState().toast?.text).toContain("取消归档");

    // 未归档的那条照常能进（别把整页都拦掉）。
    fireEvent.click(screen.getByText("会话甲"));
    await waitFor(() => expect(openConversation).toHaveBeenCalledWith("c-1", false, expect.any(Function)));
  });

  it("删除必须先二次确认", async () => {
    askConfirmMock.mockResolvedValue(false);
    render(<HistoryPage onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "删除 会话甲" }));
    await waitFor(() => expect(askConfirmMock).toHaveBeenCalled());
    expect(deleteConversation).not.toHaveBeenCalled();

    askConfirmMock.mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: "删除 会话甲" }));
    await waitFor(() => expect(deleteConversation).toHaveBeenCalledWith("c-1"));
  });

  it("右键菜单与行内按钮是同一组选项", async () => {
    askConfirmMock.mockResolvedValue(true);
    render(<HistoryPage onClose={() => {}} />);

    fireEvent.contextMenu(screen.getAllByTitle(cwd)[1]); // 会话乙（已归档）
    const menu = await screen.findByRole("menu");
    expect(menu).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: /取消归档/ }));
    await waitFor(() => expect(archiveConversation).toHaveBeenCalledWith("c-2", false));

    fireEvent.contextMenu(screen.getAllByTitle(cwd)[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: /删除/ }));
    await waitFor(() => expect(deleteConversation).toHaveBeenCalledWith("c-1"));
  });
});
