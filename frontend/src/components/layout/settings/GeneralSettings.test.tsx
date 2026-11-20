import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { GeneralSettings } from "./GeneralSettings";
import { useAppStore } from "../../../store/useAppStore";

// 通用设置现在是「一行一项」的清单（对齐 DSH 的 Setting-Cell）：左边标题 + 说明、
// 右边一个控件。这里钉住三件事——行还在（标题与说明都渲染）、枚举项走下拉且写的是
// 本机偏好、字号按钮落的是 settings 补丁。
describe("设置 → 通用", () => {
  const saveSettings = vi.fn(async () => true);

  beforeEach(() => {
    localStorage.clear();
    saveSettings.mockClear();
    useAppStore.setState({
      settings: {
        permission_mode: "default",
        locale: "zh",
        font_size: 15,
      } as never,
      info: null,
      settingsSaving: false,
      saveSettings: saveSettings as never,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("每个设置项都是一行：标题与说明并列出现", () => {
    render(<GeneralSettings />);
    for (const title of ["默认权限", "外观", "语言", "字号", "空闲回收", "过程展示", "收起时机", "收起后的回复"]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    // 说明跟着当前值走：默认「标准」档的说明文字。
    expect(screen.getByText("不分组：每一步各占一行，工具操作折成一行，点开看正文。")).toBeInTheDocument();
  });

  it("过程展示走下拉，选中后写本机偏好并换掉这一行的说明", async () => {
    render(<GeneralSettings />);
    await act(async () => {
      screen.getByRole("button", { name: "过程展示" }).click();
    });
    await act(async () => {
      screen.getByRole("option", { name: "简洁" }).click();
    });
    expect(localStorage.getItem("ccweb-process-view")).toBe("concise");
    expect(screen.getByText("连续的过程折成一行摘要（已读取文件并运行了命令），点开才看每一步。")).toBeInTheDocument();
  });

  it("字号用 ± 按钮，落的是 font_size 补丁", async () => {
    render(<GeneralSettings />);
    await act(async () => {
      screen.getByRole("button", { name: "增大字号" }).click();
    });
    expect(saveSettings).toHaveBeenCalledWith({ font_size: 16 });
    await act(async () => {
      screen.getByRole("button", { name: "减小字号" }).click();
    });
    expect(saveSettings).toHaveBeenCalledWith({ font_size: 14 });
  });

  it("空闲回收按 5 分钟步进，落的是 idle_minutes 补丁", async () => {
    useAppStore.setState({ settings: { idle_minutes: 10 } as never });
    render(<GeneralSettings />);
    await act(async () => {
      screen.getByRole("button", { name: "延长空闲回收" }).click();
    });
    expect(saveSettings).toHaveBeenCalledWith({ idle_minutes: 15 });
  });

  it("空闲回收向下也按 5 分钟步进", async () => {
    useAppStore.setState({ settings: { idle_minutes: 15 } as never });
    render(<GeneralSettings />);
    await act(async () => {
      screen.getByRole("button", { name: "缩短空闲回收" }).click();
    });
    expect(saveSettings).toHaveBeenCalledWith({ idle_minutes: 10 });
  });

  // 配置文件被手改成不在档位上的值时，按一次要落到最近的档位，而不是 7+5=12。
  it("空闲回收把非档位值归到最近档位再步进", async () => {
    useAppStore.setState({ settings: { idle_minutes: 7 } as never });
    render(<GeneralSettings />);
    await act(async () => {
      screen.getByRole("button", { name: "延长空闲回收" }).click();
    });
    expect(saveSettings).toHaveBeenCalledWith({ idle_minutes: 10 });
  });

  it("空闲回收到达边界时按钮禁用", () => {
    useAppStore.setState({ settings: { idle_minutes: 5 } as never });
    const { unmount } = render(<GeneralSettings />);
    expect(screen.getByRole("button", { name: "缩短空闲回收" })).toBeDisabled();
    unmount();

    useAppStore.setState({ settings: { idle_minutes: 60 } as never });
    render(<GeneralSettings />);
    expect(screen.getByRole("button", { name: "延长空闲回收" })).toBeDisabled();
  });

  it("访问令牌只在环境变量令牌模式下出现", () => {
    const { unmount } = render(<GeneralSettings />);
    expect(screen.queryByPlaceholderText("CCWEB_AUTH_TOKEN")).toBeNull();
    unmount();

    useAppStore.setState({ info: { auth_mode: "token" } as never });
    render(<GeneralSettings />);
    expect(screen.getByPlaceholderText("CCWEB_AUTH_TOKEN")).toBeInTheDocument();
  });
});
