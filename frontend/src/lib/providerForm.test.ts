import { describe, expect, it } from "vitest";
import {
  allModelOptions,
  blankProvider,
  buildProviderPatches,
  findOption,
  formsFromSettings,
  normalizeSettings,
  type ProviderForm,
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
  it("生成不冲突的 id", () => {
    const existing = [blankProvider([]), blankProvider([{ id: "provider-1" } as ProviderForm])];
    const ids = new Set(existing.map((p) => p.id));
    expect(ids.size).toBe(2);
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
