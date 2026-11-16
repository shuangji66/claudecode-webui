import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
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

  // 抽屉会顺带挂载其它标签页（技能 / 部署），它们会在挂载时拉数据；
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
    const url = screen.getByPlaceholderText("https://gateway.example/v1");
    expect(url.getAttribute("autocomplete")).toBe("off");
    expect(url.getAttribute("data-1p-ignore")).toBe("true");
    expect(url.getAttribute("data-lpignore")).toBe("true");

    const key = screen.getByPlaceholderText("未设置");
    expect(key.getAttribute("data-1p-ignore")).toBe("true");
    expect(["off", "new-password"]).toContain(key.getAttribute("autocomplete"));
  });
});
