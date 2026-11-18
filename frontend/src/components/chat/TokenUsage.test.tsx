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
    render(<TokenUsage snap={SNAP} />);
    // 2M + 20K ≈ 2M（formatTokens 按 1024 进位）
    const pill = screen.getByRole("button", { name: /token 消耗/ });
    expect(pill).toHaveTextContent("2M tok");
    expect(pill.querySelector("svg")).not.toBeNull();
  });

  it("会话累计还没有时用本轮消耗顶上（第一轮进行中）", () => {
    const snap = { contextTokens: 10_810, turnInputTokens: 10_810, outputTokens: 793 };
    render(<TokenUsage snap={snap} />);
    const pill = screen.getByRole("button", { name: /token 消耗/ });
    expect(pill).toHaveTextContent("11.3K tok");

    fireEvent.click(pill);
    const panel = screen.getByRole("dialog", { name: "token 用量" });
    // 数字来自本轮，标题就如实写「本轮消耗」，不冒充会话累计。
    expect(panel).toHaveTextContent("本轮消耗");
    expect(panel).toHaveTextContent("输入 / 输出10.6K / 793");
    expect(panel).not.toHaveTextContent("会话累计消耗");
  });

  it("点开详情：会话累计 + 缓存 + 生成速度，不重复报本轮消耗与 API 耗时", () => {
    render(<TokenUsage snap={SNAP} />);
    expect(screen.queryByRole("dialog")).toBeNull();

    const trigger = screen.getByRole("button", { name: /token 消耗/ });
    fireEvent.click(trigger);

    const panel = screen.getByRole("dialog", { name: "token 用量" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(panel).toHaveTextContent("会话累计消耗");
    expect(panel).toHaveTextContent("输入 / 输出2M / 20K");
    // 缓存三项从上下文弹窗搬过来：它们是最近一次请求的数，单独一段。
    expect(panel).toHaveTextContent("缓存（最近一次请求）");
    expect(panel).toHaveTextContent("缓存读取10.2K");
    expect(panel).toHaveTextContent("缓存命中97%");
    // 最近一次请求 840 tok ÷ 4s
    expect(panel).toHaveTextContent("生成速度210 tok/s");
    // 本轮消耗 / 本回合 API 耗时 / 轮·工具·事件都不再出现在这里。
    expect(panel).not.toHaveTextContent("本轮消耗");
    expect(panel).not.toHaveTextContent("API 耗时");
    expect(panel).not.toHaveTextContent("其中思考");
  });

  it("再点一次、按 Esc、点外部都会关闭详情", () => {
    render(<TokenUsage snap={SNAP} />);
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
    const { container } = render(<TokenUsage snap={undefined} />);
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
