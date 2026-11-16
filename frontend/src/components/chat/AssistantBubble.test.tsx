import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AssistantBubble } from "./AssistantBubble";

const copyText = vi.fn();

vi.mock("../../lib/clipboard", () => ({
  copyText: (text: string) => copyText(text),
}));

beforeEach(() => {
  copyText.mockReset();
  copyText.mockResolvedValue(true);
});

describe("AssistantBubble 复制回复", () => {
  // 触屏没有 hover：按钮必须常驻可见，否则手机上根本找不到复制入口。
  it("回答结束后复制按钮直接可见", () => {
    render(<AssistantBubble text="这是回答正文" streaming={false} />);
    expect(screen.getByRole("button", { name: "复制回复" })).toBeInTheDocument();
  });

  it("点一下复制原始正文并给出「已复制」", async () => {
    render(<AssistantBubble text="**加粗**的回答" streaming={false} />);
    fireEvent.click(screen.getByRole("button", { name: "复制回复" }));

    await waitFor(() => expect(copyText).toHaveBeenCalledWith("**加粗**的回答"));
    // 复制的是 Markdown 原文，不是渲染后的 DOM 文本。
    expect(await screen.findByText("已复制")).toBeInTheDocument();
  });

  it("回合结束后在复制按钮旁给出本轮用量", () => {
    render(
      <AssistantBubble
        text="答案"
        streaming={false}
        turn={{ durationMs: 42_100, usage: { contextTokens: 9_000, outputTokens: 9_330, apiMs: 126_000 } }}
      />,
    );
    expect(screen.getByText("42.1s · 9.1K tok 输出 · 74 tok/s")).toBeInTheDocument();
  });

  it("流式中不显示用量（还没结算）", () => {
    render(<AssistantBubble text="半句" streaming turn={{ durationMs: 1_000 }} />);
    expect(screen.queryByText(/tok 输出/)).toBeNull();
  });

  it("流式未结束、或正文为空时不给复制入口", () => {
    const { unmount } = render(<AssistantBubble text="半句" streaming />);
    expect(screen.queryByRole("button", { name: "复制回复" })).toBeNull();
    unmount();

    render(<AssistantBubble text="   " streaming={false} />);
    expect(screen.queryByRole("button", { name: "复制回复" })).toBeNull();
  });
});
