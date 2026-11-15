// 提供商表单 ↔ 接口补丁的转换（纯函数，可单测）。
//
// 安全边界：密钥输入框永远从空开始，只有用户真的敲了内容才提交；
// 清空必须显式走 clearKey，否则「只改模型列表」会把已存密钥抹掉。

import type { PublicProvider, PublicSettings } from "../transport/types";

/** 协议选项；与后端 settings 包常量一致。 */
export const PROTOCOLS = [
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "openai-completions", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "google-generative-ai", label: "Gemini API" },
] as const;

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
}

function fromPublic(p: PublicProvider): ProviderForm {
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
  };
}

/**
 * 把后端返回的 settings 归一化。
 *
 * 后端曾经在「提供商没有模型」时序列化出 `"models": null`（append([]string(nil), ...) 的结果），
 * 前端直接 `p.models.map` 会抛 TypeError 导致整页白屏。这里统一兜底：
 * 提供商数组、每个提供商的 models、selected 都强制成安全形状。
 */
export function normalizeSettings(s: PublicSettings | null): PublicSettings | null {
  if (!s) return s;
  const providers = (s.providers as unknown as PublicProvider[] | null | undefined) ?? [];
  return {
    ...s,
    providers: providers.map((p) => ({
      ...p,
      models: (p.models as unknown as string[] | null | undefined) ?? [],
    })),
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
    isNew: true,
  };
}

/** 构造提交补丁。密钥留空不提交；清除只认 clearKey。 */
export function buildProviderPatches(forms: ProviderForm[]): ProviderPatch[] {
  return forms.map((f) => {
    const patch: ProviderPatch = {
      id: f.id.trim(),
      name: f.name.trim() || f.id.trim(),
      protocol: f.protocol,
      base_url: f.baseUrl.trim(),
      models_path: f.modelsPath.trim(),
      models: f.models.map((m) => m.trim()).filter(Boolean),
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
}

export function allModelOptions(forms: ProviderForm[]): ModelOption[] {
  const out: ModelOption[] = [];
  for (const p of forms) {
    for (const m of p.models ?? []) {
      out.push({
        provider: p.id,
        providerName: p.name || p.id,
        model: m,
        label: `${m} · ${p.name || p.id}`,
      });
    }
  }
  return out;
}

/** 按 provider+model 找选项。 */
export function findOption(options: ModelOption[], provider: string, model: string): ModelOption | undefined {
  return options.find((o) => o.provider === provider && o.model === model);
}
