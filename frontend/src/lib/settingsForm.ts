// 设置表单 → 提交补丁的转换（纯函数，可单测）。
//
// 安全边界在这里：密钥输入框永远从空开始，只有用户真的敲了内容才提交；
// 否则「只改模型」的保存会把已存的密钥一起抹掉。

export interface SettingsPatch {
  base_url?: string;
  api_key?: string;
  auth_token?: string;
  clear_api_key?: boolean;
  clear_auth_token?: boolean;
  model?: string;
  opus_model?: string;
  sonnet_model?: string;
  haiku_model?: string;
  permission_mode?: string;
}

export interface SettingsFormState {
  baseUrl: string;
  apiKey: string;
  authToken: string;
  model: string;
  opusModel: string;
  sonnetModel: string;
  haikuModel: string;
  permissionMode: string;
}

export const EMPTY_FORM: SettingsFormState = {
  baseUrl: "",
  apiKey: "",
  authToken: "",
  model: "",
  opusModel: "",
  sonnetModel: "",
  haikuModel: "",
  permissionMode: "",
};

/** 从后端脱敏视图填充表单；密钥字段保持为空。 */
export function formFromPublic(p: {
  base_url?: string;
  model?: string;
  opus_model?: string;
  sonnet_model?: string;
  haiku_model?: string;
  permission_mode?: string;
}): SettingsFormState {
  return {
    ...EMPTY_FORM,
    baseUrl: p.base_url ?? "",
    model: p.model ?? "",
    opusModel: p.opus_model ?? "",
    sonnetModel: p.sonnet_model ?? "",
    haikuModel: p.haiku_model ?? "",
    permissionMode: p.permission_mode ?? "",
  };
}

/** 构造提交补丁。空密钥不提交；显式清除走 clear_* 标志。 */
export function buildPatch(form: SettingsFormState, clear: { apiKey?: boolean; authToken?: boolean } = {}): SettingsPatch {
  const patch: SettingsPatch = {
    base_url: form.baseUrl.trim(),
    model: form.model.trim(),
    opus_model: form.opusModel.trim(),
    sonnet_model: form.sonnetModel.trim(),
    haiku_model: form.haikuModel.trim(),
    permission_mode: form.permissionMode.trim(),
  };
  const apiKey = form.apiKey.trim();
  if (apiKey) patch.api_key = apiKey;
  if (clear.apiKey) patch.clear_api_key = true;

  const authToken = form.authToken.trim();
  if (authToken) patch.auth_token = authToken;
  if (clear.authToken) patch.clear_auth_token = true;

  return patch;
}

/** 表单里该显示什么占位：已设置就显示脱敏值，否则提示未设置。 */
export function secretPlaceholder(set: boolean, masked: string): string {
  if (!set) return "未设置";
  return masked ? `已设置：${masked}（留空则不修改）` : "已设置（留空则不修改）";
}
