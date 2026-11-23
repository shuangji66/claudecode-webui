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

  // 摘要取「最后一个已完成段落的首行」（对齐 DSH `ReasoningRow`）。空行是模型自己
  // 划定的段落边界：段落首行写完就不动了，是稳定的标题；而「最后一行字符」永远在变，
  // 还常常截在句中，读起来是半截话（截图复现过「滚到左边尽头就停住」）。
  it("流式取最后一个已完成段落的首行，结束态退回首行", () => {
    const text = "先看布局\n再改样式\n\n这一段是新的段落\n它还没写完";
    const { rerender } = render(<ThinkingBlock text={text} streaming />);
    expect(screen.getByText("正在思考")).toBeInTheDocument();
    // 最后一个段落已经写了首行：取它，而不是取「它还没写完」那半句。
    expect(screen.getByText("这一段是新的段落")).toBeInTheDocument();
    expect(screen.queryByText("先看布局")).toBeNull();

    // 结束了：摘要退回首行——那是这段思考的标题（DSH 同一口径）。
    rerender(<ThinkingBlock text={text} />);
    expect(screen.getByText("思考过程")).toBeInTheDocument();
    expect(screen.getByText("先看布局")).toBeInTheDocument();
    expect(screen.queryByText("这一段是新的段落")).toBeNull();
  });

  // 还没出现空行时（第一段都还没写完）没有「已完成段落」，退回已收到的首行，
  // 别让摘要空着。
  it("一个段落都没写完时退回已收到的首行", () => {
    render(<ThinkingBlock text={"先看布局\n再改样式"} streaming />);
    expect(screen.getByText("先看布局")).toBeInTheDocument();
  });
});
