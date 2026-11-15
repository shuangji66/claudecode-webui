// 提供商表单 ↔ 接口补丁的转换（纯函数，可单测）。
//
// 安全边界：密钥输入框永远从空开始，只有用户真的敲了内容才提交；
// 清空必须显式走 clearKey，否则「只改模型列表」会把已存密钥抹掉。
//
// 模型能力元数据（显示名 / 推理强度 / 图片）跟 `models` 分开存：
// 模型 ID 列表来自网关，元数据由用户补充，用 model_meta 按 ID 索引。

import type { ModelSpec, PublicProvider, PublicSettings } from "../transport/types";

/** 协议选项；与后端 settings 包常量一致。 */
export const PROTOCOLS = [
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "openai-completions", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "google-generative-ai", label: "Gemini API" },
] as const;

/** CLI `--effort` 接受的档位（见 claude --help）。 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export interface ProviderForm {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  /** 空串表示「不修改已保存的密钥」。 */
  apiKey: string;
  authToken: string;
  clearKey: boolean;
  modelsPath: string;
  models: string[];
  /** 按模型 ID 的能力元数据。 */
  modelMeta: Record<string, ModelSpec>;
  /** 本地标记：是否为尚未保存的新提供商（用于展示「未保存」）。 */
  isNew?: boolean;
}

export interface ProviderPatch {
  id: string;
  name: string;
  protocol: string;
  base_url: string;
  api_key?: string;
  auth_token?: string;
  clear_key?: boolean;
  models_path: string;
  models: string[];
  model_meta: Record<string, ModelSpec>;
}

function specOf(raw: ModelSpec | undefined): ModelSpec {
  const spec = raw ?? {};
  return {
    name: spec.name?.trim() || undefined,
    reasoning_efforts: [...(spec.reasoning_efforts ?? [])],
    default_reasoning_effort: spec.default_reasoning_effort || undefined,
    supports_image: Boolean(spec.supports_image),
  };
}

function fromPublic(p: PublicProvider): ProviderForm {
  const meta: Record<string, ModelSpec> = {};
  for (const id of p.models ?? []) meta[id] = specOf(p.model_meta?.[id]);
  return {
    id: p.id,
    name: p.name || p.id,
    protocol: p.protocol || "anthropic-messages",
    baseUrl: p.base_url ?? "",
    apiKey: "",
    authToken: "",
    clearKey: false,
    modelsPath: p.models_path ?? "",
    models: [...(p.models ?? [])],
    modelMeta: meta,
  };
}

/**
 * 把后端返回的 settings 归一化。
 *
 * 后端曾经在「提供商没有模型」时序列化出 `"models": null`，
 * 前端直接 `p.models.map` 会抛 TypeError 导致整页白屏。这里统一兜底。
 */
export function normalizeSettings(s: PublicSettings | null): PublicSettings | null {
  if (!s) return s;
  const providers = (s.providers as unknown as PublicProvider[] | null | undefined) ?? [];
  return {
    ...s,
    theme: s.theme || "system",
    locale: s.locale || "zh",
    font_size: s.font_size || 15,
    proxy_url: s.proxy_url || "",
    providers: providers.map((p) => {
      const models = ((p.models as unknown as string[] | null | undefined) ?? []).filter(Boolean);
      const rawMeta = (p.model_meta as unknown as Record<string, ModelSpec> | null | undefined) ?? {};
      const model_meta: Record<string, ModelSpec> = {};
      for (const id of models) model_meta[id] = specOf(rawMeta[id]);
      return { ...p, models, model_meta };
    }),
    selected: s.selected ?? { provider: "", model: "" },
  };
}

export function formsFromSettings(s: PublicSettings | null): ProviderForm[] {
  return (s?.providers ?? []).map(fromPublic);
}

/** 新建一个尚未保存的提供商。 */
export function blankProvider(existing: ProviderForm[]): ProviderForm {
  let n = existing.length + 1;
  let id = `provider-${n}`;
  const taken = new Set(existing.map((p) => p.id));
  while (taken.has(id)) {
    n += 1;
    id = `provider-${n}`;
  }
  return {
    id,
    name: id,
    protocol: "anthropic-messages",
    baseUrl: "",
    apiKey: "",
    authToken: "",
    clearKey: false,
    modelsPath: "",
    models: [],
    modelMeta: {},
    isNew: true,
  };
}

/** 构造提交补丁。密钥留空不提交；清除只认 clearKey。 */
export function buildProviderPatches(forms: ProviderForm[]): ProviderPatch[] {
  return forms.map((f) => {
    const models = [...new Set(f.models.map((m) => m.trim()).filter(Boolean))];
    const model_meta: Record<string, ModelSpec> = {};
    for (const id of models) model_meta[id] = specOf(f.modelMeta[id]);
    const patch: ProviderPatch = {
      id: f.id.trim(),
      name: f.name.trim() || f.id.trim(),
      protocol: f.protocol,
      base_url: f.baseUrl.trim(),
      models_path: f.modelsPath.trim(),
      models,
      model_meta,
    };
    const key = f.apiKey.trim();
    if (key) patch.api_key = key;
    const token = f.authToken.trim();
    if (token) patch.auth_token = token;
    if (f.clearKey) patch.clear_key = true;
    return patch;
  });
}

/** 所有已添加模型（跨提供商），供对话页选择。 */
export interface ModelOption {
  provider: string;
  providerName: string;
  model: string;
  label: string;
  spec: ModelSpec;
}

function providerOptions(p: PublicProvider): ModelOption[] {
  return (p.models ?? []).map((m) => {
    const spec = specOf(p.model_meta?.[m]);
    return {
      provider: p.id,
      providerName: p.name || p.id,
      model: m,
      label: `${spec.name || m} · ${p.name || p.id}`,
      spec,
    };
  });
}

/** 从已保存设置构造模型选择器选项。 */
export function modelOptionsFromSettings(s: PublicSettings | null): ModelOption[] {
  return (s?.providers ?? []).flatMap(providerOptions);
}

export function allModelOptions(forms: ProviderForm[]): ModelOption[] {
  const out: ModelOption[] = [];
  for (const p of forms) {
    for (const m of p.models ?? []) {
      const spec = specOf(p.modelMeta[m]);
      out.push({
        provider: p.id,
        providerName: p.name || p.id,
        model: m,
        label: `${spec.name || m} · ${p.name || p.id}`,
        spec,
      });
    }
  }
  return out;
}

/** 按 provider+model 找选项。 */
export function findOption(options: ModelOption[], provider: string, model: string): ModelOption | undefined {
  return options.find((o) => o.provider === provider && o.model === model);
}

/** 选中模型的推理强度：选中的值无效时回落到模型默认值。 */
export function effortFor(spec: ModelSpec | undefined, selected: string | undefined): string {
  const efforts = spec?.reasoning_efforts ?? [];
  if (efforts.length === 0) return "";
  if (selected && efforts.includes(selected)) return selected;
  if (spec?.default_reasoning_effort && efforts.includes(spec.default_reasoning_effort)) {
    return spec.default_reasoning_effort;
  }
  return efforts[0];
}
