import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ModelsSettings } from "./ModelsSettings";
import { useAppStore } from "../../../store/useAppStore";

// 模型页是左侧栏功能区的一整页视图（FeaturePage），所以这里直接渲染页面本体。
//
// 凭证类输入框（API 地址 / 密钥）必须在第一帧就带上忽略标记：
// 只靠 MutationObserver 会晚一步，1Password 会先弹出填充浮层。
describe("模型页凭证输入框的自动填充", () => {
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

  // 页面里可能有拉模型列表之类的请求；这里把 fetch 打桩，免得它们的 setState
  // 落在 act 之外。
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("API 地址与 API 密钥都带 data-1p-ignore / autocomplete=off", async () => {
    await act(async () => {
      render(<ModelsSettings />);
    });
    const url = await screen.findByPlaceholderText("https://api.deepseek.com/anthropic");
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
      render(<ModelsSettings />);
    });
    const key = await screen.findByPlaceholderText("已设置（留空不修改）");
    expect(key.getAttribute("placeholder")).not.toContain("sk-gw");
    expect(screen.queryByText(/sk-gw/)).toBeNull();
    expect(screen.queryByDisplayValue(/sk-gw/)).toBeNull();
  });

  it("手动添加的模型默认勾上「支持图片输入」", async () => {
    await act(async () => {
      render(<ModelsSettings />);
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

  // 曾经只看「最近一次探测的 key 是不是本提供商」，响应回来之后 key 仍然相等，
  // 于是按钮永远停在「测试中…」（截图复现过：结果那行已经绿了，按钮还在转）。
  it("测试连接返回后按钮恢复可点，并显示结果", async () => {
    let resolve: (r: Response) => void = () => {};
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/settings/test")) return pending;
        return new Response("{}", { status: 200 });
      }),
    );
    await act(async () => {
      render(<ModelsSettings />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    });
    expect(screen.getByRole("button", { name: "测试中…" })).toBeDisabled();

    await act(async () => {
      resolve(
        new Response(JSON.stringify({ ok: true, endpoint: "http://127.0.0.1:7863", method: "GET", status: 200, latency_ms: 3, detail: "端点可用，返回 9 个模型" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      // 让 probeProvider 的 await 链跑完
      await pending;
    });
    expect(await screen.findByText(/端点可用，返回 9 个模型/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "测试连接" })).not.toBeDisabled();
  });

  // 「获取可用模型」从内联小面板改成弹窗（选择区要拿到整块高度，几十条目录在
  // 卡片里那条 max-h-52 里根本看不清），并用全选/取消全选。
  describe("获取可用模型的弹窗", () => {
    const catalog = () =>
      new Response(
        JSON.stringify({
          models: [
            { id: "cn:hy4std", context_length: 960000, display_name: "Hy4" },
            { id: "cn:hy4flash-free", context_length: 960000, display_name: "Hy4 flash" },
            { id: "global:hy4std", context_length: 960000, display_name: "Hy4" },
          ],
          attempts: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    it("点「获取可用模型」弹出弹窗，全选只作用于筛选结果，确认后只加勾选的", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => (String(input).includes("/api/settings/models") ? catalog() : new Response("{}", { status: 200 }))),
      );
      await act(async () => {
        render(<ModelsSettings />);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /获取可用模型/ }));
      });

      const dialog = await screen.findByRole("dialog", { name: "选择模型" });
      expect(dialog).toBeInTheDocument();
      // 三条都没加过 → 默认全不勾，按钮是「全选」
      const all = screen.getByRole("button", { name: "全选" });
      await act(async () => {
        fireEvent.click(all);
      });
      expect(screen.getByText("已选 3 个")).toBeInTheDocument();

      // 取消全选清空
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "取消全选" }));
      });
      expect(screen.getByText("已选 0 个")).toBeInTheDocument();

      // 搜 "flash" 后全选：只该勾上命中筛选的那一条
      await act(async () => {
        fireEvent.change(screen.getByLabelText("搜索模型"), { target: { value: "flash" } });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "全选" }));
      });
      expect(screen.getByText("已选 1 个")).toBeInTheDocument();

      // 清空搜索后再点全选：这次补齐其余两条
      await act(async () => {
        fireEvent.change(screen.getByLabelText("搜索模型"), { target: { value: "" } });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "全选" }));
      });
      expect(screen.getByText("已选 3 个")).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "添加所选" }));
      });
      // 弹窗关闭，三条都进了提供商的模型列表
      expect(screen.queryByRole("dialog", { name: "选择模型" })).toBeNull();
      for (const id of ["cn:hy4std", "cn:hy4flash-free", "global:hy4std"]) {
        expect(screen.getByText(id)).toBeInTheDocument();
      }
    });

    // 已经在列表里的模型默认勾上：否则「再点一次获取」等于把原有选择清零。
    it("已添加的模型在弹窗里默认勾选", async () => {
      useAppStore.setState({
        settings: {
          providers: [{ id: "gw", name: "网关", base_url: "", models: ["cn:hy4std"], model_meta: {} }],
          selected: { provider: "gw", model: "", effort: "" },
          permission_mode: "default",
          locale: "zh",
          font_size: 15,
        } as never,
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => (String(input).includes("/api/settings/models") ? catalog() : new Response("{}", { status: 200 }))),
      );
      await act(async () => {
        render(<ModelsSettings />);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /获取可用模型/ }));
      });
      expect(await screen.findByRole("dialog", { name: "选择模型" })).toBeInTheDocument();
      expect(screen.getByText("已选 1 个")).toBeInTheDocument();
    });
  });
});