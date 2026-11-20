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

  // 首行是思考的开头，写完第一句就不动了。流式时沿用它的话，那一行截断之后就停在
  // 原地，后面想了什么一个字都看不到（截图里的「滚到左边尽头就停住」）。
  it("流式中摘要跟着最新一行走，已结束仍取首行", () => {
    const text = "先看布局\n再改样式\n最后补测试";
    const { rerender } = render(<ThinkingBlock text={text} streaming />);
    expect(screen.getByText("正在思考")).toBeInTheDocument();
    expect(screen.getByText("最后补测试")).toBeInTheDocument();
    expect(screen.queryByText("先看布局")).toBeNull();

    rerender(<ThinkingBlock text={text} />);
    expect(screen.getByText("思考过程")).toBeInTheDocument();
    expect(screen.getByText("先看布局")).toBeInTheDocument();
    expect(screen.queryByText("最后补测试")).toBeNull();
  });
});
