import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TurnCollapse } from "./TurnCollapse";

/**
 * 轮首那一行：已结束的轮把整轮过程收起来之后显示的「已完成，用时 … ⌄」。
 *
 * 只有两种情况：拿得到时长就报时长，拿不到（转录回放没有 result 行）就只写「已完成」。
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
  it("下方带一条分隔线", () => {
    const { container } = render(<TurnCollapse durationMs={45_000} open={false} onToggle={() => {}} />);
    expect(container.firstElementChild?.className).toContain("border-b");
  });
});
