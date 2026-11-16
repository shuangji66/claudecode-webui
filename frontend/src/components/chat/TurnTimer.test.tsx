import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { TurnTimer } from "./TurnTimer";

const NOW = Date.parse("2026-01-02T00:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
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

  it("切到另一个回合（startedAt 变了）立刻按新起点算，不残留旧秒数", () => {
    const { rerender } = render(<TurnTimer startedAt={NOW - 90_000} />);
    expect(screen.getByText("1:30")).toBeInTheDocument();

    rerender(<TurnTimer startedAt={NOW - 3_000} />);
    expect(screen.getByText("3s")).toBeInTheDocument();
  });
});
