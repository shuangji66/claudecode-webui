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
  it("显示轮数 / 会话累计 / tok/s（工具数在弹层的累计里）", () => {
    render(<UsageSummary snap={SNAP} turns={3} events={40} />);
    // 中间那个是**会话累计**（输入含缓存 + 输出）：2048K + 20.5K ≈ 2M，
    // 不是上下文占用、也不是本轮消耗。
    // 840 tok ÷ 4s = 210 tok/s；不是整轮输出 ÷ 整轮 API 耗时。
    expect(screen.getByText("3 轮 · 2M · 210 tok/s")).toBeInTheDocument();
    expect(screen.queryByText(/工具/)).toBeNull();
  });

  // 以前窄屏（`sm:hidden`）把这一行折叠成只剩「N 轮」：手机上没有任何地方能看到
  // 会话总量与速度，与桌面模式对不上。现在两种视口是同一段文字。
  it("窄屏也显示完整的三段，不再折叠成只剩轮数", () => {
    const { container } = render(<UsageSummary snap={SNAP} turns={3} events={40} />);
    expect(container.querySelector(".sm\\:hidden")).toBeNull();
    expect(container.textContent).toBe("3 轮 · 2M · 210 tok/s");
  });

  // 首轮还没跑完（result 未到）时只有流式阶段按请求攒下的即时累计，
  // 底栏同样要报出总量，不能只有一个「1 轮」。
  it("回合进行中就用本回合已发请求的即时累计报总量", () => {
    render(
      <UsageSummary
        snap={{ contextTokens: 9312, contextWindow: 200000, turnCountedInputTokens: 10_000, turnCountedOutputTokens: 500 }}
        turns={1}
        events={3}
      />,
    );
    expect(screen.getByText("1 轮 · 10.3K")).toBeInTheDocument();
  });

  it("没有 usage 时退回事件计数，不编造 token 数", () => {
    render(<UsageSummary snap={undefined} turns={0} events={5} />);
    expect(screen.getByText("共 5 条事件")).toBeInTheDocument();
    expect(screen.queryByText(/tok\/s/)).toBeNull();
  });

  it("什么都没有时渲染空串", () => {
    const { container } = render(<UsageSummary snap={undefined} turns={0} events={0} />);
    expect(container.textContent).toBe("");
  });
});

describe("ContextUsage", () => {
  it("上下文用圈 + 百分比，整个用量块是一个按钮", () => {
    const { container } = render(<UsageStats snap={SNAP} turns={3} tools={12} events={40} />);
    // 轮数 / 总量 / 速度 / 占用**在同一个按钮里**：以前只有那颗小圈能点，
    // 想看一眼总量得先瞄准右边，点偏了没反应。
    const trigger = screen.getByRole("button", { name: "3 轮 · 2M · 210 tok/s · 上下文占用 5%" });
    expect(trigger).toHaveTextContent("3 轮 · 2M · 210 tok/s");
    expect(trigger).toHaveTextContent("5%");
    expect(screen.queryAllByRole("button")).toHaveLength(1);
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

    const trigger = screen.getByRole("button", { name: /上下文占用 5%/ });
    fireEvent.click(trigger);

    const panel = screen.getByRole("dialog", { name: "用量" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(panel).toHaveTextContent("已用9.1K / 195.3K");
    // 会话累计与缓存明细合成一块，不挂分组标题；输入 / 输出各占一行
    expect(panel).not.toHaveTextContent("会话累计消耗");
    expect(panel).not.toHaveTextContent("缓存（最近一次请求）");
    expect(panel).toHaveTextContent("合计2M tok");
    expect(panel).toHaveTextContent("输入2M");
    expect(panel).toHaveTextContent("输出20K");
    // 未命中缓存 = 这次请求没吃到缓存的输入侧，排在缓存读取上面
    expect(panel).toHaveTextContent("未命中缓存12");
    expect(panel).not.toHaveTextContent("新输入");
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

  // 首轮还在跑（没有 result → 没有 session*Tokens）时，弹层以前只剩一根占用条：
  // 会话累计那三行整块消失，手机上会以为「这个版本没有这三个数」。
  it("回合进行中（还没有 result）也显示合计 / 输入 / 输出", () => {
    render(
      <UsageStats
        snap={{
          contextTokens: 61_500,
          contextWindow: 1_000_000,
          inputTokens: 2600,
          cacheReadTokens: 58_900,
          turnCountedInputTokens: 61_500,
          turnCountedOutputTokens: 1200,
        }}
        turns={1}
        tools={16}
        events={25}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /上下文占用 6%/ }));
    const panel = screen.getByRole("dialog", { name: "用量" });
    expect(panel).toHaveTextContent("合计61.2K tok");
    expect(panel).toHaveTextContent("输入60.1K");
    expect(panel).toHaveTextContent("输出1.2K");
  });

  it("再点一次、按 Esc、点外部都会关闭详情", () => {
    render(<UsageStats snap={SNAP} turns={1} tools={0} events={9} />);
    const trigger = screen.getByRole("button", { name: /上下文占用 5%/ });

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

  // 没有窗口（还没跑完第一轮，result 没到）不等于没有用量：合计 / 输入 / 输出与速度
  // 都是独立的数。占用的圈可以不画，但入口要能点开看那几个数。
  it("没有上下文窗口时仍然可点，弹层只少了占用那一段", () => {
    render(
      <UsageStats
        snap={{ contextTokens: 61_500, sessionInputTokens: 20_000, sessionOutputTokens: 1200, genMs: 2000, genTokens: 400 }}
        turns={2}
        tools={3}
        events={12}
      />,
    );
    const trigger = screen.getByRole("button", { name: "2 轮 · 20.7K · 200 tok/s" });
    expect(trigger.querySelector("svg")).toBeNull();
    fireEvent.click(trigger);
    const panel = screen.getByRole("dialog", { name: "用量" });
    expect(panel).toHaveTextContent("合计20.7K tok");
    expect(panel).toHaveTextContent("生成速度200 tok/s");
    // 占用那一段整块不出现（没有窗口就不报百分比），也不留一个空标题。
    expect(panel).not.toHaveTextContent("上下文占用");
    expect(panel).not.toHaveTextContent("已用");
  });

  // 速度计读的是滚动窗口的加权值（Σ输出 ÷ Σ生成耗时），不是最近一次请求：
  // 单次请求的样本在工具循环里能差好几倍。
  it("速度用窗口里的 Σ输出 ÷ Σ生成耗时，不是最近一次请求", () => {
    render(
      <UsageStats
        snap={{
          contextTokens: 1000,
          contextWindow: 200_000,
          speedSamples: [
            { tokens: 30, ms: 1000, at: 1 },
            { tokens: 800, ms: 4000, at: 2 },
          ],
          genMs: 1000,
          genTokens: 30,
        }}
        turns={1}
        tools={0}
        events={2}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /上下文占用 1%/ }));
    // (30 + 800) ÷ 5s = 166 tok/s，而不是最后那次 30 ÷ 1s = 30 tok/s。
    expect(screen.getByRole("dialog", { name: "用量" })).toHaveTextContent("生成速度166 tok/s");
  });
});
