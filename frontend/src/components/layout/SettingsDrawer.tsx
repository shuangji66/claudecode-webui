import { useEffect, useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import { getToken, setToken } from "../../lib/runtime";
import {
  EMPTY_FORM,
  buildPatch,
  formFromPublic,
  secretPlaceholder,
  type SettingsFormState,
} from "../../lib/settingsForm";

const PERMISSION_MODES = ["", "default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];

export function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const info = useAppStore((s) => s.info);
  const settings = useAppStore((s) => s.settings);
  const saving = useAppStore((s) => s.settingsSaving);
  const probe = useAppStore((s) => s.probe);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const testConnection = useAppStore((s) => s.testConnection);

  const [form, setForm] = useState<SettingsFormState>(EMPTY_FORM);
  const [clearApiKey, setClearApiKey] = useState(false);
  const [clearAuthToken, setClearAuthToken] = useState(false);
  const [token, setTokenDraft] = useState(getToken());
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // 打开时用后端脱敏值回填（密钥字段保持空，避免把占位当值提交）。
  useEffect(() => {
    if (open && settings) {
      setForm(formFromPublic(settings));
      setClearApiKey(false);
      setClearAuthToken(false);
    }
  }, [open, settings]);

  if (!open) return null;

  const set = <K extends keyof SettingsFormState>(k: K, v: SettingsFormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const onSave = async () => {
    const ok = await saveSettings(buildPatch(form, { apiKey: clearApiKey, authToken: clearAuthToken }));
    if (ok) {
      setSavedAt(Date.now());
      setForm((f) => ({ ...f, apiKey: "", authToken: "" }));
      setClearApiKey(false);
      setClearAuthToken(false);
    }
  };

  const rows: [string, string][] = [
    ["数据目录", info?.data_dir ?? "-"],
    ["claude 家目录", info?.claude_home ?? "-"],
    ["配置文件", settings?.path ?? info?.settings_file ?? "-"],
    ["socket", info?.socket ?? "-"],
    ["baseurl", info?.base_url || "（根路径）"],
    ["claude", `${info?.claude_bin ?? "-"} ${info?.claude_version ?? ""}`.trim()],
    ["版本", info?.version ?? "-"],
    ["会话上限", String(info?.max_sessions ?? "-")],
    ["前端产物", info?.frontend ? "已内嵌" : "缺失"],
  ];

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="h-full w-full max-w-lg overflow-y-auto bg-white p-4 shadow-xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="设置"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">设置</h2>
          <button type="button" onClick={onClose} aria-label="关闭设置">
            ✕
          </button>
        </div>

        <section className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">第三方模型接入</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            以 Anthropic Messages 兼容端点为例：填中转 / 私有网关地址即可，留空则走官方地址。
          </p>

          <label className="mt-3 block text-[11px] font-medium text-slate-500">
            API 地址（ANTHROPIC_BASE_URL）
          </label>
          <input
            value={form.baseUrl}
            onChange={(e) => set("baseUrl", e.target.value)}
            placeholder="https://api.anthropic.com"
            className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          />

          <label className="mt-3 block text-[11px] font-medium text-slate-500">
            API 密钥（ANTHROPIC_API_KEY）
          </label>
          <div className="mt-1 flex gap-2">
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => set("apiKey", e.target.value)}
              placeholder={secretPlaceholder(settings?.api_key_set ?? false, settings?.api_key_masked ?? "")}
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            />
            {settings?.api_key_set && (
              <button
                type="button"
                onClick={() => setClearApiKey((v) => !v)}
                className={`shrink-0 rounded-lg px-2 py-1 text-[11px] ring-1 ${
                  clearApiKey
                    ? "bg-rose-50 text-rose-700 ring-rose-300 dark:bg-rose-950/50 dark:text-rose-300"
                    : "text-slate-500 ring-slate-300 dark:ring-slate-600"
                }`}
              >
                {clearApiKey ? "将清除" : "清除"}
              </button>
            )}
          </div>

          <label className="mt-3 block text-[11px] font-medium text-slate-500">
            Bearer 令牌（ANTHROPIC_AUTH_TOKEN，可留空）
          </label>
          <div className="mt-1 flex gap-2">
            <input
              type="password"
              value={form.authToken}
              onChange={(e) => set("authToken", e.target.value)}
              placeholder={secretPlaceholder(settings?.auth_token_set ?? false, settings?.auth_token_masked ?? "")}
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            />
            {settings?.auth_token_set && (
              <button
                type="button"
                onClick={() => setClearAuthToken((v) => !v)}
                className={`shrink-0 rounded-lg px-2 py-1 text-[11px] ring-1 ${
                  clearAuthToken
                    ? "bg-rose-50 text-rose-700 ring-rose-300 dark:bg-rose-950/50 dark:text-rose-300"
                    : "text-slate-500 ring-slate-300 dark:ring-slate-600"
                }`}
              >
                {clearAuthToken ? "将清除" : "清除"}
              </button>
            )}
          </div>
        </section>

        <section className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">模型</h3>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <ModelField label="默认" value={form.model} onChange={(v) => set("model", v)} env="ANTHROPIC_MODEL" />
            <ModelField label="Opus 别名" value={form.opusModel} onChange={(v) => set("opusModel", v)} env="DEFAULT_OPUS" />
            <ModelField label="Sonnet 别名" value={form.sonnetModel} onChange={(v) => set("sonnetModel", v)} env="DEFAULT_SONNET" />
            <ModelField label="Haiku 别名" value={form.haikuModel} onChange={(v) => set("haikuModel", v)} env="DEFAULT_HAIKU" />
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            留空则由 CLI 使用内置默认；别名用于让 `--model sonnet` 之类解析到中转上的真实模型名。
          </p>
        </section>

        <section className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">默认权限模式</h3>
          <select
            value={form.permissionMode}
            onChange={(e) => set("permissionMode", e.target.value)}
            className="mt-2 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            {PERMISSION_MODES.map((m) => (
              <option key={m || "unset"} value={m}>
                {m || "（不指定，由 CLI 决定）"}
              </option>
            ))}
          </select>
        </section>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            {saving ? "保存中…" : "保存"}
          </button>
          <button
            type="button"
            onClick={testConnection}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 dark:text-slate-300 dark:ring-slate-600"
          >
            测试连接
          </button>
          {savedAt && <span className="text-[11px] text-emerald-600">已保存</span>}
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          设置对<strong>新建会话</strong>生效；已在运行的 claude 进程环境变量无法更改，需关闭后重开。
        </p>

        {probe && (
          <div
            className={`mt-2 rounded-lg px-3 py-2 text-[11px] ${
              probe.ok
                ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                : "bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
            }`}
          >
            <div className="font-medium">
              {probe.ok ? "连接正常" : "连接失败"} · {probe.method} · HTTP {probe.status} · {probe.latency_ms}ms
            </div>
            <div className="mt-0.5 break-all opacity-80">{probe.detail}</div>
          </div>
        )}

        <section className="mt-6">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">运行环境</h3>
          <dl className="mt-2 space-y-1.5 text-[11px]">
            {rows.map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <dt className="w-24 shrink-0 text-slate-400">{k}</dt>
                <dd className="min-w-0 break-all font-mono text-slate-600 dark:text-slate-300">{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        {info?.auth_required && (
          <section className="mt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">访问令牌</h3>
            <input
              value={token}
              onChange={(e) => setTokenDraft(e.target.value)}
              className="mt-2 w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            />
            <button
              type="button"
              onClick={() => {
                setToken(token.trim());
                location.reload();
              }}
              className="mt-2 w-full rounded-lg bg-blue-600 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              保存并重新加载
            </button>
          </section>
        )}

        <p className="mt-6 text-[11px] leading-relaxed text-slate-400">
          密钥只保存在数据目录下的配置文件（权限 0600），接口返回时一律脱敏。
          若经公网访问，请务必配置 CCWEB_AUTH_TOKEN 并在网关层再加一层鉴权。
        </p>
      </div>
    </div>
  );
}

function ModelField({
  label,
  value,
  onChange,
  env,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  env: string;
}) {
  return (
    <label className="block">
      <span className="block text-[11px] font-medium text-slate-500">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={env}
        className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
      />
    </label>
  );
}
