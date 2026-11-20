import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS, findProviderPreset, presetFormFields, presetModels, uniqueProviderId } from "./providerCatalog";

describe("provider catalog", () => {
  it("预置 ID 唯一", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // 目录只收 Anthropic Messages 端点：claude CLI 不会改说别的协议，
  // 所以原生 API 是 OpenAI / Gemini / Bedrock 的服务在这里注定用不了。
  it("只收录 Anthropic 兼容端点，且地址已填或明确要求补全", () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.models.length, `${preset.id} 应带模型`).toBeGreaterThan(0);
      if (preset.baseUrl === "") {
        expect(preset.needsBaseUrl, `${preset.id} 地址为空时必须要求补全`).toBe(true);
      } else {
        expect(preset.baseUrl, `${preset.id} 地址应是 http(s)`).toMatch(/^https?:\/\//);
      }
    }
  });

  // 这几个预置的 baseUrl 留空纯属「各家的地址因人而异」，
  // 一旦有人把它们填成原生非 Anthropic 的地址，就是一次注定 404 的配置。
  it("地址留空的预置只说明要补地址，不再暗示不支持对话", () => {
    for (const preset of PROVIDER_PRESETS.filter((p) => p.needsBaseUrl)) {
      expect(preset.note, `${preset.id} 缺少说明`).toBeTruthy();
      expect(preset.note).not.toContain("需要 Anthropic 兼容端点");
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
