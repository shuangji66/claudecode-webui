import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThinkingBlock } from "./ThinkingBlock";

describe("ThinkingBlock", () => {
  it("有正文时显示首行摘要", () => {
    render(<ThinkingBlock text={"先看布局\n再改样式"} />);
    expect(screen.getByText("思考过程")).toBeInTheDocument();
    expect(screen.getByText("先看布局")).toBeInTheDocument();
  });

  // 上游在工具调用之间会发纯空白的思考块。摘要退回字数时那一行是「思考过程 · 0 字」，
  // 点开只有个空格——既没信息也点不动（截图复现过）。
  it("正文全空白时不渲染这一行", () => {
    const { container } = render(<ThinkingBlock text={" \n\t "} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("流式且还没有字时也不渲染", () => {
    const { container } = render(<ThinkingBlock text="" streaming />);
    expect(container).toBeEmptyDOMElement();
  });
});
