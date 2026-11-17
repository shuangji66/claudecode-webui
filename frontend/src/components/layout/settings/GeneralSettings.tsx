import { NO_AUTOFILL } from "../../../lib/autofill";
import { useState } from "react";
import { useAppStore } from "../../../store/useAppStore";
import { getToken, setToken } from "../../../lib/runtime";
import { useT } from "../../../lib/i18n";
import { permissionLabel } from "../../../lib/labels";
import { setThemePreference, themePreference } from "../../../lib/theme";
import { isDangerousPermissionMode, permissionModeWarning } from "../../../lib/permissionModes";
import { Select } from "../../common/Select";
import { askConfirm } from "../../common/SystemDialogs";
import { IconGlobe, IconMonitor, IconMoon, IconSun, IconType } from "../../common/Icons";
import { Section } from "./Section";

const PERMISSION_MODES = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];
const THEMES = ["light", "dark", "system"] as const;
const LOCALES = ["zh", "en"] as const;

export function GeneralSettings() {
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

  // 主题只存在浏览器：进页面读缓存，切换直接写 DOM + localStorage，不调后端。
  const [theme, setTheme] = useState(themePreference);
  const locale = settings?.locale || "zh";
  const fontSize = settings?.font_size || 15;

  /** 默认权限里的危险模式同样要二次确认：这里保存的是「以后新会话」的默认值。 */
  const changeDefaultMode = async (next: string) => {
    const current = settings?.permission_mode ?? "";
    if (next !== current && isDangerousPermissionMode(next)) {
      const warn = permissionModeWarning(next, locale as "zh" | "en");
      const ok = await askConfirm({
        title: warn.title,
        message: warn.message,
        danger: true,
        confirmText: t("仍然设为默认", "Set as default anyway"),
        cancelText: t("保持当前设置", "Keep current"),
      });
      if (!ok) return;
    }
    await save({ permission_mode: next });
  };

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

      <Section title={t("默认权限", "Default permission")} desc={t("新建会话时使用的权限模式。", "Permission mode for new sessions.")}>
        <Select
          className="max-w-xs"
          ariaLabel={t("默认权限", "Default permission")}
          value={settings?.permission_mode || "default"}
          onChange={(next) => void changeDefaultMode(next)}
          options={PERMISSION_MODES.map((m) => ({
            value: m,
            label: permissionLabel(m, locale as "zh" | "en"),
            danger: isDangerousPermissionMode(m),
          }))}
          menuWidth={200}
        />
      </Section>

      <Section title={t("外观", "Appearance")} desc={t("选择浅色、深色，或跟随系统。", "Choose light, dark, or follow the system.")}>
        <div className="inline-flex rounded-lg border border-line-strong p-0.5">
          {THEMES.map((item) => {
            const active = theme === item;
            const Icon = item === "light" ? IconSun : item === "dark" ? IconMoon : IconMonitor;
            const label = item === "light" ? t("浅色", "Light") : item === "dark" ? t("深色", "Dark") : t("跟随系统", "System");
            return (
              <button
                key={item}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setThemePreference(item);
                  setTheme(item);
                }}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] ${
                  active ? "bg-panel-strong font-medium text-ink" : "text-muted hover:text-ink"
                }`}
              >
                <Icon size={14} />
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
            <input {...NO_AUTOFILL}
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

