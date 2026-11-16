import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("点上下文圈弹出详情：绝对值、缓存命中、本回合输出与速度", () => {
    render(<UsageStats snap={SNAP} turns={1} tools={0} events={9} />);
    // 关着的时候不渲染，也不再往 title 里塞长文（触屏拿不到悬停）。
    expect(screen.queryByRole("dialog")).toBeNull();

    const trigger = screen.getByRole("button", { name: "上下文占用 5%" });
    fireEvent.click(trigger);

    const panel = screen.getByRole("dialog", { name: "用量详情" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(panel).toHaveTextContent("上下文占用");
    expect(panel).toHaveTextContent("9.1K / 195.3K");
    expect(panel).toHaveTextContent("缓存命中97%");
    expect(panel).toHaveTextContent("本回合输出7 tok");
    expect(panel).toHaveTextContent("API 耗时0.02s");
    expect(panel).toHaveTextContent("生成速度318 tok/s");
    expect(panel).toHaveTextContent("累计1 轮 · 9 条事件");
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
