import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TokenUsage } from "./TokenUsage";

// 真实帧算出来的快照（见 lib/usage.test.ts）。
const SNAP = {
  contextTokens: 9312,
  contextWindow: 200000,
  cacheHitRate: 9000 / 9312,
  inputTokens: 410,
  cacheReadTokens: 10_400,
  cacheCreationTokens: 0,
  outputTokens: 793,
  turnInputTokens: 10_810,
  sessionInputTokens: 2_048_000,
  sessionOutputTokens: 20_480,
  genMs: 4000,
  genTokens: 840,
  thinkingTokens: 300,
  apiMs: 11_300,
};

describe("TokenUsage", () => {
  it("胶囊显示会话累计总量，图标与数字是同一个按钮", () => {
    render(<TokenUsage snap={SNAP} turns={1} tools={4} events={12} />);
    // 2M + 20K ≈ 2M（formatTokens 按 1024 进位）
    const pill = screen.getByRole("button", { name: /token 消耗/ });
    expect(pill).toHaveTextContent("2M tok");
    expect(pill.querySelector("svg")).not.toBeNull();
  });

  it("会话累计还没有时用本轮消耗顶上（第一轮进行中）", () => {
    const snap = { contextTokens: 10_810, turnInputTokens: 10_810, outputTokens: 793 };
    render(<TokenUsage snap={snap} turns={1} tools={0} events={3} />);
    expect(screen.getByRole("button", { name: /token 消耗/ })).toHaveTextContent("11.3K tok");
  });

  it("点开详情：本轮消耗 / 会话累计 / 速度与耗时分开列", () => {
    render(<TokenUsage snap={SNAP} turns={1} tools={4} events={12} />);
    expect(screen.queryByRole("dialog")).toBeNull();

    const trigger = screen.getByRole("button", { name: /token 消耗/ });
    fireEvent.click(trigger);

    const panel = screen.getByRole("dialog", { name: "token 用量" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    // 本轮：输入含缓存 10.5K + 输出 793 = 11.3K
    expect(panel).toHaveTextContent("本轮消耗");
    expect(panel).toHaveTextContent("输入（含缓存）10.6K");
    expect(panel).toHaveTextContent("输出793");
    expect(panel).toHaveTextContent("合计11.3K tok");
    expect(panel).toHaveTextContent("其中思考300 tok");
    // 会话累计
    expect(panel).toHaveTextContent("会话累计消耗");
    expect(panel).toHaveTextContent("输入 / 输出2M / 20K");
    // 速度与耗时（最近一次请求 840 tok ÷ 4s）
    expect(panel).toHaveTextContent("生成速度210 tok/s");
    expect(panel).toHaveTextContent("本回合 API 耗时11.30s");
    expect(panel).toHaveTextContent("累计1 轮 · 4 次工具 · 12 条事件");
  });

  it("再点一次、按 Esc、点外部都会关闭详情", () => {
    render(<TokenUsage snap={SNAP} turns={1} tools={4} events={12} />);
    const trigger = screen.getByRole("button", { name: /token 消耗/ });

    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("一个 token 数都没有时整颗不渲染（不摆 0）", () => {
    const { container } = render(<TokenUsage snap={undefined} turns={2} tools={3} events={8} />);
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
