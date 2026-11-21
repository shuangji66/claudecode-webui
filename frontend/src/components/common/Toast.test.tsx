import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Toast } from "./Toast";
import { TOAST_MS, useAppStore } from "../../store/useAppStore";

describe("Toast", () => {
  afterEach(() => {
    act(() => useAppStore.getState().clearToast());
    vi.useRealTimers();
  });

  it("没有提示时不渲染任何东西", () => {
    useAppStore.setState({ toast: null });
    const { container } = render(<Toast />);
    expect(container.firstChild).toBeNull();
  });

  // 只报一句就消失：它浮在输入框上方，一直挂着会挡住点按。
  it("弹出后到点自动消失", () => {
    vi.useFakeTimers();
    useAppStore.setState({ toast: null });
    render(<Toast />);

    act(() => useAppStore.getState().showToast("已归档的对话需要先取消归档才能打开"));
    expect(screen.getByRole("status")).toHaveTextContent("先取消归档");

    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 100);
    });
    expect(screen.getByRole("status")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  // 连点两处：后一条覆盖前一条，并且从新的一条重新计时（旧计时器不能把它提前收掉）。
  it("新的提示覆盖旧的并重新计时", () => {
    vi.useFakeTimers();
    useAppStore.setState({ toast: null });
    render(<Toast />);

    act(() => useAppStore.getState().showToast("第一条"));
    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 200);
    });
    act(() => useAppStore.getState().showToast("第二条"));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole("status")).toHaveTextContent("第二条");
  });
});
