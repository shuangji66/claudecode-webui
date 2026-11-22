import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { GeneralSettings } from "./GeneralSettings";
import { resetWaitLabelCache, setWaitLabel, waitLabel } from "../../../lib/waitLabel";
import { resetBusyEnterCache } from "../../../lib/busyEnter";
import { useAppStore } from "../../../store/useAppStore";

// 通用设置现在是「一行一项」的清单（对齐 DSH 的 Setting-Cell）：左边标题 + 说明、
// 右边一个控件。这里钉住三件事——行还在（标题与说明都渲染）、枚举项走下拉且写的是
// 本机偏好、字号按钮落的是 settings 补丁。
describe("设置 → 通用", () => {
  const saveSettings = vi.fn(async () => true);

  beforeEach(() => {
    localStorage.clear();
    resetWaitLabelCache();
    resetBusyEnterCache();
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
    // 「自定义」那一行的简短说明：换的是哪句话 + 长度口径，一句说完。
    expect(screen.getByText("计时行的那句等待文案；6–12 个字符，汉字算 2 个。")).toBeInTheDocument();
    for (const title of ["默认权限", "外观", "语言", "字号", "过程展示", "收起时机", "收起后的回复", "繁忙时的发送行为", "自定义"]) {
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

  // 回合进行中的发送行为（对齐 DSH 的 composer-enter 那一行）：两档只存本机偏好，
  // 说明跟着选中值换（写清另一档由 Ctrl/⌘+Enter 承担）。
  it("繁忙时的发送行为走下拉：选中插话发送写本机偏好，说明跟着换", async () => {
    render(<GeneralSettings />);
    expect(screen.getByText(/回合进行中发送＝排队/)).toBeInTheDocument();

    await act(async () => {
      screen.getByRole("button", { name: "繁忙时的发送行为" }).click();
    });
    await act(async () => {
      screen.getByRole("option", { name: "插话发送" }).click();
    });

    expect(localStorage.getItem("ccweb-busy-enter")).toBe("steer");
    expect(screen.getByText(/回合进行中发送＝立刻并入本轮/)).toBeInTheDocument();
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

  it("访问令牌只在环境变量令牌模式下出现", () => {
    const { unmount } = render(<GeneralSettings />);
    expect(screen.queryByPlaceholderText("CCWEB_AUTH_TOKEN")).toBeNull();
    unmount();

    useAppStore.setState({ info: { auth_mode: "token" } as never });
    render(<GeneralSettings />);
    expect(screen.getByPlaceholderText("CCWEB_AUTH_TOKEN")).toBeInTheDocument();
  });

  // 最底部那一行换的是计时行那句「少女祈祷中」：合法就写本机偏好，
  // 不合法（少于 3 个汉字、或者字母数字不足 3 个）不落盘、失焦后回退。
  it("自定义等待文案：合法的写进本机偏好，不合法的不保存", async () => {
    render(<GeneralSettings />);
    const input = screen.getByPlaceholderText("少女祈祷中") as HTMLInputElement;
    expect(input.value).toBe("");

    await act(async () => {
      fireEvent.change(input, { target: { value: "少女祈祷" } });
      fireEvent.blur(input);
    });
    expect(localStorage.getItem("ccweb-wait-label")).toBe("少女祈祷");
    expect(input.value).toBe("少女祈祷");

    await act(async () => {
      fireEvent.change(input, { target: { value: "ab" } });
    });
    // 打了两个字母（宽度 2 < 6）：不写盘，边框标红
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.className).toContain("border-warn/70");
    expect(localStorage.getItem("ccweb-wait-label")).toBe("少女祈祷");

    await act(async () => {
      fireEvent.blur(input);
    });
    // 失焦后回退到上次生效的值
    expect(input.value).toBe("少女祈祷");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    // 宽度计数器跟着当前值走：四个汉字 = 8 / 12
    expect(screen.getByText("8/12")).toBeInTheDocument();
  });

  // 中英混写要按宽度算：四个汉字 + 两个字母 = 10，合法。
  it("自定义等待文案：中英混写按宽度算，合法的照样落盘", async () => {
    render(<GeneralSettings />);
    const input = screen.getByPlaceholderText("少女祈祷中") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "祈祷中ab" } });
    });
    expect(screen.getByText("8/12")).toBeInTheDocument();
    expect(input.getAttribute("aria-invalid")).toBeNull();
    await act(async () => {
      fireEvent.blur(input);
    });
    expect(localStorage.getItem("ccweb-wait-label")).toBe("祈祷中ab");
  });

  it("自定义等待文案：清空等于用回内置文案", async () => {
    localStorage.setItem("ccweb-wait-label", "少女祈祷");
    resetWaitLabelCache();
    render(<GeneralSettings />);
    const input = screen.getByPlaceholderText("少女祈祷中") as HTMLInputElement;
    expect(input.value).toBe("少女祈祷");

    await act(async () => {
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.blur(input);
    });
    expect(localStorage.getItem("ccweb-wait-label")).toBeNull();
  });
});

// Esc 关抽屉不会派发 blur：只靠 onBlur 落盘会在「打了字按 Esc 关掉」时静默丢掉输入。
describe("计时行文案：关闭抽屉也会落盘", () => {
  it("输入后直接卸载（Esc 关抽屉）也会保存", async () => {
    setWaitLabel("");
    const { unmount } = render(<GeneralSettings />);
    const input = screen.getByLabelText("自定义");
    fireEvent.change(input, { target: { value: "稍等一下下" } });
    unmount();
    expect(waitLabel()).toBe("稍等一下下");
    setWaitLabel("");
  });
});
