import { NO_AUTOFILL } from "../../../lib/autofill";
import { useEffect, useRef, useState } from "react";
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
import type { AuthMethod, GatewayModel, ModelSpec, ProbeResult } from "../../../transport/types";
import { PROVIDER_PRESETS, findProviderPreset, presetFormFields, presetModels } from "../../../lib/providerCatalog";
import type { ProviderPreset } from "../../../lib/providerCatalog";
import { PageShell } from "../FeaturePage";
import { Button } from "../../common/Button";
import { Select } from "../../common/Select";
import { askConfirm } from "../../common/SystemDialogs";
import { IconAlert, IconCheck, IconChevronDown, IconClock, IconGauge, IconImage, IconPlus, IconSearch, IconTrash } from "../../common/Icons";
import { SETTINGS_PANE_FLEX } from "./SettingsSurface";
import { ModelPickerDialog } from "./ModelPickerDialog";

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
            size="sm"
            onClick={() => void onSave()}
            disabled={saving || !settings}
            icon={<IconCheck size={13} />}
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


/** 本地预置目录 → 弹窗候选（`GatewayModel` 形状）+ 模型元数据种子。 */
interface LocalCandidate {
  models: GatewayModel[];
  seeds: Record<string, Partial<ModelSpec>>;
}

function localCandidateOf(preset: ProviderPreset): LocalCandidate {
  const { modelMeta } = presetModels(preset);
  return {
    models: preset.models.map((m) => ({
      id: m.id,
      display_name: m.name,
      context_length: m.context_window,
      max_output_tokens: m.max_output_tokens,
    })),
    seeds: modelMeta,
  };
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
  const gatewayModels = useAppStore((s) => s.gatewayModels);
  const modelsLoading = useAppStore((s) => s.modelsLoading);
  const modelsError = useAppStore((s) => s.modelsError);
  const modelsRaw = useAppStore((s) => s.modelsRaw);
  const modelsAttempts = useAppStore((s) => s.modelsAttempts);
  const modelsAuthSwitchedTo = useAppStore((s) => s.modelsAuthSwitchedTo);
  const modelsFor = useAppStore((s) => s.modelsFor);
  const verify = useAppStore((s) => s.verify);
  const verifyModelFor = useAppStore((s) => s.verifyModelFor);
  const [picking, setPicking] = useState(false);
  const [manual, setManual] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [presetId, setPresetId] = useState("");
  /**
   * 「获取可用模型」从本地预置目录取的那份候选。非空时弹窗看它、不看网关目录：
   * 没填地址或密钥时端点是问不出东西的（问出来也只会是 401），而预置目录里
   * 正好有这个提供商的模型清单。
   */
  const [localPick, setLocalPick] = useState<LocalCandidate | null>(null);
  /** 探测把认证方式换过去了的提示（保存后生效）。 */
  const [authNotice, setAuthNotice] = useState<AuthMethod | "">("");

  const saved = useAppStore((s) => s.settings?.providers.find((x) => x.id === provider.id));
  // 按表单 uid 匹配（与 store 的 key 一致）：未保存的草稿没有 id，用 id 会让每张
  // 草稿卡片都命中同一次结果。
  const probeKey = provider.uid || provider.id;
  /** 本卡片的验证结果（哪个模型由 key 的后半段区分）。 */
  const verifyMine = verify !== null && verify.key.startsWith(`${probeKey}/`) ? verify : null;
  const verifyFor = (id: string) => (verifyMine?.key === `${probeKey}/${id}` ? verifyMine : null);
  // 拉目录的结果是全局单份（只留最近一次）。`modelsFor` 一旦不是本卡片，就当没有：
  // 否则从 A 的弹窗切到 B 时，B 的弹窗会先摆出 A 的目录。
  const modelsForMe = modelsFor === probeKey;
  // 本地目录优先：它只在「这个提供商有预置、且没填地址或密钥」时被放进来，
  // 那时网关目录根本不会有结果。
  const catalog = localPick !== null ? localPick.models : modelsForMe ? gatewayModels : [];
  const catalogLoading = localPick === null && modelsForMe && modelsLoading;
  const catalogError = localPick !== null ? null : modelsForMe ? modelsError : null;
  const catalogRaw = localPick !== null ? "" : modelsForMe ? modelsRaw : "";
  const catalogAttempts = localPick !== null ? [] : modelsForMe ? modelsAttempts : [];

  // 这张卡片对应的预置：新建时看下拉，编辑已保存的看 ID（预置选择器只出现在新建卡片上）。
  const preset = findProviderPreset(presetId);
  const presetForLocal = preset ?? findProviderPreset(provider.id);
  const hasBase = provider.baseUrl.trim() !== "";
  const hasKey = provider.apiKey.trim() !== "" || saved?.api_key_set === true;
  /**
   * 「获取可用模型」能不能点：自定义中转没填地址就没有可问的端点；预置目录
   * 不依赖地址（那种情况读本地清单）。**密钥不拦**——本机匿名中转合法，
   * 而预置缺密钥时读的是本地清单，不需要端点做任何事。
   */
  const canFetch = hasBase || presetForLocal !== undefined;
  const fetchBlockedReason = canFetch
    ? undefined
    : t("先填 API 地址：没有地址就没有可以询问的端点。", "Fill in the API base URL first; there is no endpoint to ask.");

  /**
   * 探测说「换个头才成功」时，把认证方式写回表单。
   *
   * 对话请求由 CLI 发出、没有换头重试的机会，所以这个结论必须落到配置里：
   * 只在结果里写一句「Bearer 认证」而配置仍是 x-api-key，下一次对话照旧 401。
   */
  const switchedAuth = verifyMine?.result?.auth_switched_to ?? (modelsForMe ? modelsAuthSwitchedTo : "");
  useEffect(() => {
    if (!switchedAuth || switchedAuth === provider.auth) return;
    onChange({ auth: switchedAuth });
    setAuthNotice(switchedAuth);
    // provider.auth / onChange 每次渲染都是新值，这里只在「探测结论」变化时触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switchedAuth]);

  const setSpec = (id: string, patch: Partial<ModelSpec>) => {
    const current = provider.modelMeta[id] ?? {};
    onChange({ modelMeta: { ...provider.modelMeta, [id]: { ...current, ...patch } } });
  };

  /**
   * 「获取可用模型」走哪条路。
   *
   * 缺 API 地址 → 端点点不到；缺密钥（且服务端也没存过）→ 端点只会回 401。
   * 这两种情况下如果这个提供商对得上预置目录，就直接把目录里的清单交给弹窗
   * ——它是同一份 pi-ai catalog，比一次注定失败的请求有用。
   * 对不上预置（用户自建的提供商）仍然去问端点，由后端给出它自己的原因。
   */
  const fetchOrLocal = () => {
    if (!canFetch) return;
    if ((!hasBase || !hasKey) && presetForLocal) {
      setLocalPick(localCandidateOf(presetForLocal));
      setPicking(true);
      return;
    }
    setLocalPick(null);
    setPicking(true);
    void fetchModelsFor(provider);
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

  /** 弹窗确认：把勾选的 id 连同候选给的名称/容量一起写进提供商。 */
  const addPicked = (ids: string[]) => {
    const seeds: Record<string, Partial<ModelSpec>> = {};
    for (const m of catalog) {
      if (!ids.includes(m.id)) continue;
      seeds[m.id] = {
        name: m.display_name,
        context_window: m.context_length,
        max_output_tokens: m.max_output_tokens,
      };
    }
    // 本地预置还带「支不支持图片」——网关列表里没有这个字段，丢了就全按支持处理。
    if (localPick !== null) {
      for (const id of ids) {
        const seed = localPick.seeds[id];
        if (seed !== undefined) seeds[id] = { ...seeds[id], ...seed };
      }
    }
    addModels(ids, seeds);
    setPicking(false);
    setLocalPick(null);
  };

  const applyPreset = (id: string) => {
    setPresetId(id);
    // 换预置等于换端点：上一家开着的本地候选弹窗、以及它的认证方式提示都不再成立。
    setPicking(false);
    setLocalPick(null);
    setAuthNotice("");
    const chosen = findProviderPreset(id);
    if (!chosen) {
      // 从预置切回「自定义」：模板、模型和密钥都要清空，否则会残留上一家的配置。
      onChange({
        id: "",
        name: "",
        baseUrl: "",
        apiKey: "",
        // 切回自定义 = 回到默认（x-api-key），不带着上一家的认证方式走。
        auth: "x-api-key",
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
      clearKey: false,
      modelsPath: "",
      // 预置不预填模型（对齐 DSH：选完提供商再「获取可用模型」逐条挑）。
      // 上一家挑过的模型跟着旧端点一起作废，留着只会在新端点上 404。
      models: [],
      modelMeta: {},
    });
    // Bearer 端点：把高级设置展开，让用户看见认证方式已经被预置选好。
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
          <p className="mt-1 text-[10px] leading-relaxed text-faint">
            {t("密钥只填这一处；它放进哪个请求头由下方「认证方式」决定。", "One key, one field; the auth method below decides which request header carries it.")}
          </p>
        </label>

        <button type="button" onClick={() => setAdvanced((v) => !v)} className="text-[10.5px] text-muted underline-offset-2 hover:text-ink hover:underline">
          {advanced ? t("收起高级设置", "Hide advanced") : t("高级设置（认证方式）", "Advanced (auth method)")}
        </button>
        {advanced && (
          <>
            <div className="block">
              <span className="block text-[10.5px] text-faint">{t("认证方式", "Auth method")}</span>
              <Select
                className="mt-0.5"
                ariaLabel={t("认证方式", "Auth method")}
                value={provider.auth}
                onChange={(v) => {
                  setAuthNotice("");
                  onChange({ auth: v === "bearer" ? "bearer" : "x-api-key" });
                }}
                options={[
                  { value: "x-api-key", label: t("x-api-key 头（ANTHROPIC_API_KEY）", "x-api-key header (ANTHROPIC_API_KEY)") },
                  { value: "bearer", label: t("Authorization: Bearer（ANTHROPIC_AUTH_TOKEN）", "Authorization: Bearer (ANTHROPIC_AUTH_TOKEN)") },
                ]}
                menuWidth={320}
              />
              <p className="mt-1 text-[10px] leading-relaxed text-faint">
                {t(
                  "同一把密钥放进哪个请求头：官方 Anthropic 端点认 x-api-key，多数中转（DeepSeek / Z.AI / Kimi 等）认 Bearer。选错只会 401——对话请求由 CLI 发出，没有换头重试的机会。",
                  "Which header carries the key: the official Anthropic endpoint reads x-api-key, most relays (DeepSeek / Z.AI / Kimi …) read Bearer. A wrong choice is a 401, and the CLI has no chance to retry with the other header.",
                )}
              </p>
            </div>
            <label className="block">
              <span className="block text-[10.5px] text-faint">{t("模型列表路径（可选）", "Model list path (optional)")}</span>
              <input
                {...NO_AUTOFILL}
                value={provider.modelsPath}
                onChange={(e) => onChange({ modelsPath: e.target.value })}
                placeholder="/v1/models"
                className="mt-0.5 w-full rounded-md border border-line-strong bg-canvas px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-brand/60"
              />
              <p className="mt-1 text-[10px] leading-relaxed text-faint">
                {t(
                  "留空就自动试（base 底下 → 主机 /v1/models → 主机 /models，以及少数按主机登记的路径）。填了就只用这一条，先按 API 地址拼、再按主机根拼一次——所以填 /v1/models 在带 /anthropic 的地址上也对。",
                  "Leave empty to auto-try (under the base → host /v1/models → host /models, plus a few registered per-host paths). When set, only that path is used: tried against the API base first, then the host root — so /v1/models also works on bases ending in /anthropic.",
                )}
              </p>
            </label>
          </>
        )}

        <div className="rounded-lg border border-line bg-panel/40 p-2">
          <div className="flex items-center gap-2">
            <span className="text-[10.5px] font-medium text-muted">{t("模型目录", "Model catalog")}</span>
            <button
              type="button"
              onClick={fetchOrLocal}
              disabled={!canFetch}
              title={fetchBlockedReason}
              className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px] font-medium text-brand hover:bg-brand-soft disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <IconSearch size={12} />
              {t("获取可用模型", "Fetch models")}
            </button>
          </div>

          {authNotice !== "" && (
            <p className="mt-1 text-[10.5px] text-warn">
              {t(
                `按实际成功的请求头，认证方式已改成 ${authNotice === "bearer" ? "Bearer" : "x-api-key"}；保存后对话才会用上。`,
                `The endpoint accepted ${authNotice === "bearer" ? "Bearer" : "x-api-key"}; the auth method was switched to it and applies once you save.`,
              )}
            </p>
          )}

          <ModelPickerDialog
            open={picking}
            onClose={() => {
              setPicking(false);
              setLocalPick(null);
            }}
            source={localPick !== null ? "local" : "gateway"}
            providerName={provider.name || provider.id}
            models={catalog}
            selected={provider.models}
            loading={catalogLoading}
            error={catalogError}
            attempts={catalogAttempts}
            raw={catalogRaw}
            onAdd={addPicked}
          />

          <div className="mt-2 space-y-1.5">
            {provider.models.length === 0 && <p className="px-1 py-1 text-[10.5px] text-faint">{t("还没有模型。从上方获取，或在下面手动添加。", "No models yet. Fetch above or add one below.")}</p>}
            {provider.models.map((id) => (
              <ModelRow
                key={id}
                id={id}
                spec={provider.modelMeta[id] ?? {}}
                verify={verifyFor(id)}
                onVerify={() => void verifyModelFor(provider, id)}
                onChange={(patch) => setSpec(id, patch)}
                onRemove={() => {
                  const meta = { ...provider.modelMeta };
                  delete meta[id];
                  onChange({
                    models: provider.models.filter((x) => x !== id),
                    modelMeta: meta,
                    // 删掉的正好是子代理模型时一并清空：留着悬空 ID 只会让 CLI
                    // 派不出子代理，而界面上看不到该改哪一项。
                    ...(provider.subagentModel === id ? { subagentModel: "" } : {}),
                  });
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

          <div className="mt-2.5 border-t border-line pt-2.5">
            <span className="block text-[10.5px] text-faint">{t("子代理模型", "Subagent model")}</span>
            <Select
              className="mt-0.5"
              ariaLabel={t("子代理模型", "Subagent model")}
              value={provider.subagentModel}
              onChange={(v) => onChange({ subagentModel: v })}
              disabled={provider.models.length === 0}
              options={[
                { value: "", label: t("不指定（跟随主对话模型）", "Unset (follow the main model)") },
                ...provider.models.map((id) => ({
                  value: id,
                  label: provider.modelMeta[id]?.name ? `${provider.modelMeta[id].name} · ${id}` : id,
                })),
              ]}
              menuWidth={320}
            />
            <p className="mt-1 text-[10px] leading-relaxed text-faint">
              {t(
                "只影响没有在定义里写死 model 的子代理（.claude/agents/*.md）；内置 Explore / Plan 与 fork 仍用自己的模型。",
                "Affects only subagents whose definition sets no model (.claude/agents/*.md); the built-in Explore / Plan agents and forks keep their own.",
              )}
            </p>
          </div>

        </div>
      </div>}
    </div>
  );
}


function ModelRow({
  id,
  spec,
  verify,
  onVerify,
  onChange,
  onRemove,
}: {
  id: string;
  spec: ModelSpec;
  /** 这个模型的验证结果；别的模型的结论不用显示在这里。 */
  verify: { key: string; pending: boolean; result: ProbeResult | null } | null;
  onVerify: () => void;
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
        <button
          type="button"
          onClick={onVerify}
          disabled={verify?.pending === true}
          aria-label={t("验证模型", "Verify model")}
          title={verify?.pending === true
            ? t("验证中…", "Verifying…")
            : verify?.result
              ? verify.result.detail
              : t("发一次极小的对话请求，验证这个模型真的可用（会计少量费用）", "Send one tiny request to check this model really works (costs a little)")}
          className={`rounded p-1 hover:text-ink disabled:opacity-50 ${verify?.result ? verify.result.ok ? "text-ok" : "text-danger" : "text-muted"}`}
        >
          {verify?.pending === true
            ? <IconClock size={13} />
            : verify?.result && !verify.result.ok
              ? <IconAlert size={13} />
              : <IconCheck size={13} />}
        </button>
        <button type="button" onClick={() => setOpen((v) => !v)} className="rounded p-1 text-muted hover:text-ink" aria-label={t("模型高级设置", "Model settings")}>
          <IconGauge size={13} />
        </button>
        <button type="button" onClick={onRemove} className="rounded p-1 text-muted hover:text-danger" aria-label={t("移除模型", "Remove model")}>
          <IconTrash size={13} />
        </button>
      </div>

      {verify?.pending === true && (
        <p className="border-t border-line px-2.5 py-1.5 text-[10px] text-muted">{t("验证中…", "Verifying…")}</p>
      )}

      {verify?.result && !verify.result.ok && (
        <p className="break-words border-t border-line px-2.5 py-1.5 text-[10px] leading-relaxed text-danger">{verify.result.detail}</p>
      )}

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
