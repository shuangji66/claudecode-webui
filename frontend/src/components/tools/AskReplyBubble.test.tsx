import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ToolItem } from "../../lib/model";
import { AskReplyBubble } from "./AskReplyBubble";

const copyText = vi.fn();

vi.mock("../../lib/clipboard", () => ({
  copyText: (text: string) => copyText(text),
}));

beforeEach(() => {
  copyText.mockReset();
  copyText.mockResolvedValue(true);
});

const INPUT = {
  questions: [
    {
      question: "改动完成后，你希望我用哪种方式做验证闭环？",
      header: "验证方式",
      options: [{ label: "跑构建（推荐）", description: "只做编译验证" }, { label: "跑单测" }],
    },
    {
      question: "这次渲染测试想覆盖哪些交互形态？（可多选）",
      header: "覆盖形态",
      multiSelect: true,
      options: [{ label: "带预览的选项" }, { label: "自定义输入（Other）" }],
    },
  ],
};

const tool = (result: string): ToolItem => ({
  id: "t1",
  seq: 0,
  ts: 1700000000000,
  kind: "tool",
  toolUseId: "t1",
  name: "AskUserQuestion",
  input: INPUT,
  result,
});

const RESULT =
  'Your questions have been answered: "改动完成后，你希望我用哪种方式做验证闭环？"="跑构建（推荐）", ' +
  '"这次渲染测试想覆盖哪些交互形态？（可多选）"="带预览的选项,自定义输入（Other）". ' +
  "You can now continue with these answers in mind.";

describe("AskReplyBubble", () => {
  it("把问题与用户的选择渲染成气泡，不再铺整份选项清单", () => {
    const { container } = render(<AskReplyBubble item={tool(RESULT)} />);

    expect(screen.getByText("改动完成后，你希望我用哪种方式做验证闭环？")).toBeInTheDocument();
    // 选中的选项用展示名（去掉「（推荐）」后缀）
    expect(screen.getByText("跑构建")).toBeInTheDocument();
    expect(screen.getByText("带预览的选项、自定义输入（Other）")).toBeInTheDocument();
    // 未选中的描述、原始结果都进不来
    expect(screen.queryByText("只做编译验证")).toBeNull();
    expect(screen.queryByText(/原始结果/)).toBeNull();
    // 右侧气泡（用户自己说的话）
    expect(container.querySelector(".rounded-br-\\[6px\\]")).not.toBeNull();
  });

  it("header 单独一行，与题目原文重复时不重复显示", () => {
    render(
      <AskReplyBubble
        item={tool('Your questions have been answered: "改动完成后，你希望我用哪种方式做验证闭环？"="跑单测". You can now continue with these answers in mind.')}
      />,
    );
    expect(screen.getByText("验证方式")).toBeInTheDocument();
  });

  it("多选里「选项 + 自定义」并存时按选项 + 文本展示，跳过的那题说「已跳过」", () => {
    render(
      <AskReplyBubble
        item={tool(
          'Your questions have been answered: "改动完成后，你希望我用哪种方式做验证闭环？"=(no option selected), ' +
            '"这次渲染测试想覆盖哪些交互形态？（可多选）"="带预览的选项,其实还有别的". You can now continue with these answers in mind.',
        )}
      />,
    );
    expect(screen.getByText("带预览的选项、其实还有别的")).toBeInTheDocument();
    expect(screen.getByText("已跳过")).toBeInTheDocument();
  });

  it("复制的是问答本身：问题 + 答案，不含未选中的选项", async () => {
    render(<AskReplyBubble item={tool(RESULT)} />);
    fireEvent.click(screen.getByRole("button", { name: "复制问答" }));
    expect(copyText.mock.calls[0]?.[0]).toBe(
      [
        ["验证方式 — 改动完成后，你希望我用哪种方式做验证闭环？", "答案：跑构建"].join("\n"),
        ["覆盖形态 — 这次渲染测试想覆盖哪些交互形态？（可多选）", "答案：带预览的选项、自定义输入（Other）"].join("\n"),
      ].join("\n\n"),
    );
    // 回执就地变「已复制」（顺便把 setState 收进 act）。
    expect(await screen.findByText("已复制")).toBeInTheDocument();
  });

  it("结果读不出答案时什么都不画（由工具卡片兜底）", () => {
    const { container } = render(<AskReplyBubble item={tool("The user did not answer the questions.")} />);
    expect(container.firstChild).toBeNull();
  });
});
