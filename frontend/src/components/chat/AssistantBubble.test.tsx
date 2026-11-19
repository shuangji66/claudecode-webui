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

  it("回合结束后在复制按钮旁给出本轮消耗与生成速度", () => {
    render(
      <AssistantBubble
        text="答案"
        streaming={false}
        turn={{
          durationMs: 42_100,
          // 这一轮（含工具调用里的输入侧）合计 1.1M tok，输出只有 9.1K；
          // tok/s 取最近一次请求自己的 4s / 840 tok。
          usage: {
            contextTokens: 9_000,
            turnInputTokens: 1_100_000,
            outputTokens: 9_330,
            genMs: 4_000,
            genTokens: 840,
            apiMs: 126_000,
          },
        }}
      />,
    );
    // 耗时是时:分:秒，不是「42.1s」。
    expect(screen.getByText("00:42 · 本轮 1.1M tok · 210 tok/s")).toBeInTheDocument();
  });

  it("几分钟的回合按分:秒显示，不再只报秒数", () => {
    render(<AssistantBubble text="答案" streaming={false} turn={{ durationMs: 293_100 }} />);
    // 293.1s → 04:53，不再是「293.1s」。
    expect(screen.getByText("04:53")).toBeInTheDocument();
  });

  it("超过一小时的回合带小时位", () => {
    render(<AssistantBubble text="答案" streaming={false} turn={{ durationMs: 3_723_000 }} />);
    expect(screen.getByText("1:02:03")).toBeInTheDocument();
  });

  it("流式中不显示用量（还没结算）", () => {
    render(<AssistantBubble text="半句" streaming turn={{ durationMs: 1_000 }} />);
    expect(screen.queryByText(/本轮/)).toBeNull();
  });

  it("流式未结束、或正文为空时不给复制入口", () => {
    const { unmount } = render(<AssistantBubble text="半句" streaming />);
    expect(screen.queryByRole("button", { name: "复制回复" })).toBeNull();
    unmount();

    render(<AssistantBubble text="   " streaming={false} />);
    expect(screen.queryByRole("button", { name: "复制回复" })).toBeNull();
  });

  // 一轮里的过渡正文不配复制按钮（见 MessageList 的 replyCopy），只有最终回答给。
  it("showCopy=false 时不渲染复制按钮，撤回耗时行照常", () => {
    render(<AssistantBubble text="过渡正文" streaming={false} showCopy={false} turn={{ durationMs: 42_100 }} />);
    expect(screen.queryByRole("button", { name: "复制回复" })).toBeNull();
    expect(screen.getByText("00:42")).toBeInTheDocument();
  });

  it("copyText 给了就复制它（整轮正文），不是这一条自己的正文", async () => {
    render(
      <AssistantBubble text="最终答案" streaming={false} copyText={"先看目录\n\n最终答案"} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "复制回复" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("先看目录\n\n最终答案"));
  });
});
