import { NO_AUTOFILL } from "../../../lib/autofill";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../../store/useAppStore";
import { useT } from "../../../lib/i18n";
import {
  EFFORT_LEVELS,
  blankProvider,
  buildProviderPatches,
  formatCapacity,
  formsFromSettings,
  parseCapacity,
  type ProviderForm,
} from "../../../lib/providerForm";
import type { ModelSpec } from "../../../transport/types";
import { PROVIDER_PRESETS, findProviderPreset, presetFormFields } from "../../../lib/providerCatalog";
import { PageShell } from "../FeaturePage";
import { Button } from "../../common/Button";
import { Select } from "../../common/Select";
import { askConfirm } from "../../common/SystemDialogs";
import { IconCheck, IconChevronDown, IconGauge, IconImage, IconPlus, IconSearch, IconTrash } from "../../common/Icons";
import { SETTINGS_PANE_FLEX } from "./SettingsSurface";

/**
 * 「模型」页：侧栏功能区的整页视图（`FeaturePage` 的 `models` 分支懒加载它）。
 *
 * 它自己渲染 `PageShell`：保存是这一页唯一的整体动作，摆在页头右侧（整页视图没有页脚，
 * 钉在屏幕最下方既够不着、又要在正文与按钮之间切一条分隔线）。页面里不要再写标题，
 * 页头已经给了一份。
 */
export function ModelsSettings({
  onClose,
  onOpenSidebar,
}: {
  /** 回到对话（整页视图没有遮罩）。 */
  onClose?: () => void;
  /** 移动端抽屉入口。 */
  onOpenSidebar?: () => void;
} = {}) {
  const t = useT();
  const settings = useAppStore((s) => s.settings);
  const saving = useAppStore((s) => s.settingsSaving);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const [forms, setForms] = useState<ProviderForm[]>(() => formsFromSettings(settings));
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const initialized = useRef(false);

  useEffect(() => {
    // 通用设置（主题/语言/字号）也会更新 settings；此时不能把用户尚未保存的
    // 模型草稿覆盖掉。
    if (dirty) return;
    setForms(formsFromSettings(settings));
  }, [settings, dirty]);

  useEffect(() => {
    if (initialized.current || forms.length === 0) return;
    initialized.current = true;
    // DSH 的模型页：只有一个提供商时默认展开；多个时默认全部折叠。
    setExpanded(forms.length === 1 ? new Set([forms[0].uid]) : new Set());
  }, [forms]);

  const [saveError, setSaveError] = useState<string | null>(null);

  const update = (uid: string, patch: Partial<ProviderForm>) => {
    setForms((list) => list.map((p) => (p.uid === uid ? { ...p, ...patch } : p)));
    setDirty(true);
    setSavedAt(null);
    setSaveError(null);
  };

  const onSave = async () => {
    // settings 为 null 说明 /api/settings 没拉到（bootstrap 里是 .catch(()=>null)）。
    // 此时 forms 是空数组，保存会以「整体替换」语义把服务端所有提供商抹掉。
    if (!settings) {
      setSaveError(t("配置还没加载到，先关掉重开设置页", "Settings have not loaded yet; reopen this panel"));
      return;
    }
    const ids = forms.map((f) => f.id.trim());
    if (ids.some((id) => !id)) {
      setSaveError(t("提供商 ID 不能为空；显示名留空时会自动跟随 ID。", "Provider ID is required; a blank display name follows the ID."));
      return;
    }
    if (new Set(ids).size !== ids.length) {
      setSaveError(t("提供商 ID 不能重复。", "Provider IDs must be unique."));
      return;
    }
    setSaveError(null);
    const ok = await saveSettings({ providers: buildProviderPatches(forms) });
    if (ok) {
      setDirty(false);
      setSavedAt(Date.now());
      // 保存后 forms 会按服务端 ID 重建 uid；单提供商保持展开。
      if (forms.length === 1 && forms[0].id.trim()) setExpanded(new Set([forms[0].id.trim()]));
    }
  };

  return (
    <PageShell
      title={t("模型", "Models")}
      onClose={onClose}
      onOpenSidebar={onOpenSidebar}
      bodyClassName={SETTINGS_PANE_FLEX}
      // 保存是这一页唯一的整体动作，放页头右侧：整页视图没有页脚，钉在屏幕最下方
      // 既够不着，又要在正文与按钮之间切一条分隔线。标题在左侧，这里只留按钮。
      actions={
        <>
          <span className="hidden text-[10.5px] text-faint sm:inline">
            {saving ? t("保存中…", "Saving…") : savedAt ? t("已保存", "Saved") : dirty ? t("有未保存的修改", "Unsaved changes") : null}
          </span>
          <Button
            variant="primary"
            onClick={() => void onSave()}
            disabled={saving || !settings}
            icon={<IconCheck size={14} />}
            aria-label={t("保存", "Save")}
          >
            {t("保存", "Save")}
          </Button>
        </>
      }
    >
      {/* 保存失败的原因留在滚动区外：从页头点「保存」时人可能正滚在很下面，
          跟着正文一起滚走的错误提示等于没提示。 */}
      {saveError && (
        <p className="mx-auto mb-2 w-full max-w-2xl shrink-0 break-words rounded-lg bg-rose-50 px-3 py-2 text-[11px] leading-relaxed text-danger dark:bg-rose-950/30">
          {saveError}
        </p>
      )}
      <div className="dsh-scroll min-h-0 flex-1 overflow-y-auto pr-2 pb-[calc(env(safe-area-inset-bottom,0px)+16px)] md:pb-6">
        <div className="mx-auto max-w-2xl space-y-4">
          <p className="text-[11px] leading-relaxed text-muted">
            {t(
              "添加提供商，拉取或手动添加模型；每个模型可以声明推理强度与图片支持。对话固定走 Anthropic Messages，所以端点必须是 Anthropic 兼容的（官方地址、或各家提供的 /anthropic 路径、或你自己的中转）。",
              "Add providers, then fetch or add models manually; each model can declare reasoning efforts and image support. Chat always uses Anthropic Messages, so the endpoint must be Anthropic-compatible (official, a provider's /anthropic path, or your own relay).",
            )}
          </p>

          {forms.length === 0 && (
            <div className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center">
              <p className="text-[12.5px] font-medium text-ink">{t("还没有提供商", "No providers yet")}</p>
              <p className="mt-1 text-[11px] text-muted">{t("添加一个中继或官方端点开始。", "Add a relay or official endpoint to start.")}</p>
            </div>
          )}

          <div className="space-y-3">
            {forms.map((p) => (
              <ProviderCard
                key={p.uid}
                provider={p}
                existingIds={forms.filter((x) => x.uid !== p.uid).map((x) => x.id.trim()).filter(Boolean)}
                expanded={expanded.has(p.uid)}
                onToggle={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(p.uid)) next.delete(p.uid);
                    else next.add(p.uid);
                    return next;
                  })
                }
                onChange={(patch) => update(p.uid, patch)}
                onRemove={() => {
                  void (async () => {
                    const ok = await askConfirm({
                      title: t("删除提供商", "Delete provider"),
                      message: t(`「${p.name || p.id}」及其模型配置会被移除。`, `"${p.name || p.id}" and its model settings will be removed.`),
                      danger: true,
                      confirmText: t("删除", "Delete"),
                    });
                    if (!ok) return;
                    const next = forms.filter((x) => x.uid !== p.uid);
                    setForms(next);
                    if (next.length === 1) setExpanded(new Set([next[0].uid]));
                    else if (next.length === 0) setExpanded(new Set());
                    setDirty(true);
                    setSavedAt(null);
                  })();
                }}
              />
            ))}
          </div>

          <button
            type="button"
            onClick={() => {
              const draft = blankProvider(forms);
              setForms((list) => [...list, draft]);
              setExpanded(new Set([draft.uid]));
              setDirty(true);
              setSavedAt(null);
              setSaveError(null);
            }}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-strong py-2.5 text-[12px] font-medium text-muted hover:bg-panel-strong hover:text-ink"
          >
            <IconPlus size={14} />
            {t("添加提供商", "Add provider")}
          </button>
        </div>
      </div>
    </PageShell>
  );
}


function ProviderCard({
  provider,
  existingIds,
  expanded,
  onToggle,
  onChange,
  onRemove,
}: {
  provider: ProviderForm;
  /** 其他提供商的 ID，用于给预置生成不冲突的默认 ID。 */
  existingIds: string[];
  expanded: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<ProviderForm>) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const fetchModelsFor = useAppStore((s) => s.fetchModelsFor);
  const probeProvider = useAppStore((s) => s.probeProvider);
  const gatewayModels = useAppStore((s) => s.gatewayModels);
  const modelsError = useAppStore((s) => s.modelsError);
  const modelsRaw = useAppStore((s) => s.modelsRaw);
  const modelsAttempts = useAppStore((s) => s.modelsAttempts);
  const probe = useAppStore((s) => s.probe);
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [manual, setManual] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [presetId, setPresetId] = useState("");

  const saved = useAppStore((s) => s.settings?.providers.find((x) => x.id === provider.id));
  // 按表单 uid 匹配（与 store 的 key 一致）：未保存的草稿没有 id，用 id 会让每张
  // 草稿卡片都命中同一次结果。`pending` 才是「在跑」，不能只看 key——响应回来之后
  // key 仍然相等，按钮会永远停在「测试中…」。
  const probeKey = provider.uid || provider.id;
  const probing = probe?.key === probeKey && probe.pending;
  const probeResult = probe?.key === probeKey ? probe.result : null;
  const filtered = useMemo(
    () => gatewayModels.filter((m) => (search.trim() ? m.id.toLowerCase().includes(search.trim().toLowerCase()) : true)),
    [gatewayModels, search],
  );

  const setSpec = (id: string, patch: Partial<ModelSpec>) => {
    const current = provider.modelMeta[id] ?? {};
    onChange({ modelMeta: { ...provider.modelMeta, [id]: { ...current, ...patch } } });
  };

  const addModels = (ids: string[], seeds?: Record<string, Partial<ModelSpec>>) => {
    const merged = [...new Set([...provider.models, ...ids])];
    const meta = { ...provider.modelMeta };
    for (const id of ids) {
      const seed = seeds?.[id];
      // 现在不支持图片的模型已经很少了，手动加的模型默认按支持图片处理；
      // 网关给了明确值时以网关为准，用户已勾选过的值不被覆盖。
      const current = meta[id] ?? { reasoning_efforts: [], supports_image: seed?.supports_image ?? true };
      // 网关给了容量就预填，但用户已手填的值优先。
      meta[id] = {
        ...current,
        name: current.name || seed?.name,
        context_window: current.context_window ?? seed?.context_window,
        max_output_tokens: current.max_output_tokens ?? seed?.max_output_tokens,
      };
    }
    onChange({ models: merged, modelMeta: meta });
  };

  const addManual = () => {
    const id = manual.trim();
    if (!id) return;
    addModels([id]);
    setManual("");
  };

  const preset = findProviderPreset(presetId);

  const applyPreset = (id: string) => {
    setPresetId(id);
    const chosen = findProviderPreset(id);
    if (!chosen) {
      // 从预置切回「自定义」：模板、模型和密钥都要清空，否则会残留上一家的配置。
      onChange({
        id: "",
        name: "",
        baseUrl: "",
        apiKey: "",
        authToken: "",
        clearKey: false,
        modelsPath: "",
        models: [],
        modelMeta: {},
      });
      return;
    }
    onChange({
      ...presetFormFields(chosen, existingIds),
      // 换预置就换端点，旧的密钥不应继续挂在新提供商上。
      apiKey: "",
      authToken: "",
      clearKey: false,
      modelsPath: "",
    });
    // Bearer 端点必须填到「高级设置」里的令牌字段，直接展开给用户看。
    if (chosen.auth === "bearer") setAdvanced(true);
  };

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-canvas">
      <div className="flex items-center gap-2 border-b border-line bg-panel/50 px-3 py-2.5">
        {provider.isNew ? (
          <input {...NO_AUTOFILL}
            value={provider.id}
            onChange={(e) => onChange({ id: e.target.value })}
            placeholder={t("提供商 ID", "Provider ID")}
            aria-label={t("提供商 ID", "Provider ID")}
            className="w-28 shrink-0 rounded-md border border-line-strong bg-canvas px-1.5 py-0.5 font-mono text-[10.5px] text-ink outline-none focus:border-brand/60"
          />
        ) : (
          <span className="max-w-[8rem] shrink-0 truncate rounded bg-panel-strong px-1.5 py-0.5 font-mono text-[10px] text-muted" title={provider.id}>
            {provider.id}
          </span>
        )}
        <input {...NO_AUTOFILL}
          value={provider.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={provider.id || t("显示名（留空跟随 ID）", "Display name (blank follows ID)")}
          aria-label={t("显示名", "Display name")}
          className="min-w-0 flex-1 bg-transparent text-[13px] font-semibold text-ink outline-none placeholder:font-normal placeholder:text-faint"
        />
        <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] text-muted">
          {provider.models.length} {t("个模型", "models")}
        </span>
        <button type="button" onClick={onToggle} className="rounded-md p-1.5 text-muted hover:bg-black/5 hover:text-ink" aria-label={expanded ? t("收起提供商", "Collapse provider") : t("展开提供商", "Expand provider")} aria-expanded={expanded}>
          <IconChevronDown size={14} className={expanded ? "rotate-180 transition-transform" : "transition-transform"} />
        </button>
        <button type="button" onClick={onRemove} className="rounded-md p-1.5 text-muted hover:bg-black/5 hover:text-danger" aria-label={t("删除提供商", "Delete provider")}>
          <IconTrash size={14} />
        </button>
      </div>

      {expanded && <div className="space-y-2.5 px-3 py-3">
        {provider.isNew && (
          <label className="block">
            <span className="block text-[10.5px] text-faint">{t("预置提供商", "Provider preset")}</span>
            <Select
              className="mt-0.5"
              ariaLabel={t("预置提供商", "Provider preset")}
              value={presetId}
              onChange={applyPreset}
              options={[
                { value: "", label: t("自定义（手动填写）", "Custom (fill manually)") },
                ...PROVIDER_PRESETS.map((item) => ({ value: item.id, label: item.name })),
              ]}
              menuWidth={280}
            />
            {preset?.note && (
              <p className={`mt-1 text-[10px] leading-relaxed ${preset.needsBaseUrl ? "text-warn" : "text-muted"}`}>{preset.note}</p>
            )}
          </label>
        )}

        <label className="block">
          <span className="block text-[10.5px] text-faint">{t("API 地址", "API base URL")}</span>
          <input {...NO_AUTOFILL}
            value={provider.baseUrl}
            onChange={(e) => onChange({ baseUrl: e.target.value })}
            placeholder={preset?.needsBaseUrl ? t("填写完整 Base URL（账号 / 区域 / 网关路径）", "Full base URL (account / region / gateway path)") : "https://api.deepseek.com/anthropic"}
            className="mt-0.5 w-full rounded-lg border border-line-strong bg-canvas px-2 py-1.5 font-mono text-[11.5px] outline-none focus:border-brand/60"
          />
          <p className="mt-1 text-[10px] leading-relaxed text-faint">
            {t("必须是 Anthropic 兼容端点；填不填结尾的 /v1 都可以。", "Must be an Anthropic-compatible endpoint; the trailing /v1 is optional.")}
          </p>
        </label>

        <label className="block">
          <span className="block text-[10.5px] text-faint">{t("API 密钥", "API key")}</span>
          <div className="mt-0.5 flex gap-2">
            <input {...NO_AUTOFILL}
              type="password"
              value={provider.apiKey}
              onChange={(e) => onChange({ apiKey: e.target.value })}
              placeholder={saved?.api_key_set ? t("已设置（留空不修改）", "Set (leave blank to keep)") : t("未设置", "Not set")}
              className="min-w-0 flex-1 rounded-lg border border-line-strong bg-canvas px-2 py-1.5 font-mono text-[11.5px] outline-none focus:border-brand/60"
            />
            {saved?.api_key_set && (
              <button
                type="button"
                onClick={() => onChange({ clearKey: !provider.clearKey })}
                className={`shrink-0 rounded-lg px-2 py-1 text-[10.5px] ring-1 ${provider.clearKey ? "bg-rose-50 text-danger ring-rose-300 dark:bg-rose-950/40" : "text-muted ring-line-strong"}`}
              >
                {provider.clearKey ? t("将清除", "Will clear") : t("清除", "Clear")}
              </button>
            )}
          </div>
          {preset?.auth === "bearer" && (
            <p className="mt-1 text-[10px] leading-relaxed text-warn">
              {t("该端点使用 Bearer 认证：密钥请填到下方「Bearer 令牌」，不要填在这里。", "This endpoint uses Bearer auth: put the key in the Bearer token field below, not here.")}
            </p>
          )}
        </label>

        <button type="button" onClick={() => setAdvanced((v) => !v)} className="text-[10.5px] text-muted underline-offset-2 hover:text-ink hover:underline">
          {advanced ? t("收起高级设置", "Hide advanced") : t("高级设置（Bearer 令牌）", "Advanced (Bearer token)")}
        </button>
        {advanced && (
          <label className="block">
            <span className="block text-[10.5px] text-faint">{t("Bearer 令牌（没有 API 密钥时使用）", "Bearer token (when no API key)")}</span>
            <input {...NO_AUTOFILL}
              type="password"
              value={provider.authToken}
              onChange={(e) => onChange({ authToken: e.target.value })}
              placeholder={saved?.auth_token_set ? t("已设置（留空不修改）", "Set (leave blank to keep)") : t("未设置", "Not set")}
              className="mt-0.5 w-full rounded-lg border border-line-strong bg-canvas px-2 py-1.5 font-mono text-[11.5px] outline-none focus:border-brand/60"
            />
          </label>
        )}

        <div className="rounded-lg border border-line bg-panel/40 p-2">
          <div className="flex items-center gap-2">
            <span className="text-[10.5px] font-medium text-muted">{t("模型目录", "Model catalog")}</span>
            <button
              type="button"
              onClick={() => {
                setPicking((v) => !v);
                setPicked(new Set(provider.models));
                setSearch("");
                void fetchModelsFor(provider);
              }}
              className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px] font-medium text-brand hover:bg-brand-soft"
            >
              <IconSearch size={12} />
              {t("获取可用模型", "Fetch models")}
            </button>
            <button
              type="button"
              onClick={() => void probeProvider(provider)}
              disabled={probing}
              className="rounded-md px-2 py-1 text-[10.5px] text-muted ring-1 ring-line-strong hover:bg-canvas hover:text-ink disabled:opacity-60"
            >
              {probing ? t("测试中…", "Testing…") : t("测试连接", "Test")}
            </button>
          </div>

          {probeResult && !probing && (
            <p className={`mt-1 text-[10.5px] ${probeResult.ok ? "text-ok" : "text-danger"}`}>{probeResult.ok ? "✓ " : "✗ "}{probeResult.detail}</p>
          )}

          {picking && (
            <div className="mt-2 rounded-lg border border-line bg-canvas p-2">
              <div className="flex items-center gap-2">
                <input {...NO_AUTOFILL}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("搜索模型…", "Search models…")}
                  className="min-w-0 flex-1 rounded-md border border-line-strong bg-canvas px-2 py-1 text-[11px] outline-none focus:border-brand/60"
                />
                <button
                  type="button"
                  onClick={() => {
                    const seeds: Record<string, Partial<ModelSpec>> = {};
                    for (const m of gatewayModels) {
                      if (!picked.has(m.id)) continue;
                      seeds[m.id] = {
                        name: m.display_name,
                        context_window: m.context_length,
                        max_output_tokens: m.max_output_tokens,
                      };
                    }
                    addModels([...picked], seeds);
                    setPicking(false);
                  }}
                  className="shrink-0 rounded-md bg-brand px-2 py-1 text-[10.5px] font-medium text-white hover:bg-brand-hover"
                >
                  {t("添加所选", "Add selected")}
                </button>
              </div>
              <div className="dsh-scroll mt-1.5 max-h-52 space-y-0.5 overflow-y-auto">
                {filtered.length === 0 && <p className="px-2 py-3 text-center text-[11px] text-muted">{t("没有匹配的模型。", "No matching models.")}</p>}
                {filtered.map((m) => (
                  <label key={m.id} className="flex items-center gap-2 rounded-md px-2 py-1 text-[11.5px] hover:bg-panel-strong">
                    <input {...NO_AUTOFILL}
                      type="checkbox"
                      className="accent-[var(--c-brand)]"
                      checked={picked.has(m.id)}
                      onChange={(e) => {
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(m.id);
                          else next.delete(m.id);
                          return next;
                        });
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-ink">{m.id}</span>
                    {m.context_length ? <span className="shrink-0 text-[10px] text-faint">{formatCapacity(m.context_length)}</span> : null}
                    {m.display_name && <span className="max-w-[40%] truncate text-[10px] text-muted">{m.display_name}</span>}
                  </label>
                ))}
              </div>
              {modelsError && (
                <div className="mt-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[10.5px] text-warn dark:bg-amber-950/20">
                  <p>{modelsError}</p>
                  {modelsAttempts.length > 0 && <p className="mt-0.5 font-mono opacity-80">{modelsAttempts.map((a) => `${a.path} → ${a.status || "-"}`).join(" · ")}</p>}
                  {modelsRaw && <details className="mt-0.5"><summary className="cursor-pointer opacity-70">{t("查看网关返回", "Show response")}</summary><pre className="mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px]">{modelsRaw}</pre></details>}
                </div>
              )}
            </div>
          )}

          <div className="mt-2 space-y-1.5">
            {provider.models.length === 0 && <p className="px-1 py-1 text-[10.5px] text-faint">{t("还没有模型。从上方获取，或在下面手动添加。", "No models yet. Fetch above or add one below.")}</p>}
            {provider.models.map((id) => (
              <ModelRow
                key={id}
                id={id}
                spec={provider.modelMeta[id] ?? {}}
                onChange={(patch) => setSpec(id, patch)}
                onRemove={() => {
                  const meta = { ...provider.modelMeta };
                  delete meta[id];
                  onChange({ models: provider.models.filter((x) => x !== id), modelMeta: meta });
                }}
              />
            ))}
          </div>

          <div className="mt-2 flex gap-2">
            <input {...NO_AUTOFILL}
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addManual();
                }
              }}
              placeholder={t("手动添加模型 ID", "Add model ID manually")}
              className="min-w-0 flex-1 rounded-md border border-line-strong bg-canvas px-2 py-1 font-mono text-[11px] outline-none focus:border-brand/60"
            />
            <button type="button" onClick={addManual} className="rounded-md border border-line-strong px-2 py-1 text-[10.5px] text-ink hover:bg-panel-strong">
              {t("添加", "Add")}
            </button>
          </div>
        </div>
      </div>}
    </div>
  );
}


function ModelRow({
  id,
  spec,
  onChange,
  onRemove,
}: {
  id: string;
  spec: ModelSpec;
  onChange: (patch: Partial<ModelSpec>) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [contextText, setContextText] = useState(() => formatCapacity(spec.context_window));
  const [outputText, setOutputText] = useState(() => formatCapacity(spec.max_output_tokens));
  const [capacityBad, setCapacityBad] = useState({ context: false, output: false });
  const efforts = spec.reasoning_efforts ?? [];

  const editCapacity = (field: "context" | "output", text: string) => {
    if (field === "context") setContextText(text);
    else setOutputText(text);
    const parsed = parseCapacity(text);
    setCapacityBad((prev) => ({ ...prev, [field]: parsed === null }));
    // 非法输入不写入配置：宁可保留上一次的有效值，也不要存成 0。
    if (parsed === null) return;
    onChange(field === "context" ? { context_window: parsed } : { max_output_tokens: parsed });
  };
  const ordered = EFFORT_LEVELS.filter((e) => efforts.includes(e));
  const toggleEffort = (level: string) => {
    const next = efforts.includes(level) ? efforts.filter((e) => e !== level) : [...efforts, level];
    const order = EFFORT_LEVELS as readonly string[];
    onChange({ reasoning_efforts: [...next].sort((a, b) => order.indexOf(a) - order.indexOf(b)) });
  };

  return (
    <div className="rounded-lg border border-line bg-canvas">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open}>
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink">{id}</span>
          {spec.context_window ? <span className="shrink-0 rounded bg-panel-strong px-1.5 py-0.5 text-[9px] text-muted">{formatCapacity(spec.context_window)}</span> : null}
          {spec.supports_image && <span className="shrink-0 rounded bg-brand-soft px-1.5 py-0.5 text-[9px] text-brand">{t("图片", "Image")}</span>}
          {ordered.length > 0 && <span className="shrink-0 rounded bg-panel-strong px-1.5 py-0.5 text-[9px] text-muted">{t(`推理 ${ordered.length} 档`, `${ordered.length} efforts`)}</span>}
        </button>
        <button type="button" onClick={() => setOpen((v) => !v)} className="rounded p-1 text-muted hover:text-ink" aria-label={t("模型高级设置", "Model settings")}>
          <IconGauge size={13} />
        </button>
        <button type="button" onClick={onRemove} className="rounded p-1 text-muted hover:text-danger" aria-label={t("移除模型", "Remove model")}>
          <IconTrash size={13} />
        </button>
      </div>

      {open && (
        <div className="space-y-2.5 border-t border-line px-2.5 py-2.5">
          <label className="block">
            <span className="block text-[10px] text-faint">{t("显示名称", "Display name")}</span>
            <input {...NO_AUTOFILL}
              value={spec.name ?? ""}
              onChange={(e) => onChange({ name: e.target.value })}
              placeholder={id}
              className="mt-0.5 w-full rounded-md border border-line-strong bg-canvas px-2 py-1 text-[11.5px] outline-none focus:border-brand/60"
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-[10px] text-faint">{t("上下文窗口", "Context window")}</span>
              <input {...NO_AUTOFILL}
                value={contextText}
                onChange={(e) => editCapacity("context", e.target.value)}
                onBlur={() => {
                  if (!capacityBad.context) return;
                  setContextText(formatCapacity(spec.context_window));
                  setCapacityBad((prev) => ({ ...prev, context: false }));
                }}
                placeholder="1M"
                inputMode="numeric"
                aria-invalid={capacityBad.context}
                aria-label={t("上下文窗口", "Context window")}
                className={`mt-0.5 w-full rounded-md border bg-canvas px-2 py-1 font-mono text-[11.5px] outline-none focus:border-brand/60 ${capacityBad.context ? "border-danger" : "border-line-strong"}`}
              />
            </label>
            <label className="block">
              <span className="block text-[10px] text-faint">{t("最大输出 token 数", "Max output tokens")}</span>
              <input {...NO_AUTOFILL}
                value={outputText}
                onChange={(e) => editCapacity("output", e.target.value)}
                onBlur={() => {
                  if (!capacityBad.output) return;
                  setOutputText(formatCapacity(spec.max_output_tokens));
                  setCapacityBad((prev) => ({ ...prev, output: false }));
                }}
                placeholder="128K"
                inputMode="numeric"
                aria-invalid={capacityBad.output}
                aria-label={t("最大输出 token 数", "Max output tokens")}
                className={`mt-0.5 w-full rounded-md border bg-canvas px-2 py-1 font-mono text-[11.5px] outline-none focus:border-brand/60 ${capacityBad.output ? "border-danger" : "border-line-strong"}`}
              />
            </label>
          </div>
          <p className="text-[9.5px] leading-relaxed text-faint">
            {t("支持 128K / 1M 写法；留空表示不声明，由 CLI 使用默认窗口。", "Accepts 128K / 1M; leave blank to let the CLI use its default window.")}
          </p>

          <label className="flex items-center gap-2 text-[11px] text-ink-2">
            <input {...NO_AUTOFILL}
              type="checkbox"
              checked={Boolean(spec.supports_image)}
              onChange={(e) => onChange({ supports_image: e.target.checked })}
              className="accent-[var(--c-brand)]"
            />
            <IconImage size={13} className="text-muted" />
            {t("支持图片输入", "Supports image input")}
          </label>

          <div>
            <div className="flex items-center gap-1.5 text-[10px] text-faint">
              <IconGauge size={12} />
              {t("推理强度", "Reasoning efforts")}
              <span className="text-[9px] opacity-70">{t("至少选一个才会在输入框显示", "Shown in composer when at least one is selected")}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {EFFORT_LEVELS.map((level) => {
                const active = efforts.includes(level);
                return (
                  <button
                    key={level}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleEffort(level)}
                    className={`rounded-full border px-2 py-0.5 text-[10px] ${active ? "border-brand bg-brand-soft text-brand" : "border-line-strong text-muted hover:bg-panel-strong"}`}
                  >
                    {level}
                  </button>
                );
              })}
            </div>
            {ordered.length > 0 && (
              <p className="mt-1.5 text-[9.5px] leading-relaxed text-faint">
                {t(
                  "聊天页的档位列表会额外给出「默认」（不向 API 声明推理等级，也是新的默认选择）；切换档位后当前会话会按同一 id 重开，上下文保留。",
                  "The composer also offers Default (declare no reasoning level; also the new default). Changing the level reopens the current session with the same id, keeping its context.",
                )}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
