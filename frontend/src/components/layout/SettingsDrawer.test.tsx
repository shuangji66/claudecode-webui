import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SettingsDrawer } from "./SettingsDrawer";
import { useAppStore } from "../../store/useAppStore";

// 凭证类输入框（API 地址 / 密钥）必须在第一帧就带上忽略标记：
// 只靠 MutationObserver 会晚一步，1Password 会先弹出填充浮层。
describe("设置页凭证输入框的自动填充", () => {
  beforeEach(() => {
    useAppStore.setState({
      settings: {
        providers: [
          {
            id: "gw",
            name: "网关",
            protocol: "anthropic-messages",
            base_url: "",
            models: [],
            model_meta: {},
          },
        ],
        selected: { provider: "gw", model: "", effort: "" },
        permission_mode: "default",
        locale: "zh",
        font_size: 15,
      } as never,
      info: null,
      settingsSaving: false,
    });
  });

  // 各页是懒加载的（打开哪页才挂载哪页），进设置页时仍可能有请求；
  // 这里把 fetch 打桩，免得那些请求的 setState 落在 act 之外。
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("API 地址与 API 密钥都带 data-1p-ignore / autocomplete=off", async () => {
    await act(async () => {
      render(<SettingsDrawer open initialTab="models" onClose={() => {}} />);
    });
    const url = await screen.findByPlaceholderText("https://gateway.example/v1");
    expect(url.getAttribute("autocomplete")).toBe("off");
    expect(url.getAttribute("data-1p-ignore")).toBe("true");
    expect(url.getAttribute("data-lpignore")).toBe("true");

    const key = screen.getByPlaceholderText("未设置");
    expect(key.getAttribute("data-1p-ignore")).toBe("true");
    expect(["off", "new-password"]).toContain(key.getAttribute("autocomplete"));
  });

  // 密钥只看「是否已设置」：脱敏串会在截图/录屏里流出密钥的尾巴，同样不该出现。
  it("已保存的 API 密钥只提示「已设置」，不回显脱敏串", async () => {
    useAppStore.setState({
      settings: {
        providers: [
          {
            id: "gw",
            name: "网关",
            protocol: "anthropic-messages",
            base_url: "",
            api_key_set: true,
            api_key_masked: "sk-gw••••••1234",
            models: [],
            model_meta: {},
          },
        ],
        selected: { provider: "gw", model: "", effort: "" },
        permission_mode: "default",
        locale: "zh",
        font_size: 15,
      } as never,
      info: null,
      settingsSaving: false,
    });
    await act(async () => {
      render(<SettingsDrawer open initialTab="models" onClose={() => {}} />);
    });
    const key = await screen.findByPlaceholderText("已设置（留空不修改）");
    expect(key.getAttribute("placeholder")).not.toContain("sk-gw");
    expect(screen.queryByText(/sk-gw/)).toBeNull();
    expect(screen.queryByDisplayValue(/sk-gw/)).toBeNull();
  });

  it("手动添加的模型默认勾上「支持图片输入」", async () => {
    await act(async () => {
      render(<SettingsDrawer open initialTab="models" onClose={() => {}} />);
    });
    const manual = await screen.findByPlaceholderText("手动添加模型 ID");
    await act(async () => {
      fireEvent.change(manual, { target: { value: "my-model" } });
    });
    await act(async () => {
      fireEvent.keyDown(manual, { key: "Enter" });
    });
    // 展开该模型的能力设置
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /my-model/ }));
    });
    expect(screen.getByRole("checkbox", { name: /支持图片输入/ })).toBeChecked();
  });
});
