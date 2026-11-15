import { useEffect, useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import { getToken, setToken } from "../../lib/runtime";
import {
  EMPTY_FORM,
  buildPatch,
  formFromPublic,
  mergeModels,
  secretPlaceholder,
  splitModels,
  type SettingsFormState,
} from "../../lib/settingsForm";
import type { GatewayModel } from "../../transport/types";

const PERMISSION_MODES = ["", "default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];

/** 支持的协议；与后端 settings 包常量一致。 */
const PROTOCOLS = [
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "openai-completions", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "google-generative-ai", label: "Gemini API" },
];

/** 内置别名 → 表单字段的映射。CLI 只会请求这些别名，所以要在这里重定向到网关模型。 */
const ALIAS_FIELDS: { alias: string; label: string; key: keyof SettingsFormState; env: string }[] = [
  { alias: "default", label: "默认（不指定时）", key: "model", env: "ANTHROPIC_MODEL" },
  { alias: "opus", label: "opus", key: "opusModel", env: "DEFAULT_OPUS" },
  { alias: "sonnet", label: "sonnet", key: "sonnetModel", env: "DEFAULT_SONNET" },
  { alias: "haiku", label: "haiku", key: "haikuModel", env: "DEFAULT_HAIKU" },
];

export function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const info = useAppStore((s) => s.info);
  const settings = useAppStore((s) => s.settings);
  const saving = useAppStore((s) => s.settingsSaving);
  const probe = useAppStore((s) => s.probe);
  const models = useAppStore((s) => s.gatewayModels);
  const modelsError = useAppStore((s) => s.modelsError);
  const modelsRaw = useAppStore((s) => s.modelsRaw);
  const modelsAttempts = useAppStore((s) => s.modelsAttempts);
  const verify = useAppStore((s) => s.verify);
  const verifyModel = useAppStore((s) => s.verifyModel);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const testConnection = useAppStore((s) => s.testConnection);
  const fetchModels = useAppStore((s) => s.fetchGatewayModels);

  const [form, setForm] = useState<SettingsFormState>(EMPTY_FORM);
  const [clearApiKey, setClearApiKey] = useState(false);
  const [clearAuthToken, setClearAuthToken] = useState(false);
  const [token, setTokenDraft] = useState(getToken());
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [advOpen, setAdvOpen] = useState(false);
  // 「获取可用模型」的多选状态（照 DSH：默认勾选已知/已配置的，其余不勾）
  const [pickerSearch, setPickerSearch] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // 打开时用后端脱敏值回填（密钥字段保持空，避免把占位当值提交）。
  useEffect(() => {
    if (open && settings) {
      setForm(formFromPublic(settings));
      setClearApiKey(false);
      setClearAuthToken(false);
    }
  }, [open, settings]);

  if (!open) return null;

  // 补全候选 = 已知模型 + 本次探测结果
  const knownList = splitModels(form.knownModels);
  const modelOptions = mergeModels(knownList, models.map((m) => m.id));
  const filteredModels = models.filter((m) =>
    pickerSearch.trim() === "" ? true : m.id.toLowerCase().includes(pickerSearch.trim().toLowerCase()),
  );

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
    ["前端产物", info?.frontend ? "已内嵌" : "未内嵌"],
  ];

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="h-full w-full max-w-lg overflow-y-auto bg-white p-4 shadow-xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="设置"
      >
        <div className="flex items-center gap-2">
          {/* 明确的返回入口：用户反馈只有 ✕ 不够直观 */}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-xs font-medium text-blue-700 hover:bg-slate-100 dark:text-blue-300 dark:hover:bg-slate-800"
          >
            ← 返回对话
          </button>
          <h2 className="ml-auto text-sm font-semibold text-slate-700 dark:text-slate-200">设置</h2>
          <button type="button" onClick={onClose} aria-label="关闭设置" className="text-slate-500">
            ✕
          </button>
        </div>

        <section className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">第三方模型接入</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            填 Anthropic Messages 兼容端点（中转 / 私有网关）。留空则走官方地址。
          </p>

          <label className="mt-3 block text-[11px] font-medium text-slate-500">API 地址（ANTHROPIC_BASE_URL）</label>
          <input
            value={form.baseUrl}
            onChange={(e) => set("baseUrl", e.target.value)}
            placeholder="https://api.anthropic.com"
            className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          />

          <label className="mt-3 block text-[11px] font-medium text-slate-500">API 密钥（ANTHROPIC_API_KEY）</label>
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
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">模型映射</h3>
            <button
              type="button"
              onClick={() => fetchModels(form.baseUrl, form.apiKey, form.modelsPath, form.apiProtocol)}
              className="ml-auto rounded-lg bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              获取可用模型
            </button>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            CLI 只会请求内置别名（默认 / opus / sonnet / haiku）。网关没有这些模型时，
            把网关里的模型挂到对应槽位即可——CLI 会被重定向过去。
          </p>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-[11px] font-medium text-slate-500">API 协议</span>
              <select
                value={form.apiProtocol}
                onChange={(e) => set("apiProtocol", e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
              >
                {PROTOCOLS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-[11px] font-medium text-slate-500">模型列表路径（可留空）</span>
              <input
                value={form.modelsPath}
                onChange={(e) => set("modelsPath", e.target.value)}
                placeholder="按协议自动"
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
              />
            </label>
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            协议决定列表地址与鉴权头：Anthropic 用 `/v1/models` + `x-api-key`，
            OpenAI 用 `/models` + `Bearer`，Gemini 用 `/models` + `x-goog-api-key`。
          </p>

          {modelOptions.length > 0 && (
            <datalist id="gateway-models">
              {modelOptions.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
          )}

          {modelsError && (
            <div className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              <p>{modelsError}</p>
              <p className="mt-0.5 opacity-70">
                协议 {form.apiProtocol}
                {settings?.api_key_set ? " · 已携带保存的密钥" : " · 未配置密钥"}
              </p>
              {modelsAttempts.length > 0 && (
                <ul className="mt-1 space-y-0.5 font-mono text-[10px] opacity-80">
                  {modelsAttempts.map((a) => (
                    <li key={a.path}>
                      {a.path} → {a.status || "-"} {a.note}
                    </li>
                  ))}
                </ul>
              )}
              {modelsRaw && (
                <details className="mt-1">
                  <summary className="cursor-pointer opacity-70">查看网关返回内容</summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-white/60 p-1.5 font-mono text-[10px] dark:bg-slate-900/60">
                    {modelsRaw}
                  </pre>
                </details>
              )}
            </div>
          )}

          {/* 可搜索多选框：照 DSH 的「获取可用模型」交互 */}
          {models.length > 0 && (
            <div className="mt-2 rounded-lg border border-slate-200 p-2 dark:border-slate-700">
              <div className="flex items-center gap-2">
                <input
                  value={pickerSearch}
                  onChange={(e) => setPickerSearch(e.target.value)}
                  placeholder="搜索模型…"
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-[11px] dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                />
                <button
                  type="button"
                  onClick={() => {
                    // 勾选的加入已知列表；端点没列出但已配置的保持不变
                    const checked = [...picked];
                    const preserved = knownList.filter((m) => !models.some((x) => x.id === m));
                    set("knownModels", mergeModels(preserved, checked).join("\n"));
                    setPickerSearch("");
                  }}
                  className="shrink-0 rounded-lg bg-blue-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-blue-700"
                >
                  更新列表
                </button>
              </div>
              <div className="mt-1 max-h-40 overflow-y-auto">
                {filteredModels.length === 0 && <p className="px-1 py-1 text-[11px] text-slate-400">没有匹配的模型</p>}
                {filteredModels.map((m: GatewayModel) => (
                  <label key={m.id} className="flex items-center gap-2 px-1 py-0.5 text-[11px]">
                    <input
                      type="checkbox"
                      checked={picked.has(m.id)}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(m.id);
                        else next.delete(m.id);
                        setPicked(next);
                      }}
                    />
                    <span className="font-mono text-slate-700 dark:text-slate-300">{m.id}</span>
                    {m.display_name && m.display_name !== m.id && (
                      <span className="truncate text-slate-400">{m.display_name}</span>
                    )}
                  </label>
                ))}
              </div>
              <p className="mt-1 text-[10px] text-slate-400">
                共 {models.length} 个，已勾选 {picked.size} 个。勾选后点「更新列表」写入补全候选。
              </p>
            </div>
          )}

          <div className="mt-2 space-y-2">
            {ALIAS_FIELDS.map(({ alias, label, key, env }) => (
              <div key={alias}>
                <div className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-[11px] text-slate-500">{label}</span>
                  <input
                    list={modelOptions.length > 0 ? "gateway-models" : undefined}
                    value={String(form[key] ?? "")}
                    onChange={(e) => set(key, e.target.value)}
                    placeholder={env}
                    className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                  />
                  <button
                    type="button"
                    disabled={!String(form[key] ?? "").trim()}
                    onClick={() => verifyModel(String(form[key] ?? ""))}
                    className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-slate-600 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-40 dark:text-slate-300 dark:ring-slate-600"
                  >
                    验证
                  </button>
                  {alias === "default" && (
                    <button
                      type="button"
                      disabled={!form.model.trim()}
                      onClick={() => {
                        const v = form.model;
                        setForm((f) => ({ ...f, opusModel: v, sonnetModel: v, haikuModel: v }));
                      }}
                      className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-slate-600 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-40 dark:text-slate-300 dark:ring-slate-600"
                    >
                      应用全部
                    </button>
                  )}
                </div>
                {verify && verify.model === String(form[key] ?? "") && (
                  <p
                    className={`ml-24 mt-0.5 text-[10px] ${
                      verify.result.detail === "验证中…"
                        ? "text-slate-400"
                        : verify.result.ok
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-rose-600 dark:text-rose-400"
                    }`}
                  >
                    {verify.result.detail === "验证中…"
                      ? "验证中…"
                      : verify.result.ok
                        ? `✓ 可用（${verify.result.latency_ms}ms）`
                        : `✗ ${verify.result.detail}`}
                  </p>
                )}
              </div>
            ))}
          </div>

          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] text-slate-500">手动补充模型名（每行一个）</summary>
            <textarea
              value={form.knownModels}
              onChange={(e) => set("knownModels", e.target.value)}
              rows={3}
              placeholder={"cn:deepseek-v4.1-flash\ncn:qwen-max"}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-[11px] dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            />
          </details>

          <p className="mt-1 text-[11px] text-slate-400">
            `default` 未单独设置时跟随 `opus` 槽位（与 CLI 行为一致）。留空则使用 CLI 内置模型名。
            获取不到列表属正常——手动填写效果相同；「验证」会发一次 max_tokens=1 的真实请求。
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

        <section className="mt-5">
          <button
            type="button"
            onClick={() => setAdvOpen((v) => !v)}
            className="text-xs font-semibold uppercase tracking-wide text-slate-400"
          >
            {advOpen ? "▾" : "▸"} 高级
          </button>
          {advOpen && (
            <div className="mt-2 space-y-2">
              <label className="block text-[11px] font-medium text-slate-500">
                自动压缩窗口（CLAUDE_CODE_AUTO_COMPACT_WINDOW）
              </label>
              <input
                value={form.autoCompactWindow}
                onChange={(e) => set("autoCompactWindow", e.target.value)}
                placeholder="例如 200k；留空用 CLI 默认"
                className="w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
              />
              <label className="flex items-start gap-2 text-[11px] text-slate-600 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={form.disableUnknownModelWindow}
                  onChange={(e) => set("disableUnknownModelWindow", e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  关闭「未知模型窗口推断」
                  <span className="block text-slate-400">
                    自定义模型名不在 CLI 内置表里时，它默认按 1M token 估算上下文。
                  </span>
                </span>
              </label>
            </div>
          )}
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

        <div className="mt-6 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-lg bg-slate-200 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-200"
          >
            ← 返回对话
          </button>
        </div>

        <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
          密钥只保存在数据目录下的配置文件（权限 0600），接口返回时一律脱敏。
          若经公网访问，请务必配置 CCWEB_AUTH_TOKEN 并在网关层再加一层鉴权。
        </p>
      </div>
    </div>
  );
}
