// 提供商表单 ↔ 接口补丁的转换（纯函数，可单测）。
//
// 安全边界：密钥输入框永远从空开始，只有用户真的敲了内容才提交；
// 清空必须显式走 clearKey，否则「只改模型列表」会把已存密钥抹掉。
//
// 模型能力元数据（显示名 / 推理强度 / 图片）跟 `models` 分开存：
// 模型 ID 列表来自网关，元数据由用户补充，用 model_meta 按 ID 索引。

import type { AuthMethod, ModelSpec, PublicProvider, PublicSettings } from "../transport/types";

/**
 * CLI `--effort` 接受的档位（见 claude --help）。
 *
 * 没有「协议」选项：claude CLI 只会说 Anthropic Messages，请求体、路径与鉴权
 * 都不是可切换的。任何原生 API 不是 Anthropic Messages 的服务，要接进来只能靠
 * 服务商自己提供 Anthropic 兼容端点（`/anthropic` 之类）或用户自架中转——
 * 那个事实写在预设目录的筛选里，不写成一个假装能选的下拉。
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** 「默认」档：不向 API 声明推理等级，也是没有任何显式选择时的取值。 */
export const EFFORT_DEFAULT = "";

export interface ProviderForm {
  /** 仅前端使用的稳定 key：新建时 id 还是空，不能拿 id 当 React key。 */
  uid: string;
  /** 提供商 ID；新建时必须由用户手动输入。 */
  id: string;
  name: string;
  baseUrl: string;
  /** 空串表示「不修改已保存的密钥」。 */
  apiKey: string;
  /** 这把密钥放进哪个请求头（x-api-key / bearer）。 */
  auth: AuthMethod;
  clearKey: boolean;
  modelsPath: string;
  models: string[];
  /** 按模型 ID 的能力元数据。 */
  modelMeta: Record<string, ModelSpec>;
  /** 子代理模型（必须是 models 里的一项）；空串 = 不指定。 */
  subagentModel: string;
  /** 本地标记：是否为尚未保存的新提供商（用于展示「未保存」）。 */
  isNew?: boolean;
}

export interface ProviderPatch {
  id: string;
  name: string;
  base_url: string;
  api_key?: string;
  auth: AuthMethod;
  clear_key?: boolean;
  models_path: string;
  models: string[];
  model_meta: Record<string, ModelSpec>;
  subagent_model: string;
}

/** 只保留正的整数容量；0/负数/脏值按未声明处理。 */
function capacity(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

function specOf(raw: ModelSpec | undefined): ModelSpec {
  const spec = raw ?? {};
  return {
    name: spec.name?.trim() || undefined,
    reasoning_efforts: [...(spec.reasoning_efforts ?? [])],
    supports_image: Boolean(spec.supports_image),
    context_window: capacity(spec.context_window),
    max_output_tokens: capacity(spec.max_output_tokens),
  };
}

/** 容量输入接受的写法：十进制数字，可带 K/M 后缀（1M = 1000K）。 */
const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i;
const CAPACITY_SCALE = { k: 1_000, m: 1_000_000 } as const;

/**
 * 解析容量输入。
 *
 * @returns 空白 → undefined（表示未声明）；无法解析 → null（由界面标红，
 *          不写入配置，避免把 0 当成「无限」传给 CLI）。
 */
export function parseCapacity(text: string): number | undefined | null {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const match = CAPACITY_PATTERN.exec(trimmed);
  if (!match) return null;
  const suffix = match[2]?.toLowerCase();
  const scale = suffix === "k" || suffix === "m" ? CAPACITY_SCALE[suffix] : 1;
  const scaled = Number(match[1]) * scale;
  const rounded = Math.round(scaled);
  // 2.3M 这类写法在二进制浮点里会差几个 ULP，整数意图要回到整数。
  return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled;
}

/** 把 token 数写成最短的 K/M 形式；不是整千的保持原样。 */
export function formatCapacity(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "";
  if (!Number.isInteger(value)) return String(value);
  if (value % CAPACITY_SCALE.m === 0) return `${value / CAPACITY_SCALE.m}M`;
  if (value % CAPACITY_SCALE.k === 0) return `${value / CAPACITY_SCALE.k}K`;
  return String(value);
}

function fromPublic(p: PublicProvider): ProviderForm {
  const meta: Record<string, ModelSpec> = {};
  for (const id of p.models ?? []) meta[id] = specOf(p.model_meta?.[id]);
  return {
    uid: p.id,
    id: p.id,
    name: p.name || "",
    baseUrl: p.base_url ?? "",
    apiKey: "",
    auth: p.auth ?? "x-api-key",
    clearKey: false,
    modelsPath: p.models_path ?? "",
    models: [...(p.models ?? [])],
    modelMeta: meta,
    subagentModel: p.subagent_model ?? "",
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
    locale: s.locale || "zh",
    font_size: s.font_size || 15,
    proxy_url: s.proxy_url || "",
    idle_minutes: s.idle_minutes || 10,
    max_sessions: s.max_sessions || 8,
    subagent_max_concurrent: s.subagent_max_concurrent || 10,
    subagent_spawn_depth: s.subagent_spawn_depth || 1,
    login_ttl_hours: s.login_ttl_hours || 24,
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
  const base = `draft-${existing.length + 1}`;
  let uid = base;
  let n = 1;
  const taken = new Set(existing.map((p) => p.uid));
  while (taken.has(uid)) {
    n += 1;
    uid = `${base}-${n}`;
  }
  return {
    uid,
    id: "",
    name: "",
    baseUrl: "",
    apiKey: "",
    // 自定义中转默认 x-api-key（官方端点的行为）；预置会按各家端点覆盖。
    auth: "x-api-key",
    clearKey: false,
    modelsPath: "",
    models: [],
    modelMeta: {},
    subagentModel: "",
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
      base_url: f.baseUrl.trim(),
      auth: f.auth === "bearer" ? "bearer" : "x-api-key",
      models_path: f.modelsPath.trim(),
      models,
      model_meta,
      // 被删掉的模型不可能再是子代理模型：界面已经在下拉里换过值，
      // 这里再兜一次，免得手改表单或旧草稿送出悬空 ID（后端也会清）。
      subagent_model: models.includes(f.subagentModel) ? f.subagentModel : "",
    };
    const key = f.apiKey.trim();
    if (key) patch.api_key = key;
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

/**
 * 模型可选的推理档位：默认 + 设置里声明的档位（对齐 DSH 的档位列表）。
 *
 * 模型没有声明档位时返回空数组——这时菜单里连「默认」都不该出现，
 * 推理等级对它是没有意义的选项。
 */
export function effortChoices(spec: ModelSpec | undefined): string[] {
  const efforts = spec?.reasoning_efforts ?? [];
  if (efforts.length === 0) return [];
  return [EFFORT_DEFAULT, ...efforts];
}

/** 选中档位归一化：不在候选里的值（含旧配置）一律回落到「默认」，不声明推理等级。 */
export function effortFor(spec: ModelSpec | undefined, selected: string | undefined): string {
  const choices = effortChoices(spec);
  if (choices.length === 0) return "";
  return selected !== undefined && choices.includes(selected) ? selected : EFFORT_DEFAULT;
}

/**
 * 档位的显示名：空串是「默认」（不向 API 声明推理等级），其余首字母大写，
 * `xhigh` 写成可读的 Extra high。
 *
 * 空串返回空串，由调用方补「默认 / Default」——它是界面自己的词，不是设置里的值。
 */
export function effortName(effort: string): string {
  if (!effort) return "";
  if (effort === "xhigh") return "Extra high";
  return effort[0].toUpperCase() + effort.slice(1);
}

/**
 * 切档位后怎么让已在跑的会话生效。
 *
 * claude 的 `--effort` 只在进程启动时固定（控制协议里没有 set_effort），所以只能按
 * 同一 id 重开进程（`--resume` 保住上下文）。**不做「等这一轮结束再重开」**：
 * 那样档位设置是全局的、而重开是延迟的，别的对话也会跟着挂上一条「将在重开会话后
 * 生效」的提示（曾经就是这个症状）。界面在切之前二次确认（重启会中断正在进行的一轮），
 * 确认即重开。
 *
 * "none" = 没有活着的进程，下次打开对话自然按新档位起。
 */
export type EffortApply = "none" | "restart";

export function effortApply(
  state: string | undefined,
  sessionEffort: string | undefined,
  nextEffort: string,
): EffortApply {
  if (!state || state === "closed") return "none";
  if ((sessionEffort ?? "") === (nextEffort ?? "")) return "none";
  return "restart";
}
