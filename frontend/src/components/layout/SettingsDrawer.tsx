import { useEffect, useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import { getToken, setToken } from "../../lib/runtime";
import {
  PROTOCOLS,
  blankProvider,
  buildProviderPatches,
  formsFromSettings,
  type ProviderForm,
} from "../../lib/providerForm";

const PERMISSION_MODES = ["", "default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];

export function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const info = useAppStore((s) => s.info);
  const settings = useAppStore((s) => s.settings);
  const saving = useAppStore((s) => s.settingsSaving);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const fetchModelsFor = useAppStore((s) => s.fetchModelsFor);
  const verifyModelFor = useAppStore((s) => s.verifyModelFor);
  const probeProvider = useAppStore((s) => s.probeProvider);
  const modelsFor = useAppStore((s) => s.modelsFor);
  const gatewayModels = useAppStore((s) => s.gatewayModels);
  const modelsError = useAppStore((s) => s.modelsError);
  const modelsRaw = useAppStore((s) => s.modelsRaw);
  const modelsAttempts = useAppStore((s) => s.modelsAttempts);
  const verify = useAppStore((s) => s.verify);
  const probe = useAppStore((s) => s.probe);

  const [forms, setForms] = useState<ProviderForm[]>([]);
  const [permissionMode, setPermissionMode] = useState("");
  const [autoCompact, setAutoCompact] = useState("");
  const [disableUnknownWindow, setDisableUnknownWindow] = useState(false);

  const [pickingFor, setPickingFor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [advOpen, setAdvOpen] = useState(false);
  const [token, setTokenDraft] = useState(getToken());
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !settings) return;
    setForms(formsFromSettings(settings));
    setPermissionMode(settings.permission_mode ?? "");
    setAutoCompact(settings.auto_compact_window ?? "");
    setDisableUnknownWindow(settings.disable_unknown_model_window ?? false);
    setPickingFor(null);
    setSavedAt(null);
  }, [open, settings]);

  if (!open) return null;

  const update = (id: string, patch: Partial<ProviderForm>) =>
    setForms((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const onSave = async () => {
    const ok = await saveSettings({
      providers: buildProviderPatches(forms),
      permission_mode: permissionMode,
      auto_compact_window: autoCompact,
      disable_unknown_model_window: disableUnknownWindow,
    });
    if (ok) {
      setSavedAt(Date.now());
      // 密钥已写入后端，清掉本地草稿
      setForms((list) => list.map((p) => ({ ...p, apiKey: "", authToken: "", clearKey: false, isNew: false })));
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

  const filtered = gatewayModels.filter((m) =>
    search.trim() === "" ? true : m.id.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="h-full w-full max-w-lg overflow-y-auto bg-white p-4 shadow-xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="设置"
      >
        <div className="flex items-center gap-2">
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
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">第三方模型</h3>
            <button
              type="button"
              onClick={() => setForms((list) => [...list, blankProvider(list)])}
              className="ml-auto rounded-lg bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200"
            >
              + 添加提供商
            </button>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            每家提供商填自己的协议、地址与密钥，勾选要添加的模型。对话时在聊天页顶部选择用哪个。
          </p>

          {forms.length === 0 && (
            <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-500 dark:bg-slate-800/60">
              还没有提供商。点「+ 添加提供商」开始。
            </p>
          )}

          <div className="mt-3 space-y-3">
            {forms.map((p) => {
              const saved = settings?.providers.find((x) => x.id === p.id);
              const verifying = verify && verify.key.startsWith(`${p.id}/`);
              const probing = probe?.key === p.id;
              return (
                <div key={p.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                  <div className="flex items-center gap-2">
                    <input
                      value={p.name}
                      onChange={(e) => update(p.id, { name: e.target.value })}
                      placeholder="名称"
                      className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                    />
                    <span className="shrink-0 font-mono text-[10px] text-slate-400">{p.id}</span>
                    <button
                      type="button"
                      onClick={() => setForms((list) => list.filter((x) => x.id !== p.id))}
                      className="shrink-0 rounded-lg px-1.5 py-1 text-[11px] text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                      aria-label={`删除 ${p.name}`}
                    >
                      删除
                    </button>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="block text-[11px] text-slate-500">协议</span>
                      <select
                        value={p.protocol}
                        onChange={(e) => update(p.id, { protocol: e.target.value })}
                        className="mt-0.5 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                      >
                        {PROTOCOLS.map((x) => (
                          <option key={x.value} value={x.value}>
                            {x.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="block text-[11px] text-slate-500">模型列表路径（可留空）</span>
                      <input
                        value={p.modelsPath}
                        onChange={(e) => update(p.id, { modelsPath: e.target.value })}
                        placeholder="按协议自动"
                        className="mt-0.5 w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                      />
                    </label>
                  </div>

                  <label className="mt-2 block text-[11px] text-slate-500">API 地址</label>
                  <input
                    value={p.baseUrl}
                    onChange={(e) => update(p.id, { baseUrl: e.target.value })}
                    placeholder="https://gateway.example/v1"
                    className="mt-0.5 w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                  />

                  <label className="mt-2 block text-[11px] text-slate-500">API 密钥</label>
                  <div className="mt-0.5 flex gap-2">
                    <input
                      type="password"
                      value={p.apiKey}
                      onChange={(e) => update(p.id, { apiKey: e.target.value })}
                      placeholder={
                        saved?.api_key_set
                          ? `已设置：${saved.api_key_masked}（留空则不修改）`
                          : "未设置"
                      }
                      className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                    />
                    {saved?.api_key_set && (
                      <button
                        type="button"
                        onClick={() => update(p.id, { clearKey: !p.clearKey })}
                        className={`shrink-0 rounded-lg px-2 py-1 text-[11px] ring-1 ${
                          p.clearKey
                            ? "bg-rose-50 text-rose-700 ring-rose-300 dark:bg-rose-950/50 dark:text-rose-300"
                            : "text-slate-500 ring-slate-300 dark:ring-slate-600"
                        }`}
                      >
                        {p.clearKey ? "将清除" : "清除"}
                      </button>
                    )}
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setPickingFor(pickingFor === p.id ? null : p.id);
                        setPicked(new Set(p.models));
                        setSearch("");
                        void fetchModelsFor(p);
                      }}
                      className="rounded-lg bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200"
                    >
                      获取可用模型
                    </button>
                    <button
                      type="button"
                      onClick={() => void probeProvider(p)}
                      className="rounded-lg px-2 py-1 text-[11px] text-slate-600 ring-1 ring-slate-300 hover:bg-slate-50 dark:text-slate-300 dark:ring-slate-600"
                    >
                      测试连接
                    </button>
                    {saved && (
                      <span className="text-[10px] text-slate-400">已保存 {saved.models.length} 个模型</span>
                    )}
                  </div>

                  {probing && probe && (
                    <p
                      className={`mt-1 text-[11px] ${
                        probe.result.detail === "探测中…"
                          ? "text-slate-400"
                          : probe.result.ok
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-rose-600 dark:text-rose-400"
                      }`}
                    >
                      {probe.result.ok ? "✓ " : "✗ "}
                      {probe.result.detail}
                    </p>
                  )}

                  {pickingFor === p.id && (
                    <div className="mt-2 rounded-lg border border-slate-200 p-2 dark:border-slate-700">
                      <div className="flex items-center gap-2">
                        <input
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder="搜索模型…"
                          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-[11px] dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const merged = [...new Set([...p.models, ...picked])];
                            update(p.id, { models: merged });
                            setPickingFor(null);
                          }}
                          className="shrink-0 rounded-lg bg-blue-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-blue-700"
                        >
                          添加所选
                        </button>
                      </div>

                      {modelsError && (
                        <div className="mt-1 rounded bg-amber-50 px-2 py-1 text-[10px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                          <p>{modelsError}</p>
                          {modelsAttempts.length > 0 && (
                            <ul className="mt-0.5 font-mono opacity-80">
                              {modelsAttempts.map((a) => (
                                <li key={a.path}>
                                  {a.path} → {a.status || "-"} {a.note}
                                </li>
                              ))}
                            </ul>
                          )}
                          {modelsRaw && (
                            <details className="mt-0.5">
                              <summary className="cursor-pointer opacity-70">查看网关返回内容</summary>
                              <pre className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-white/60 p-1 font-mono text-[10px] dark:bg-slate-900/60">
                                {modelsRaw}
                              </pre>
                            </details>
                          )}
                        </div>
                      )}

                      <div className="mt-1 max-h-40 overflow-y-auto">
                        {modelsFor === p.id && filtered.length === 0 && !modelsError && (
                          <p className="px-1 py-1 text-[11px] text-slate-400">没有模型</p>
                        )}
                        {filtered.map((m) => (
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
                      <p className="mt-1 text-[10px] text-slate-400">共 {gatewayModels.length} 个，已勾选 {picked.size} 个</p>
                    </div>
                  )}

                  {p.models.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {p.models.map((m) => (
                        <span
                          key={m}
                          className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                        >
                          {m}
                          <button
                            type="button"
                            onClick={() => update(p.id, { models: p.models.filter((x) => x !== m) })}
                            aria-label={`移除 ${m}`}
                            className="text-slate-400 hover:text-rose-600"
                          >
                            ×
                          </button>
                          <button
                            type="button"
                            onClick={() => void verifyModelFor(p, m)}
                            aria-label={`验证 ${m}`}
                            className="text-slate-400 hover:text-emerald-600"
                          >
                            ✓
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  {verifying && verify && (
                    <p
                      className={`mt-1 text-[10px] ${
                        verify.result.detail === "验证中…"
                          ? "text-slate-400"
                          : verify.result.ok
                            ? "text-emerald-600"
                            : "text-rose-600"
                      }`}
                    >
                      {verify.result.ok ? `✓ 可用（${verify.result.latency_ms}ms）` : `✗ ${verify.result.detail}`}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">默认权限模式</h3>
          <select
            value={permissionMode}
            onChange={(e) => setPermissionMode(e.target.value)}
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
                value={autoCompact}
                onChange={(e) => setAutoCompact(e.target.value)}
                placeholder="例如 200k；留空用 CLI 默认"
                className="w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
              />
              <label className="flex items-start gap-2 text-[11px] text-slate-600 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={disableUnknownWindow}
                  onChange={(e) => setDisableUnknownWindow(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  关闭「未知模型窗口推断」
                  <span className="block text-slate-400">自定义模型名不在 CLI 内置表里时，它默认按 1M token 估算上下文。</span>
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
          {savedAt && <span className="text-[11px] text-emerald-600">已保存</span>}
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          设置对<strong>新建会话</strong>生效；已在运行的 claude 进程环境变量无法更改，
          切换提供商的模型需要新建会话（同提供商内可直接切换）。
        </p>

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
        </p>
      </div>
    </div>
  );
}
