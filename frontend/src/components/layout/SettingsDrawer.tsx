import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAppStore } from "../../store/useAppStore";
import { getToken, setToken } from "../../lib/runtime";
import { useT } from "../../lib/i18n";
import { permissionLabel } from "../../lib/labels";
import {
  EFFORT_LEVELS,
  PROTOCOLS,
  blankProvider,
  buildProviderPatches,
  formatCapacity,
  formsFromSettings,
  parseCapacity,
  type ProviderForm,
} from "../../lib/providerForm";
import type { ModelSpec } from "../../transport/types";
import { PROVIDER_PRESETS, findProviderPreset, presetFormFields } from "../../lib/providerCatalog";
import { DeploySettings } from "./DeploySettings";
import { Select } from "../common/Select";
import { Dialog } from "../common/Dialog";
import { askConfirm } from "../common/SystemDialogs";
import {
  IconCheck,
  IconChevronDown,
  IconDownload,
  IconGauge,
  IconGlobe,
  IconImage,
  IconMonitor,
  IconMoon,
  IconPlus,
  IconSearch,
  IconSettings,
  IconShield,
  IconSpark,
  IconSun,
  IconTrash,
  IconType,
} from "../common/Icons";

type Tab = "general" | "models" | "proxy" | "deploy";

const PERMISSION_MODES = ["", "default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];
const THEMES = ["light", "dark", "system"] as const;
const LOCALES = ["zh", "en"] as const;

export function SettingsDrawer({
  open,
  onClose,
  initialTab,
}: {
  open: boolean;
  onClose: () => void;
  /** 从侧栏「有更新」等入口直接落到某一页。 */
  initialTab?: Tab;
}) {
  const t = useT();
  const [tab, setTab] = useState<Tab>(initialTab ?? "general");

  // 每次打开都按入口指定的页签重置：否则上次停在「模型」，
  // 点「有更新」进来还是模型页。
  useEffect(() => {
    if (open) setTab(initialTab ?? "general");
  }, [open, initialTab]);

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label={t("设置", "Settings")}
      title={t("设置", "Settings")}
      size="xl"
      bare
      panelClassName="h-[100dvh] md:h-[82vh] md:max-w-[900px]"
    >
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-2 py-2 md:w-48 md:flex-col md:border-b-0 md:border-r md:px-2.5 md:py-3">
            <NavItem active={tab === "general"} icon={<IconSettings size={16} />} onClick={() => setTab("general")}>
              {t("通用", "General")}
            </NavItem>
            <NavItem active={tab === "models"} icon={<IconSpark size={16} />} onClick={() => setTab("models")}>
              {t("模型", "Models")}
            </NavItem>
            <NavItem active={tab === "proxy"} icon={<IconShield size={16} />} onClick={() => setTab("proxy")}>
              {t("代理", "Proxy")}
            </NavItem>
            <NavItem active={tab === "deploy"} icon={<IconDownload size={16} />} onClick={() => setTab("deploy")}>
              {t("部署", "Deployment")}
            </NavItem>
          </nav>

          <div className="min-h-0 flex-1">
            <div
              className={
                tab === "general"
                  ? "dsh-scroll h-full overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] pt-4 md:px-8 md:pb-8 md:pt-6"
                  : "hidden"
              }
            >
              <GeneralSettings />
            </div>
            <div className={tab === "models" ? "flex h-full min-h-0 flex-col px-4 pt-4 md:px-8 md:pt-6" : "hidden"}>
              <ModelsSettings />
            </div>
            <div
              className={
                tab === "proxy"
                  ? "dsh-scroll h-full overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] pt-4 md:px-8 md:pb-8 md:pt-6"
                  : "hidden"
              }
            >
              <ProxySettings />
            </div>
            <div
              className={
                tab === "deploy"
                  ? "dsh-scroll h-full overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] pt-4 md:px-8 md:pb-8 md:pt-6"
                  : "hidden"
              }
            >
              <DeploySettings />
            </div>
          </div>
        </div>
    </Dialog>
  );
}

function NavItem({ active, icon, onClick, children }: { active: boolean; icon: ReactNode; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-[12.5px] transition ${
        active ? "bg-panel-strong font-medium text-ink" : "text-muted hover:bg-black/5 hover:text-ink"
      }`}
    >
      <span className={active ? "text-brand" : ""}>{icon}</span>
      {children}
    </button>
  );
}

function GeneralSettings() {
  const t = useT();
  const settings = useAppStore((s) => s.settings);
  const info = useAppStore((s) => s.info);
  const saving = useAppStore((s) => s.settingsSaving);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const [token, setTokenDraft] = useState(getToken());
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const save = async (patch: Parameters<typeof saveSettings>[0]) => {
    const ok = await saveSettings(patch);
    if (ok) setSavedAt(Date.now());
  };

  const theme = settings?.theme || "system";
  const locale = settings?.locale || "zh";
  const fontSize = settings?.font_size || 15;

  return (
    <div className="mx-auto max-w-2xl space-y-7">
      <div className="flex items-center gap-2">
        <h3 className="text-[15px] font-semibold text-ink">{t("通用设置", "General")}</h3>
        {(saving || savedAt) && (
          <span className="ml-auto text-[10.5px] text-faint">
            {saving ? t("保存中…", "Saving…") : t("已保存", "Saved")}
          </span>
        )}
      </div>

      <Section title={t("默认权限", "Default permission")} desc={t("新建会话时使用的权限模式。当前会话可用输入框上方的选择器切换。", "Permission mode for new sessions. The current session can be changed from the composer.")}>
        <Select
          className="max-w-xs"
          ariaLabel={t("默认权限", "Default permission")}
          value={settings?.permission_mode ?? ""}
          onChange={(next) => void save({ permission_mode: next })}
          options={PERMISSION_MODES.map((m) => ({ value: m, label: permissionLabel(m, locale as "zh" | "en") }))}
          menuWidth={200}
        />
      </Section>

      <Section title={t("外观", "Appearance")} desc={t("选择浅色、深色，或跟随系统。", "Choose light, dark, or follow the system.")}>
        <div className="grid grid-cols-3 gap-2">
          {THEMES.map((item) => {
            const active = theme === item;
            const Icon = item === "light" ? IconSun : item === "dark" ? IconMoon : IconMonitor;
            const label = item === "light" ? t("浅色", "Light") : item === "dark" ? t("深色", "Dark") : t("跟随系统", "System");
            return (
              <button
                key={item}
                type="button"
                aria-pressed={active}
                onClick={() => void save({ theme: item })}
                className={`flex flex-col items-center justify-center gap-1.5 rounded-xl border px-3 py-4 text-[12px] transition ${
                  active ? "border-brand bg-brand-soft text-brand" : "border-line-strong text-ink-2 hover:bg-panel-strong"
                }`}
              >
                <Icon size={20} />
                {label}
              </button>
            );
          })}
        </div>
      </Section>

      <Section title={t("语言", "Language")} desc={t("切换界面语言；模型与工具输出保持原文。", "Switch the interface language; model and tool output stays as-is.")}>
        <div className="inline-flex rounded-lg border border-line-strong p-0.5">
          {LOCALES.map((item) => {
            const active = locale === item;
            return (
              <button
                key={item}
                type="button"
                aria-pressed={active}
                onClick={() => void save({ locale: item })}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] ${
                  active ? "bg-panel-strong font-medium text-ink" : "text-muted hover:text-ink"
                }`}
              >
                {item === "zh" ? <IconGlobe size={14} /> : <IconGlobe size={14} />}
                {item === "zh" ? "简体中文" : "English"}
              </button>
            );
          })}
        </div>
      </Section>

      <Section title={t("字号", "Font size")} desc={t("仅调整会话内容与输入框的字号。", "Adjusts conversation and composer text only.")}>
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-lg border border-line-strong">
            <button
              type="button"
              onClick={() => void save({ font_size: Math.max(12, fontSize - 1) })}
              disabled={fontSize <= 12}
              className="px-3 py-1.5 text-[14px] text-muted hover:text-ink disabled:opacity-30"
              aria-label={t("减小字号", "Decrease font size")}
            >
              −
            </button>
            <span className="w-14 text-center font-mono text-[12.5px] text-ink">{fontSize}px</span>
            <button
              type="button"
              onClick={() => void save({ font_size: Math.min(20, fontSize + 1) })}
              disabled={fontSize >= 20}
              className="px-3 py-1.5 text-[14px] text-muted hover:text-ink disabled:opacity-30"
              aria-label={t("增大字号", "Increase font size")}
            >
              +
            </button>
          </div>
          <span className="flex items-center gap-1.5 text-[11px] text-faint">
            <IconType size={14} />
            {t("预览", "Preview")}
          </span>
        </div>
        <p className="chat-text mt-3 rounded-lg border border-line bg-panel/60 px-3 py-2 text-ink">
          {t("这是一段会话内容预览。Claude 会在当前工作区读取文件并执行命令。", "This is a preview of conversation text. Claude reads files and runs commands in the current workspace.")}
        </p>
      </Section>

      {info?.auth_required && (
        <Section title={t("访问令牌", "Access token")} desc={t("后端启用了 CCWEB_AUTH_TOKEN。令牌只保存在本浏览器。", "The backend requires CCWEB_AUTH_TOKEN. The token is stored only in this browser.")}>
          <div className="flex gap-2">
            <input
              type="password"
              value={token}
              onChange={(e) => setTokenDraft(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-line-strong bg-canvas px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-brand/60"
              placeholder="CCWEB_AUTH_TOKEN"
            />
            <button
              type="button"
              onClick={() => {
                setToken(token.trim());
                location.reload();
              }}
              className="rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-canvas hover:opacity-90"
            >
              {t("保存并重新加载", "Save and reload")}
            </button>
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="border-b border-line pb-6 last:border-b-0">
      <h4 className="text-[13px] font-medium text-ink">{title}</h4>
      {desc && <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{desc}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function ModelsSettings() {
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
    <div className="flex h-full min-h-0 flex-col">
      <div className="dsh-scroll min-h-0 flex-1 overflow-y-auto pb-4 pr-1">
      <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h3 className="text-[15px] font-semibold text-ink">{t("模型", "Models")}</h3>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
          {t("按协议添加提供商，拉取或手动添加模型；每个模型可以声明推理强度与图片支持。", "Add providers by protocol, fetch or add models manually, and declare reasoning efforts and image support per model.")}
        </p>
      </div>

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

      <div className="shrink-0 border-t border-line bg-canvas pb-[calc(env(safe-area-inset-bottom,0px)+8px)] pt-3">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          {saveError && <span className="text-[10.5px] text-danger">{saveError}</span>}
          <span className="text-[10.5px] text-faint">
            {saving ? t("保存中…", "Saving…") : savedAt ? t("已保存", "Saved") : dirty ? t("有未保存的修改", "Unsaved changes") : null}
          </span>
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={saving}
            className="ml-auto flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-[12px] font-medium text-white hover:bg-brand-hover disabled:opacity-40"
          >
            <IconCheck size={14} />
            {t("保存模型设置", "Save models")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProxySettings() {
  const t = useT();
  const settings = useAppStore((s) => s.settings);
  const sessions = useAppStore((s) => s.sessions);
  const saving = useAppStore((s) => s.settingsSaving);
  const applyProxy = useAppStore((s) => s.applyProxy);
  const [url, setUrl] = useState(settings?.proxy_url ?? "");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setUrl(settings?.proxy_url ?? "");
    setSavedAt(null);
    setLocalError(null);
  }, [settings?.proxy_url]);

  const save = async () => {
    if (sessions.length > 0) {
      const ok = await askConfirm({
        title: t("保存代理设置", "Save proxy settings"),
        message: t(`保存后需要重启 ${sessions.length} 个 claude 会话；对话记录会保留并自动恢复。继续？`, `Saving restarts ${sessions.length} claude session(s); conversations are kept and resumed. Continue?`),
        confirmText: t("继续", "Continue"),
      });
      if (!ok) return;
    }
    setLocalError(null);
    const result = await applyProxy(url.trim());
    if (result.ok) setSavedAt(Date.now());
    else if (result.warning) setLocalError(result.warning);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h3 className="text-[15px] font-semibold text-ink">{t("代理", "Proxy")}</h3>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
          {t("为 claude 子进程设置 HTTP / HTTPS / SOCKS5 代理；留空表示直连。保存后会重启所有正在运行的 claude 会话，对话会用 --resume 恢复。", "Set an HTTP / HTTPS / SOCKS5 proxy for the claude subprocess. Leave blank for direct access. Saving restarts all running claude sessions and resumes them with --resume.")}
        </p>
      </div>

      <Section title={t("代理地址", "Proxy URL")} desc={t("支持 http://、https://、socks5://、socks5h://；可包含用户名密码。", "Supports http://, https://, socks5://, socks5h://; credentials are allowed.")}>
        <input
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setSavedAt(null);
            setLocalError(null);
          }}
          placeholder="socks5://127.0.0.1:1080"
          spellCheck={false}
          className="w-full rounded-lg border border-line-strong bg-canvas px-2.5 py-2 font-mono text-[12px] outline-none placeholder:text-faint focus:border-brand/60"
          aria-label={t("代理地址", "Proxy URL")}
        />
      </Section>

      <div className="flex items-center gap-3">
        {(saving || savedAt) && (
          <span className="text-[10.5px] text-faint">
            {saving ? t("保存并重启中…", "Saving and restarting…") : t("已保存并重启 Claude", "Saved and restarted Claude")}
          </span>
        )}
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-[12px] font-medium text-white hover:bg-brand-hover disabled:opacity-40"
        >
          <IconCheck size={14} />
          {t("保存并重启 Claude", "Save & restart Claude")}
        </button>
      </div>
      {localError && <p className="rounded-lg bg-rose-50 px-3 py-2 text-[11px] text-danger dark:bg-rose-950/30">{localError}</p>}
    </div>
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
  const probing = probe?.key === provider.id;
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
      const current = meta[id] ?? { reasoning_efforts: [], supports_image: false };
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
        protocol: "anthropic-messages",
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
          <input
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
        <input
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
                ...PROVIDER_PRESETS.map((item) => ({
                  value: item.id,
                  label: item.chatCompatible ? item.name : `${item.name} · ${t("需兼容端点", "needs compatible endpoint")}`,
                })),
              ]}
              menuWidth={280}
            />
            {preset?.note && (
              <p className={`mt-1 text-[10px] leading-relaxed ${preset.chatCompatible ? "text-muted" : "text-warn"}`}>{preset.note}</p>
            )}
          </label>
        )}

        <label className="block">
          <span className="block text-[10.5px] text-faint">{t("协议", "Protocol")}</span>
          <Select
            className="mt-0.5 px-2 py-1.5"
            ariaLabel={t("协议", "Protocol")}
            value={provider.protocol}
            onChange={(next) => onChange({ protocol: next })}
            options={PROTOCOLS.map((p) => ({ value: p.value, label: p.label }))}
          />
        </label>

        <label className="block">
          <span className="block text-[10.5px] text-faint">{t("API 地址", "API base URL")}</span>
          <input
            value={provider.baseUrl}
            onChange={(e) => onChange({ baseUrl: e.target.value })}
            placeholder={preset?.needsBaseUrl ? t("填写完整 Base URL（账号 / 区域 / 网关路径）", "Full base URL (account / region / gateway path)") : "https://gateway.example/v1"}
            className="mt-0.5 w-full rounded-lg border border-line-strong bg-canvas px-2 py-1.5 font-mono text-[11.5px] outline-none focus:border-brand/60"
          />
        </label>

        <label className="block">
          <span className="block text-[10.5px] text-faint">{t("API 密钥", "API key")}</span>
          <div className="mt-0.5 flex gap-2">
            <input
              type="password"
              value={provider.apiKey}
              onChange={(e) => onChange({ apiKey: e.target.value })}
              placeholder={saved?.api_key_set ? t(`已设置：${saved.api_key_masked}（留空不修改）`, `Set: ${saved.api_key_masked} (leave blank to keep)`) : t("未设置", "Not set")}
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
            <input
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
              className="rounded-md px-2 py-1 text-[10.5px] text-muted ring-1 ring-line-strong hover:bg-canvas hover:text-ink"
            >
              {probing ? t("测试中…", "Testing…") : t("测试连接", "Test")}
            </button>
          </div>

          {probing && probe && (
            <p className={`mt-1 text-[10.5px] ${probe.result.ok ? "text-ok" : "text-danger"}`}>{probe.result.ok ? "✓ " : "✗ "}{probe.result.detail}</p>
          )}

          {picking && (
            <div className="mt-2 rounded-lg border border-line bg-canvas p-2">
              <div className="flex items-center gap-2">
                <input
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
                    <input
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
            <input
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
    const sorted = [...next].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const def = spec.default_reasoning_effort && sorted.includes(spec.default_reasoning_effort) ? spec.default_reasoning_effort : (sorted[0] ?? "");
    onChange({ reasoning_efforts: sorted, default_reasoning_effort: def });
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
            <input
              value={spec.name ?? ""}
              onChange={(e) => onChange({ name: e.target.value })}
              placeholder={id}
              className="mt-0.5 w-full rounded-md border border-line-strong bg-canvas px-2 py-1 text-[11.5px] outline-none focus:border-brand/60"
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-[10px] text-faint">{t("上下文窗口", "Context window")}</span>
              <input
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
              <input
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
            <input
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
              <label className="mt-1.5 flex items-center gap-1.5 text-[10px] text-faint">
                {t("默认强度", "Default effort")}
                <Select
                  className="w-auto px-1.5 py-0.5 text-[10.5px]"
                  ariaLabel={t("默认强度", "Default effort")}
                  value={spec.default_reasoning_effort ?? ordered[0]}
                  onChange={(next) => onChange({ default_reasoning_effort: next })}
                  options={ordered.map((e) => ({ value: e, label: e }))}
                  menuWidth={110}
                />
              </label>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
