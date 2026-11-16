import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { UsageStats } from "./UsageStats";

// 真实帧算出来的快照（见 lib/usage.test.ts）。
const SNAP = {
  contextTokens: 9312,
  contextWindow: 200000,
  cacheHitRate: 9000 / 9312,
  outputTokens: 7,
  apiMs: 22,
};

describe("UsageStats", () => {
  it("有 usage 时显示轮数 / 工具 / tok/s，上下文单独用圈 + 百分比", () => {
    const { container } = render(<UsageStats snap={SNAP} turns={3} tools={12} events={40} />);
    expect(screen.getByText("3 轮 · 12 工具 · 318 tok/s")).toBeInTheDocument();
    expect(screen.getByLabelText("上下文占用 5%")).toBeInTheDocument();
    // 圈是两段圆：底环 + 按比例画弧（5% → dashoffset 接近满周长）
    const arcs = container.querySelectorAll("svg circle");
    expect(arcs).toHaveLength(2);
    const dash = Number(arcs[1].getAttribute("stroke-dasharray"));
    const offset = Number(arcs[1].getAttribute("stroke-dashoffset"));
    expect(dash).toBeGreaterThan(0);
    expect(offset).toBeCloseTo(dash * 0.95, 3);
  });

  it("悬浮提示给出上下文绝对值、缓存命中与本回合输出", () => {
    const { container } = render(<UsageStats snap={SNAP} turns={1} tools={0} events={9} />);
    const title = container.querySelector("span[title]")?.getAttribute("title") ?? "";
    expect(title).toContain("上下文 9.1K / 195.3K（5%）");
    expect(title).toContain("缓存命中 97%");
    expect(title).toContain("本回合输出 7 tok · API 0.02s");
  });

  it("没有 usage 时退回事件计数，不编造 token 数", () => {
    render(<UsageStats snap={undefined} turns={0} tools={2} events={5} />);
    expect(screen.getByText("共 5 条事件 · 2 次工具")).toBeInTheDocument();
    expect(screen.queryByText(/tok\/s/)).toBeNull();
  });

  it("什么都没有时渲染空串", () => {
    const { container } = render(<UsageStats snap={undefined} turns={0} tools={0} events={0} />);
    expect(container.textContent).toBe("");
  });
});
