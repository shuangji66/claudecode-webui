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
            base_url: "https://gw.example",
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
          providers: [{ id: "gw", name: "网关", base_url: "https://gw.example", models: ["cn:hy4std"], model_meta: {} }],
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

  // 选预置只该填「这家是谁、端点在哪」：模型留到获取时逐条挑（对齐 DSH）。
  // 以前一选预置就把整份目录灌进表单，几十条里有一堆未必开通、也没人用的模型。
  it("选预置只填端点，不预填模型", async () => {
    await act(async () => {
      render(<ModelsSettings />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "添加提供商" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "预置提供商" }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("option", { name: "Xiaomi" }));
    });

    expect(screen.getByDisplayValue("https://api.xiaomimimo.com/anthropic")).toBeInTheDocument();
    // 模型一条都不该被预填：没有模型行，计数是 0
    expect(screen.queryByText("mimo-v2.6-pro")).toBeNull();
    // 两张卡片（原有的 gw + 新建的 Xiaomi）都是 0 个模型
    expect(screen.getAllByText("0 个模型")).toHaveLength(2);
  });

  // 没填密钥或地址时端点是问不出东西的（只会回 401 / 地址不合法），
  // 这时「获取可用模型」直接用本地预置目录，且不向后端发请求。
  it("缺密钥时从本地预置目录取候选，不请求端点", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => {
      render(<ModelsSettings />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "添加提供商" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "预置提供商" }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("option", { name: "Xiaomi" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /获取可用模型/ }));
    });

    expect(await screen.findByRole("dialog", { name: "选择模型" })).toBeInTheDocument();
    expect(screen.getByText(/本地预置目录/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/api/settings/models"))).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "全选" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "添加所选" }));
    });
    for (const id of ["mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed"]) {
      expect(screen.getByText(id)).toBeInTheDocument();
    }
  });

  // 认证方式跟着预置走：同一把密钥放进哪个头由端点决定，选预置就该预选对。
  it("选预置后认证方式跟着切换", async () => {
    await act(async () => {
      render(<ModelsSettings />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "添加提供商" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "预置提供商" }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("option", { name: "Xiaomi" }));
    });
    // Bearer 预置会自动展开高级设置；没收起时才需要点一下。
    const advanced = screen.queryByRole("button", { name: "高级设置（认证方式）" });
    if (advanced) {
      await act(async () => {
        fireEvent.click(advanced);
      });
    }
    const trigger = screen.getByRole("button", { name: "认证方式" });
    expect(trigger.textContent).toContain("Bearer");
  });

  // 对话请求由 CLI 发出、没有换头重试的机会：验证发现「换个头才成功」必须
  // 写回配置，否则界面上写着条绿字，下一次对话照旧 401。
  it("验证模型提示要换认证方式时，自动改配置并提示保存", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/settings/verify")) {
          return new Response(
            JSON.stringify({
              ok: true,
              endpoint: "https://relay.example",
              method: "POST /v1/messages",
              status: 200,
              latency_ms: 5,
              detail: "模型 deepseek-flash 可用（Bearer 认证）",
              auth_switched_to: "bearer",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );
    await act(async () => {
      render(<ModelsSettings />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "添加提供商" }));
    });
    // 手填一个模型，再点它的验证按钮（对话级验证只认具体模型）。
    const manual = screen.getByPlaceholderText("手动添加模型 ID");
    await act(async () => {
      fireEvent.change(manual, { target: { value: "deepseek-flash" } });
    });
    await act(async () => {
      fireEvent.keyDown(manual, { key: "Enter" });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "验证模型" }));
    });
    expect(await screen.findByText(/认证方式已改成 Bearer/)).toBeTruthy();
    const advanced = screen.queryByRole("button", { name: "高级设置（认证方式）" });
    if (advanced) {
      await act(async () => {
        fireEvent.click(advanced);
      });
    }
    expect(screen.getByRole("button", { name: "认证方式" }).textContent).toContain("Bearer");
  });

  // 自定义中转没有地址就没有可问的端点：获取按钮该禁用。密钥不拦——
  // 本机匿名中转是合法的。
  it("自定义提供商没填地址时禁用获取与测试", async () => {
    await act(async () => {
      render(<ModelsSettings />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "添加提供商" }));
    });
    expect(screen.getByRole("button", { name: /获取可用模型/ })).toBeDisabled();

    // 只填地址、不填密钥：恢复（匿名中转合法）
    const url = screen.getByPlaceholderText("https://api.deepseek.com/anthropic");
    await act(async () => {
      fireEvent.change(url, { target: { value: "https://relay.example" } });
    });
    expect(screen.getByRole("button", { name: /获取可用模型/ })).not.toBeDisabled();
  });

  // 预置端点缺密钥时仍能挑模型：获取走本地预置目录，不需要端点做任何事。
  it("预置缺密钥时获取仍走本地目录", async () => {
    await act(async () => {
      render(<ModelsSettings />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "添加提供商" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "预置提供商" }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("option", { name: "Xiaomi" }));
    });
    expect(screen.getByRole("button", { name: /获取可用模型/ })).not.toBeDisabled();
  });

  // 验证是唯一会真的发对话请求的地方：失败原因必须留在那一行，而不是弹个 toast
  // 就消失——用户要照它去改地址/密钥/认证方式。
  it("验证模型失败时在行内说明原因", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/settings/verify")) {
          return new Response(
            JSON.stringify({
              ok: false,
              endpoint: "https://relay.example",
              method: "POST /v1/messages",
              status: 401,
              latency_ms: 12,
              detail: "模型 v-model 不可用：{\"error\":\"invalid api key\"}",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );
    await act(async () => {
      render(<ModelsSettings />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "添加提供商" }));
    });
    const manual = screen.getByPlaceholderText("手动添加模型 ID");
    await act(async () => {
      fireEvent.change(manual, { target: { value: "v-model" } });
    });
    await act(async () => {
      fireEvent.keyDown(manual, { key: "Enter" });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "验证模型" }));
    });
    expect(await screen.findByText(/模型 v-model 不可用/)).toBeTruthy();
  });
});
