import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TurnCollapse } from "./TurnCollapse";

/**
 * 轮首那一行：已结束的轮把整轮过程收起来之后显示的「已完成，用时 … ⌄」。
 *
 * 只有两种情况：拿得到时长就报时长，拿不到就只写「已完成」。
 */
describe("TurnCollapse", () => {
  it("中文用口语写法报时长，不做 mm:ss 换算", () => {
    render(<TurnCollapse durationMs={195_000} open={false} onToggle={() => {}} />);
    // 读这一行时不想心算「03:15 是几分几秒」。
    expect(screen.getByText("已完成，用时 3 分 15 秒")).toBeInTheDocument();
  });

  it("拿不到时长时只写「已完成」", () => {
    render(<TurnCollapse open={false} onToggle={() => {}} />);
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.queryByText(/用时/)).toBeNull();
  });

  it("点一下切换开合，并反映在 aria-expanded 上", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<TurnCollapse durationMs={45_000} open={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<TurnCollapse durationMs={45_000} open onToggle={onToggle} />);
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
  });

  // 这一行是「过程的总括」，正文是这一轮的结果：两者之间要有视觉边界，
  // 否则标题与正文糊成一团（DSH 在收起行下面也画了一条线）。
  // **主题色**：灰细线在正文里几乎看不见，读起来像排版失误。
  it("下方那条分隔线用主题色", () => {
    const { container } = render(<TurnCollapse durationMs={45_000} open={false} onToggle={() => {}} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("border-b");
    expect(root.className).toContain("border-brand/60");
  });

  // 箭头是这句话的一部分（「点这里展开」），跟着文字走；甩到行尾在宽屏上离文字半屏远。
  it("箭头紧跟在「已完成，用时 …」右边，不推到行尾", () => {
    render(<TurnCollapse durationMs={45_000} open={false} onToggle={() => {}} />);
    const button = screen.getByRole("button", { expanded: false });
    const svg = button.querySelector("svg") as SVGElement;
    expect(svg).not.toBeNull();
    expect(svg.className.baseVal).not.toContain("ml-auto");
    // 文字在前、箭头在后：顺序就是读的顺序。
    expect(button.lastElementChild).toBe(svg);
  });

  it("收起时箭头朝右，展开后朝下", () => {
    const { rerender } = render(<TurnCollapse durationMs={45_000} open={false} onToggle={() => {}} />);
    const collapsed = screen.getByRole("button", { expanded: false }).querySelector("svg") as SVGElement;
    expect(collapsed.className.baseVal).toContain("-rotate-90");

    rerender(<TurnCollapse durationMs={45_000} open onToggle={() => {}} />);
    const expanded = screen.getByRole("button", { expanded: true }).querySelector("svg") as SVGElement;
    expect(expanded.className.baseVal).not.toContain("-rotate-90");
  });
});

// 「结束」不等于「做完了」：用户按停止、上游报错、进程被结束都会让这一轮收尾，
// 把它们一律写成「已完成，用时 …」等于告诉用户「这活干完了」，而模型其实被打断了。
// 文案对齐 DSH 的 message.stopped / message.turnProcess.failed。
describe("TurnCollapse 按结局给文案", () => {
  it("被中断时写「已停止」，且不报用时", () => {
    render(<TurnCollapse durationMs={195_000} outcome="stopped" open={false} onToggle={() => {}} />);
    expect(screen.getByText("已停止")).toBeInTheDocument();
    // 那个时长只说明「跑了多久然后被打断」，挂在「已完成」后面读起来就是完成耗时。
    expect(screen.queryByText(/用时/)).toBeNull();
  });

  it("出错时写「本轮失败」，且不报用时", () => {
    render(<TurnCollapse durationMs={30_000} outcome="failed" open={false} onToggle={() => {}} />);
    expect(screen.getByText("本轮失败")).toBeInTheDocument();
    expect(screen.queryByText(/用时/)).toBeNull();
  });

  it("正常收尾才写「已完成，用时 …」", () => {
    render(<TurnCollapse durationMs={195_000} outcome="ok" open={false} onToggle={() => {}} />);
    expect(screen.getByText("已完成，用时 3 分 15 秒")).toBeInTheDocument();
  });
});
