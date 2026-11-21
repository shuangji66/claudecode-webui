import { describe, expect, it } from "vitest";
import {
  allModelOptions,
  blankProvider,
  buildProviderPatches,
  findOption,
  formsFromSettings,
  normalizeSettings,
  modelOptionsFromSettings,
  effortApply,
  effortChoices,
  effortFor,
  formatCapacity,
  parseCapacity,
} from "./providerForm";
import type { PublicSettings } from "../transport/types";

const sample: PublicSettings = {
  providers: [
    {
      id: "gw",
      name: "我的网关",
      base_url: "https://gw.example",
      api_key_set: true,
      api_key_masked: "sk-•••1234",
      auth: "bearer",
      models_path: "",
      models: ["cn:deepseek", "cn:qwen"],
    },
  ],
  selected: { provider: "gw", model: "cn:deepseek" },
  permission_mode: "default",
  auto_compact_window: "",
  disable_unknown_model_window: false,
  path: "/tmp/settings.json",
};

describe("formsFromSettings", () => {
  it("回填非密钥字段，密钥留空", () => {
    const [f] = formsFromSettings(sample);
    expect(f.baseUrl).toBe("https://gw.example");
    expect(f.models).toEqual(["cn:deepseek", "cn:qwen"]);
    expect(f.apiKey).toBe("");
    expect(f.auth).toBe("bearer");
  });

  it("null 返回空数组", () => {
    expect(formsFromSettings(null)).toEqual([]);
  });
});

describe("blankProvider", () => {
  it("生成不冲突的前端 key，ID 留空等待手动输入", () => {
    const first = blankProvider([]);
    const second = blankProvider([first]);
    expect(first.id).toBe("");
    expect(second.id).toBe("");
    expect(new Set([first.uid, second.uid]).size).toBe(2);
  });

  it("显示名留空时跟随 ID", () => {
    const f = { ...blankProvider([]), id: "my-relay", name: "" };
    expect(buildProviderPatches([f])[0].name).toBe("my-relay");
  });
});

describe("buildProviderPatches", () => {
  it("空密钥不提交，避免抹掉已存值", () => {
    const [p] = buildProviderPatches([{ ...formsFromSettings(sample)[0], apiKey: "" }]);
    expect(p).not.toHaveProperty("api_key");
  });

  it("填了密钥才提交", () => {
    const f = { ...formsFromSettings(sample)[0], apiKey: "  sk-new  " };
    expect(buildProviderPatches([f])[0].api_key).toBe("sk-new");
  });

  // 自定义中转默认走 x-api-key：官方端点的行为，也是旧版对话注入的优先级。
  it("新建提供商默认 x-api-key 认证", () => {
    expect(blankProvider([]).auth).toBe("x-api-key");
  });

  it("认证方式随表单一起提交", () => {
    const f = { ...formsFromSettings(sample)[0], auth: "x-api-key" as const };
    expect(buildProviderPatches([f])[0].auth).toBe("x-api-key");
  });

  it("clearKey 走 clear_key", () => {
    const f = { ...formsFromSettings(sample)[0], clearKey: true };
    expect(buildProviderPatches([f])[0].clear_key).toBe(true);
  });

  it("模型去空并修剪", () => {
    const f = { ...formsFromSettings(sample)[0], models: [" a ", "", "b"] };
    expect(buildProviderPatches([f])[0].models).toEqual(["a", "b"]);
  });

  it("模型列表为空也提交（允许全部移除）", () => {
    const f = { ...formsFromSettings(sample)[0], models: [] };
    expect(buildProviderPatches([f])[0].models).toEqual([]);
  });
});

describe("allModelOptions", () => {
  it("跨提供商汇总并带显示名", () => {
    const forms = [
      { ...formsFromSettings(sample)[0] },
      { ...blankProvider([]), id: "gw2", name: "备用", models: ["x"] },
    ];
    const opts = allModelOptions(forms);
    expect(opts.map((o) => o.model)).toEqual(["cn:deepseek", "cn:qwen", "x"]);
    expect(findOption(opts, "gw2", "x")?.label).toContain("备用");
    expect(findOption(opts, "gw2", "nope")).toBeUndefined();
  });
});

describe("normalizeSettings", () => {
  // 回归：后端曾把空模型列表序列化成 null，前端 p.models.map 直接白屏。
  it("models 为 null 时归一成空数组", () => {
    const raw = {
      ...sample,
      providers: [{ ...sample.providers[0], models: null as unknown as string[] }],
    };
    const s = normalizeSettings(raw)!;
    expect(s.providers[0].models).toEqual([]);
    expect(() => allModelOptions(formsFromSettings(s))).not.toThrow();
  });

  it("providers 为 null 时归一成空数组", () => {
    const raw = { ...sample, providers: null as unknown as typeof sample.providers };
    expect(normalizeSettings(raw)!.providers).toEqual([]);
  });

  it("selected 缺失时补空", () => {
    const raw = { ...sample, selected: null as unknown as typeof sample.selected };
    expect(normalizeSettings(raw)!.selected).toEqual({ provider: "", model: "" });
  });
});

describe("模型能力元数据", () => {
  const withMeta: PublicSettings = {
    ...sample,
    providers: [
      {
        ...sample.providers[0],
        models: ["m1", "m2"],
        model_meta: {
          m1: { name: "模型一", reasoning_efforts: ["low", "high"], supports_image: true },
          m2: { reasoning_efforts: [] },
        },
      },
    ],
  };

  it("回填并按模型保留元数据", () => {
    const [f] = formsFromSettings(withMeta);
    expect(f.modelMeta.m1.name).toBe("模型一");
    expect(f.modelMeta.m1.supports_image).toBe(true);
    expect(f.modelMeta.m2).toEqual({ name: undefined, reasoning_efforts: [], supports_image: false });
  });

  it("提交补丁带 model_meta，且只保留仍存在的模型", () => {
    const [f] = formsFromSettings(withMeta);
    f.models = ["m1"];
    const [p] = buildProviderPatches([f]);
    expect(p.models).toEqual(["m1"]);
    expect(p.model_meta.m1.name).toBe("模型一");
    expect(p.model_meta.m2).toBeUndefined();
  });

  it("模型选择器使用显示名与元数据", () => {
    const opts = modelOptionsFromSettings(withMeta);
    expect(opts.map((o) => o.label)).toEqual(["模型一 · 我的网关", "m2 · 我的网关"]);
    expect(opts[0].spec.supports_image).toBe(true);
  });

  it("推理等级候选是「默认 + 声明的档位」", () => {
    expect(effortChoices({ reasoning_efforts: ["low", "high"] })).toEqual(["", "low", "high"]);
    // 没有声明档位的模型不该出现推理等级。
    expect(effortChoices({})).toEqual([]);
    expect(effortChoices(undefined)).toEqual([]);
  });

  it("没有有效选择时用「默认」，不声明推理等级", () => {
    const spec = { reasoning_efforts: ["low", "high"] };
    expect(effortFor(spec, "low")).toBe("low");
    expect(effortFor(spec, "")).toBe("");
    expect(effortFor(spec, undefined)).toBe("");
    expect(effortFor(spec, "nope")).toBe("");
    expect(effortFor({ reasoning_efforts: ["low"] }, "high")).toBe("");
    expect(effortFor({}, "high")).toBe("");
  });

  it("切档位后：进行中等这一轮结束、空闲立刻重开、没有进程就什么都不做", () => {
    // 档位没变：不动（进行中也不该白等一次重开）。
    expect(effortApply("ready", "high", "high")).toBe("none");
    expect(effortApply("busy", "high", "high")).toBe("none");
    // 空闲（含「默认」空串）→ 立刻按同一 id 重开。
    expect(effortApply("ready", "high", "low")).toBe("restart");
    expect(effortApply("ready", "high", "")).toBe("restart");
    expect(effortApply("starting", "", "high")).toBe("restart");
    // 进行中不能杀进程。
    expect(effortApply("busy", "high", "low")).toBe("afterTurn");
    // 没有活着的进程：下次打开对话自然按新档位起。
    expect(effortApply("closed", "high", "low")).toBe("none");
    expect(effortApply(undefined, undefined, "low")).toBe("none");
  });

  it("model_meta 为 null 时归一成空对象", () => {
    const raw = {
      ...withMeta,
      providers: [{ ...withMeta.providers[0], model_meta: null as unknown as Record<string, never> }],
    };
    const s = normalizeSettings(raw)!;
    expect(s.providers[0].model_meta).toEqual({ m1: { name: undefined, reasoning_efforts: [], supports_image: false }, m2: { name: undefined, reasoning_efforts: [], supports_image: false } });
  });
});

describe("容量字段", () => {
  it("1M / 256K / 纯数字都能解析，空白表示未声明", () => {
    expect(parseCapacity("1M")).toBe(1_000_000);
    expect(parseCapacity("256K")).toBe(256_000);
    expect(parseCapacity("131072")).toBe(131_072);
    expect(parseCapacity("2.3M")).toBe(2_300_000);
    expect(parseCapacity("  ")).toBeUndefined();
    expect(parseCapacity("128k")).toBe(128_000);
  });

  it("非法写法返回 null，由界面标红而不是写 0", () => {
    expect(parseCapacity("128KB")).toBeNull();
    expect(parseCapacity("-1")).toBeNull();
    expect(parseCapacity("abc")).toBeNull();
  });

  it("格式化成最短 K/M 形式", () => {
    expect(formatCapacity(1_000_000)).toBe("1M");
    expect(formatCapacity(128_000)).toBe("128K");
    expect(formatCapacity(131_072)).toBe("131072");
    expect(formatCapacity(undefined)).toBe("");
  });

  it("保存时只提交正数容量，网关回填的值能往返", () => {
    const f = formsFromSettings(sample)[0];
    const patch = buildProviderPatches([
      {
        ...f,
        models: ["cn:deepseek"],
        modelMeta: {
          "cn:deepseek": { context_window: 1_000_000, max_output_tokens: 128_000, reasoning_efforts: [] },
        },
      },
    ])[0];
    expect(patch.model_meta["cn:deepseek"].context_window).toBe(1_000_000);
    expect(patch.model_meta["cn:deepseek"].max_output_tokens).toBe(128_000);
  });
});
