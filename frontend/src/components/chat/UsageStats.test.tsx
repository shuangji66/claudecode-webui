import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UsageStats, UsageSummary } from "./UsageStats";

// 真实帧算出来的快照（见 lib/usage.test.ts）。
const SNAP = {
  contextTokens: 9312,
  contextWindow: 200000,
  cacheHitRate: 9000 / 9312,
  inputTokens: 12,
  cacheReadTokens: 9000,
  cacheCreationTokens: 300,
  outputTokens: 7000,
  turnInputTokens: 1_000_000,
  sessionInputTokens: 2_048_000,
  sessionOutputTokens: 20_480,
  genMs: 4000,
  genTokens: 840,
  thinkingTokens: 4000,
  apiMs: 22,
};

describe("UsageSummary", () => {
  it("显示轮数 / 工具 / tok/s（tok/s 取最近一次请求）", () => {
    render(<UsageSummary snap={SNAP} turns={3} tools={12} events={40} />);
    // 840 tok ÷ 4s = 210 tok/s；不是整轮输出 ÷ 整轮 API 耗时。
    expect(screen.getByText("3 轮 · 12 工具 · 210 tok/s")).toBeInTheDocument();
  });

  it("没有 usage 时退回事件计数，不编造 token 数", () => {
    render(<UsageSummary snap={undefined} turns={0} tools={2} events={5} />);
    expect(screen.getByText("共 5 条事件 · 2 次工具")).toBeInTheDocument();
    expect(screen.queryByText(/tok\/s/)).toBeNull();
  });

  it("什么都没有时渲染空串", () => {
    const { container } = render(<UsageSummary snap={undefined} turns={0} tools={0} events={0} />);
    expect(container.textContent).toBe("");
  });
});

describe("ContextUsage", () => {
  it("上下文用圈 + 百分比，点开只讲占用", () => {
    const { container } = render(<UsageStats snap={SNAP} turns={3} tools={12} events={40} />);
    expect(screen.getByLabelText("上下文占用 5%")).toBeInTheDocument();
    // 圈是两段圆：底环 + 按比例画弧（5% → dashoffset 接近满周长）
    const arcs = container.querySelectorAll("svg circle");
    expect(arcs).toHaveLength(2);
    const dash = Number(arcs[1].getAttribute("stroke-dasharray"));
    const offset = Number(arcs[1].getAttribute("stroke-dashoffset"));
    expect(dash).toBeGreaterThan(0);
    expect(offset).toBeCloseTo(dash * 0.95, 3);
  });

  it("点开详情：占用 / 会话累计 / 缓存 / 速度 / 轮次都在同一个弹层", () => {
    render(<UsageStats snap={SNAP} turns={1} tools={4} events={11} />);
    // 关着的时候不渲染，也不再往 title 里塞长文（触屏拿不到悬停）。
    expect(screen.queryByRole("dialog")).toBeNull();

    const trigger = screen.getByRole("button", { name: "上下文占用 5%" });
    fireEvent.click(trigger);

    const panel = screen.getByRole("dialog", { name: "上下文占用" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(panel).toHaveTextContent("已用9.1K / 195.3K");
    expect(panel).toHaveTextContent("新输入12");
    // 会话累计（整轮累计口径的输入侧 + 输出之和）
    expect(panel).toHaveTextContent("会话累计消耗");
    expect(panel).toHaveTextContent("合计2M tok");
    expect(panel).toHaveTextContent("输入 / 输出2M / 20K");
    // 缓存三项是最近一次请求的数（不再挂分组标题）
    expect(panel).not.toHaveTextContent("缓存（最近一次请求）");
    expect(panel).toHaveTextContent("缓存读取8.8K");
    expect(panel).toHaveTextContent("缓存写入300");
    expect(panel).toHaveTextContent("缓存命中97%");
    // 速度用最近一次请求的输出（840 ÷ 4s），累计行报轮 / 工具 / 事件
    expect(panel).toHaveTextContent("生成速度210 tok/s");
    expect(panel).toHaveTextContent("累计1 轮 · 4 次工具 · 11 条事件");
    // 本轮消耗只出现在回答下面那行小字里，弹层不重复；也没有解释性小字。
    expect(panel).not.toHaveTextContent("本轮消耗");
    expect(panel).not.toHaveTextContent("下一轮要发的上下文");
  });

  it("再点一次、按 Esc、点外部都会关闭详情", () => {
    render(<UsageStats snap={SNAP} turns={1} tools={0} events={9} />);
    const trigger = screen.getByRole("button", { name: "上下文占用 5%" });

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

  it("没有窗口或占用时不出圈（宁可不显示，也不画 0%）", () => {
    const { container } = render(<UsageStats snap={{ contextTokens: 9312 }} turns={0} tools={0} events={0} />);
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
