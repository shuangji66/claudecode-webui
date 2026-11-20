import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { TurnTimer } from "./TurnTimer";
import { __resetSyncState, noteFrame } from "../../store/useAppStore";

const NOW = Date.parse("2026-01-02T00:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  __resetSyncState();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TurnTimer", () => {
  it("显示「少女祈祷中」和已进行秒数，并按秒递增", () => {
    render(<TurnTimer startedAt={NOW - 12_000} />);
    expect(screen.getByText("少女祈祷中")).toBeInTheDocument();
    expect(screen.getByText("12s")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("13s")).toBeInTheDocument();
  });

  it("超过一分钟改用 m:ss", () => {
    render(<TurnTimer startedAt={NOW - 125_000} />);
    expect(screen.getByText("2:05")).toBeInTheDocument();
  });

  it("起点未知（0）时不渲染任何东西", () => {
    const { container } = render(<TurnTimer startedAt={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  // 空闲时对话页一直挂在屏幕上：留一个每秒 setNow 的定时器等于白白重渲染。
  it("空闲（起点 0）时不开定时器", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    render(<TurnTimer startedAt={0} />);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("切到另一个回合（startedAt 变了）立刻按新起点算，不残留旧秒数", () => {
    const { rerender } = render(<TurnTimer startedAt={NOW - 90_000} />);
    expect(screen.getByText("1:30")).toBeInTheDocument();

    rerender(<TurnTimer startedAt={NOW - 3_000} />);
    expect(screen.getByText("3s")).toBeInTheDocument();
  });
});

// CLI 在一个字节都不回的那段时间里什么都不发（api_retry 只在失败后才有，
// keep_alive 又被后端丢掉了）。没有这句提示时「模型在长考」与「上游已经不回了」
// 在界面上一模一样，用户只能干等到 60 秒的字节流空闲阈值判死。
describe("TurnTimer 的上游沉默提示", () => {
  it("沉默不到 15 秒不提示", () => {
    render(<TurnTimer startedAt={NOW - 14_000} sessionId="s1" />);
    expect(screen.queryByText(/没有响应/)).toBeNull();
  });

  it("沉默超过 15 秒补一句「上游 Ns 没有响应」", () => {
    render(<TurnTimer startedAt={NOW - 32_000} sessionId="s1" />);
    expect(screen.getByText(/上游 32s 没有响应/)).toBeInTheDocument();
  });

  it("收到新帧后提示消失", () => {
    const { rerender } = render(<TurnTimer startedAt={NOW - 40_000} sessionId="s1" />);
    expect(screen.getByText(/上游 40s 没有响应/)).toBeInTheDocument();

    noteFrame("s1");
    rerender(<TurnTimer startedAt={NOW - 40_000} sessionId="s1" />);
    expect(screen.queryByText(/没有响应/)).toBeNull();
  });

  // 本地命令、子代理、MCP 调用都在自己这边耗时间：跑满 3 分钟的 bash 不该被
  // 报成「上游 180s 没有响应」。
  it("有工具在跑时不提示（watchSilence=false）", () => {
    render(<TurnTimer startedAt={NOW - 40_000} sessionId="s1" watchSilence={false} />);
    expect(screen.queryByText(/没有响应/)).toBeNull();
  });
});
