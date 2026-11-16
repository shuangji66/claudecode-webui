import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS, findProviderPreset, presetFormFields, presetModels, uniqueProviderId } from "./providerCatalog";
import { PROTOCOLS } from "./providerForm";

describe("provider catalog", () => {
  it("预置 ID 唯一，协议都是设置页支持的协议", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const supported = new Set<string>(PROTOCOLS.map((p) => p.value));
    for (const preset of PROVIDER_PRESETS) {
      expect(supported.has(preset.protocol), `${preset.id} 的协议 ${preset.protocol}`).toBe(true);
    }
  });

  it("可对话的预置都有 Anthropic 兼容地址", () => {
    for (const preset of PROVIDER_PRESETS.filter((p) => p.chatCompatible)) {
      expect(preset.protocol).toBe("anthropic-messages");
      expect(preset.baseUrl).not.toBe("");
    }
  });

  it("DeepSeek 预置填 Anthropic 端点与默认模型", () => {
    const preset = findProviderPreset("deepseek");
    expect(preset).toBeTruthy();
    const fields = presetFormFields(preset!, []);
    expect(fields.id).toBe("deepseek");
    expect(fields.baseUrl).toBe("https://api.deepseek.com/anthropic");
    expect(fields.models).toContain("deepseek-flash");
    expect(fields.modelMeta["deepseek-flash"].context_window).toBe(1_000_000);
    expect(fields.modelMeta["deepseek-flash"].supports_image).toBe(true);
  });

  it("预置 ID 冲突时追加序号", () => {
    expect(uniqueProviderId("deepseek", [])).toBe("deepseek");
    expect(uniqueProviderId("deepseek", ["deepseek"])).toBe("deepseek-2");
    expect(uniqueProviderId("deepseek", ["deepseek", "deepseek-2"])).toBe("deepseek-3");
    expect(uniqueProviderId("", ["x"])).toBe("");
  });

  it("模型列表去重", () => {
    const preset = { ...PROVIDER_PRESETS[0], models: [{ id: "a" }, { id: "a" }, { id: "b" }] };
    const { models, modelMeta } = presetModels(preset);
    expect(models).toEqual(["a", "b"]);
    expect(modelMeta.a.reasoning_efforts).toEqual([]);
  });
});
