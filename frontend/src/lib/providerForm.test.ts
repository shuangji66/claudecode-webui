import { describe, expect, it } from "vitest";
import {
  allModelOptions,
  blankProvider,
  buildProviderPatches,
  findOption,
  formsFromSettings,
  normalizeSettings,
  modelOptionsFromSettings,
  effortFor,
} from "./providerForm";
import type { PublicSettings } from "../transport/types";

const sample: PublicSettings = {
  providers: [
    {
      id: "gw",
      name: "我的网关",
      protocol: "anthropic-messages",
      base_url: "https://gw.example",
      api_key_set: true,
      api_key_masked: "sk-•••1234",
      auth_token_set: false,
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
    expect(f.authToken).toBe("");
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
    expect(p).not.toHaveProperty("auth_token");
  });

  it("填了密钥才提交", () => {
    const f = { ...formsFromSettings(sample)[0], apiKey: "  sk-new  " };
    expect(buildProviderPatches([f])[0].api_key).toBe("sk-new");
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
          m1: { name: "模型一", reasoning_efforts: ["low", "high"], default_reasoning_effort: "high", supports_image: true },
          m2: { reasoning_efforts: [] },
        },
      },
    ],
  };

  it("回填并按模型保留元数据", () => {
    const [f] = formsFromSettings(withMeta);
    expect(f.modelMeta.m1.name).toBe("模型一");
    expect(f.modelMeta.m1.supports_image).toBe(true);
    expect(f.modelMeta.m2).toEqual({ name: undefined, reasoning_efforts: [], default_reasoning_effort: undefined, supports_image: false });
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

  it("推理强度回落到默认值/第一项", () => {
    const spec = { reasoning_efforts: ["low", "high"], default_reasoning_effort: "high" };
    expect(effortFor(spec, "low")).toBe("low");
    expect(effortFor(spec, "nope")).toBe("high");
    expect(effortFor({ reasoning_efforts: ["low"] }, "")).toBe("low");
    expect(effortFor({}, "high")).toBe("");
  });

  it("model_meta 为 null 时归一成空对象", () => {
    const raw = {
      ...withMeta,
      providers: [{ ...withMeta.providers[0], model_meta: null as unknown as Record<string, never> }],
    };
    const s = normalizeSettings(raw)!;
    expect(s.providers[0].model_meta).toEqual({ m1: { name: undefined, reasoning_efforts: [], default_reasoning_effort: undefined, supports_image: false }, m2: { name: undefined, reasoning_efforts: [], default_reasoning_effort: undefined, supports_image: false } });
  });
});
