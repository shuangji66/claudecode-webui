import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Toast } from "./Toast";
import { TOAST_MS, useAppStore } from "../../store/useAppStore";

describe("Toast", () => {
  afterEach(() => {
    act(() => useAppStore.getState().clearToast());
    vi.useRealTimers();
  });

  // 活区常驻、内容为空：读屏软件不朗读「和容器一起插入」的内容，
  // 只朗读「已在监听的容器内容变了」。所以这里断言的是「没有可见文案」。
  it("没有提示时活区存在但没有任何文案", () => {
    useAppStore.setState({ toast: null });
    render(<Toast />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
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
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
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
