import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CliSettings } from "./CliSettings";
import { useAppStore } from "../../../store/useAppStore";

// 「设置 → CLI」放的都是直接映射成 claude 子进程环境变量（或回收循环阈值）的值：
// 子代理的并发 / 嵌套深度走后端设置补丁，空闲回收从「通用」页搬过来后仍按 5 分钟步进。
describe("设置 → CLI", () => {
  const saveSettings = vi.fn(async () => true);

  beforeEach(() => {
    localStorage.clear();
    saveSettings.mockClear();
    useAppStore.setState({
      settings: {
        idle_minutes: 10,
        subagent_max_concurrent: 10,
        subagent_spawn_depth: 1,
      } as never,
      info: null,
      settingsSaving: false,
      saveSettings: saveSettings as never,
    });
  });

  it("三项都在：并发子代理、递归深度、空闲回收", () => {
    render(<CliSettings />);
    for (const title of ["并发子代理", "子代理递归深度", "空闲回收"]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
  });

  // 并发上限是输入框：只收数字，失焦时夹到 1–50 并落补丁。
  it("并发子代理是输入框，失焦时落 subagent_max_concurrent 补丁", async () => {
    render(<CliSettings />);
    const input = screen.getByRole("textbox", { name: "并发子代理" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "23" } });
      fireEvent.blur(input);
    });
    expect(saveSettings).toHaveBeenCalledWith({ subagent_max_concurrent: 23 });
  });

  it("并发子代理只收数字，字母与符号被吞掉", async () => {
    render(<CliSettings />);
    const input = screen.getByRole("textbox", { name: "并发子代理" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "1a2 个" } });
    });
    expect(input).toHaveValue("12");
  });

  it("并发子代理超出上限时夹到 50", async () => {
    render(<CliSettings />);
    const input = screen.getByRole("textbox", { name: "并发子代理" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "999" } });
      fireEvent.blur(input);
    });
    expect(input).toHaveValue("50");
    expect(saveSettings).toHaveBeenCalledWith({ subagent_max_concurrent: 50 });
  });

  // 清空后失焦不能发 subagent_max_concurrent: 0（后端会 400），直接回填原值。
  it("并发子代理清空后失焦回填原值，不发请求", async () => {
    render(<CliSettings />);
    const input = screen.getByRole("textbox", { name: "并发子代理" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.blur(input);
    });
    expect(input).toHaveValue("10");
    expect(saveSettings).not.toHaveBeenCalled();
  });

  // 深度 1 是「关闭嵌套」，标签必须自己说清楚，否则「1 层」看起来像缺省没读出来。
  it("递归深度走下拉，1 层标注为关闭嵌套", async () => {
    render(<CliSettings />);
    expect(screen.getByRole("button", { name: "子代理递归深度" })).toHaveTextContent("1 层（不嵌套）");
    await act(async () => {
      screen.getByRole("button", { name: "子代理递归深度" }).click();
    });
    await act(async () => {
      screen.getByRole("option", { name: "3 层" }).click();
    });
    expect(saveSettings).toHaveBeenCalledWith({ subagent_spawn_depth: 3 });
  });

  // 保存失败时 store 里的值没变：输入框必须回填真实生效的那个数，
  // 否则界面会一直显示一个从没落盘的 25。
  it("并发子代理保存失败时回填原值", async () => {
    const failing = vi.fn(async () => false);
    useAppStore.setState({ saveSettings: failing as never });
    render(<CliSettings />);
    const input = screen.getByRole("textbox", { name: "并发子代理" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "25" } });
      fireEvent.blur(input);
    });
    expect(failing).toHaveBeenCalledWith({ subagent_max_concurrent: 25 });
    expect(input).toHaveValue("10");
  });

  it("空闲回收按 5 分钟步进，落的是 idle_minutes 补丁", async () => {
    useAppStore.setState({ settings: { idle_minutes: 10 } as never });
    render(<CliSettings />);
    await act(async () => {
      screen.getByRole("button", { name: "延长空闲回收" }).click();
    });
    expect(saveSettings).toHaveBeenCalledWith({ idle_minutes: 15 });
  });

  it("空闲回收向下也按 5 分钟步进", async () => {
    useAppStore.setState({ settings: { idle_minutes: 15 } as never });
    render(<CliSettings />);
    await act(async () => {
      screen.getByRole("button", { name: "缩短空闲回收" }).click();
    });
    expect(saveSettings).toHaveBeenCalledWith({ idle_minutes: 10 });
  });

  // 配置文件被手改成不在档位上的值时，按一次要落到最近的档位，而不是 7+5=12。
  it("空闲回收把非档位值归到最近档位再步进", async () => {
    useAppStore.setState({ settings: { idle_minutes: 7 } as never });
    render(<CliSettings />);
    await act(async () => {
      screen.getByRole("button", { name: "延长空闲回收" }).click();
    });
    expect(saveSettings).toHaveBeenCalledWith({ idle_minutes: 10 });
  });

  it("空闲回收到达边界时按钮禁用", () => {
    useAppStore.setState({ settings: { idle_minutes: 5 } as never });
    const { unmount } = render(<CliSettings />);
    expect(screen.getByRole("button", { name: "缩短空闲回收" })).toBeDisabled();
    unmount();

    useAppStore.setState({ settings: { idle_minutes: 60 } as never });
    render(<CliSettings />);
    expect(screen.getByRole("button", { name: "延长空闲回收" })).toBeDisabled();
  });
});
