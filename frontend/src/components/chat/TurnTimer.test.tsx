import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { TurnTimer } from "./TurnTimer";
import { resetWaitLabelCache } from "../../lib/waitLabel";
import { __resetSyncState, noteFrame, useAppStore } from "../../store/useAppStore";

const NOW = Date.parse("2026-01-02T00:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  __resetSyncState();
  localStorage.clear();
  resetWaitLabelCache();
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

  // 手动 `/compact` 实测 25.3 秒只发一条 `status: compacting` 就没了声音，
  // 而 CLI 自己的压缩心跳是 30 秒一次：15 秒阈值必然在中间误报「上游 Ns 没有响应」。
  // 压缩是 CLI 自己在跑摘要请求，压根不等上游——那时该说的是「正在压缩上下文」。
  it("压缩中不报「上游没有响应」，改说正在压缩", () => {
    useAppStore.getState().applyEvent("s1", {
      kind: "cli",
      data: { type: "system", subtype: "status", status: "compacting" },
    } as never);
    render(<TurnTimer startedAt={NOW - 40_000} sessionId="s1" />);
    expect(screen.queryByText(/没有响应/)).toBeNull();
    expect(screen.getByText(/正在压缩上下文/)).toBeInTheDocument();
  });

  it("压缩结束时那行提示消失", () => {
    useAppStore.getState().applyEvent("s1", {
      kind: "cli",
      data: { type: "system", subtype: "status", status: "compacting" },
    } as never);
    useAppStore.getState().applyEvent("s1", {
      kind: "cli",
      data: { type: "system", subtype: "status", status: "requesting" },
    } as never);
    render(<TurnTimer startedAt={NOW - 40_000} sessionId="s1" />);
    // `requesting` 本身是一条帧 → 沉默水位被刷新，这一刻既不提示压缩也不提示沉默。
    expect(screen.queryByText(/正在压缩上下文/)).toBeNull();
    expect(screen.queryByText(/没有响应/)).toBeNull();
  });

  // hook 是用户自己配的本地进程，跑多久与上游无关：长时间挂着的 hook 同样不该
  // 被说成「上游没有响应」。
  it("hook 在跑时说 hook，不报上游", () => {
    useAppStore.getState().applyEvent("s1", {
      kind: "cli",
      data: { type: "system", subtype: "hook_started", hook_id: "h1", hook_name: "fmt", hook_event: "PostToolUse" },
    } as never);
    render(<TurnTimer startedAt={NOW - 90_000} sessionId="s1" />);
    expect(screen.queryByText(/没有响应/)).toBeNull();
    // 显示的是 hook 的名字（`hook_name`），不是它这次运行的 `hook_id`：
    // 一串 UUID 对用户没有意义。
    expect(screen.getByText(/hook fmt 正在跑/)).toBeInTheDocument();
  });
});

// 文案可以换（设置 → 通用最底部那一行，「自定义」）：整行 —— 自定义文案、秒数、
// 状态提示 —— 都用主题色，别退回灰细字。
describe("TurnTimer 的自定义文案与配色", () => {
  it("没有自定义时仍显示内置那句", () => {
    render(<TurnTimer startedAt={NOW - 5_000} />);
    expect(screen.getByText("少女祈祷中")).toBeInTheDocument();
  });

  it("设置过就用自定义文案，替掉内置那句", () => {
    localStorage.setItem("ccweb-wait-label", "少女祈祷");
    resetWaitLabelCache();
    render(<TurnTimer startedAt={NOW - 5_000} />);
    expect(screen.getByText("少女祈祷")).toBeInTheDocument();
    expect(screen.queryByText("少女祈祷中")).toBeNull();
  });

  it("文案、秒数与沉默提示整行都是主题色", () => {
    localStorage.setItem("ccweb-wait-label", "少女祈祷");
    resetWaitLabelCache();
    const { container } = render(<TurnTimer startedAt={NOW - 32_000} sessionId="s1" />);
    const row = container.firstElementChild as HTMLElement;
    expect(row.className).toContain("text-brand");
    expect(screen.getByText("少女祈祷").className).not.toContain("text-muted");
    expect(screen.getByText("32s").className).not.toContain("text-faint");
    expect(screen.getByText(/上游 32s 没有响应/).className).not.toContain("text-faint");
  });
});
