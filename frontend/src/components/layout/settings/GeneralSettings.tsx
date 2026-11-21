import { NO_AUTOFILL } from "../../../lib/autofill";
import { useState } from "react";
import { useAppStore } from "../../../store/useAppStore";
import { getToken, setToken } from "../../../lib/runtime";
import { useT } from "../../../lib/i18n";
import { permissionLabel } from "../../../lib/labels";
import { setThemePreference, themePreference } from "../../../lib/theme";
import {
  COLLAPSE_TIMINGS,
  FOLDED_REPLIES,
  PROCESS_VIEWS,
  setCollapseTiming,
  setFoldedReplies,
  setProcessView,
  useCollapseTiming,
  useFoldedReplies,
  useProcessView,
} from "../../../lib/viewMode";
import { isDangerousPermissionMode, permissionModeWarning } from "../../../lib/permissionModes";
import { isValidWaitLabel, setWaitLabel, useWaitLabel, waitLabelWidth, WAIT_LABEL_MAX } from "../../../lib/waitLabel";
import { Select } from "../../common/Select";
import { askConfirm } from "../../common/SystemDialogs";
import { SettingRow, SettingRows } from "./Section";

const PERMISSION_MODES = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];
const THEMES = ["light", "dark", "system"] as const;
const LOCALES = ["zh", "en"] as const;

/** 分段控件（外观 / 语言）：两三项用不到下拉，直接并排更少一次点击。 */
function Segmented<T extends string>({
  value,
  items,
  ariaLabel,
  onChange,
}: {
  value: T;
  items: readonly { value: T; label: string }[];
  ariaLabel: string;
  onChange: (next: T) => void;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex rounded-lg border border-line-strong p-0.5">
      {items.map((item) => {
        const active = value === item.value;
        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(item.value)}
            className={`whitespace-nowrap rounded-md px-2.5 py-1 text-[12px] ${
              active ? "bg-panel-strong font-medium text-ink" : "text-muted hover:text-ink"
            }`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

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
  /**
   * 字号按钮的本地递进值：`settings` 要等 PUT 回来才更新，按它算的话连点两次
   * 「+」都是 15→16（第二次读到的还是 15），用户以为按钮没反应。
   * 请求回来后清掉，回到 store 的权威值。
   */
  const [pendingFontSize, setPendingFontSize] = useState<number | null>(null);
  const shownFontSize = pendingFontSize ?? fontSize;
  const bumpFontSize = (delta: number) => {
    const next = Math.min(20, Math.max(12, shownFontSize + delta));
    if (next === shownFontSize) return;
    setPendingFontSize(next);
    void save({ font_size: next }).then(() => setPendingFontSize(null));
  };
  // 过程展示只存本设备（和主题同理）：手机要挤、桌面可以宽松。
  const view = useProcessView();
  const timing = useCollapseTiming();
  const replies = useFoldedReplies();
  // 计时行文案同样只存本设备：输入框里的草稿与「已生效」的值要分开，
  // 不合法的中间态（打了两个字母）不能进 localStorage。
  const waitLabel = useWaitLabel();
  const [labelDraft, setLabelDraft] = useState(waitLabel);
  const labelInvalid = labelDraft.trim() !== "" && !isValidWaitLabel(labelDraft);
  const commitLabel = () => {
    if (!isValidWaitLabel(labelDraft)) {
      setLabelDraft(waitLabel); // 不合法：退回上次生效的值
      return;
    }
    const next = labelDraft.trim();
    setWaitLabel(next);
    setLabelDraft(next); // 输入框跟着显示落盘后的样子（去掉首尾空白）
  };

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

  // 每行的说明跟着当前选中值走：三档/两档的具体差别没法塞进标题，又不想让
  // 分段控件下面再挂一行解释（那正是排版稀疏的来源）。
  const viewHint =
    view === "concise"
      ? t(
          "连续的过程折成一行摘要（已读取文件并运行了命令），点开才看每一步。",
          "Consecutive steps fold into one summary line; click to see each step.",
        )
      : view === "standard"
        ? t(
            "不分组：每一步各占一行，工具操作折成一行，点开看正文。",
            "No grouping: each step keeps its own line, tool calls fold into one line you can open.",
          )
        : t("每一步都是完整卡片，命令、diff 与输出直接铺在对话里。", "Every step is a full card: command, diff and output laid out inline.");
  const timingHint =
    timing === "onComplete"
      ? t("一轮跑完就把这一轮的过程收进开头一行，只留正文输出。", "When a turn finishes, its process folds into one line at the top, leaving only the replies.")
      : t("一轮跑完后过程仍然展开，等你发出下一条消息再收起来。", "A finished turn stays expanded until you send the next message.");
  const repliesHint =
    replies === "all"
      ? t("阶段回复与最终答案都保留，只收起过程。", "Intermediate replies and the final answer both stay; only the process folds.")
      : t("被折叠的轮次只留最后一条回答，阶段回复随过程一起收起。", "Folded turns keep only their last reply; intermediate replies hide with the process.");

  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex items-center gap-2">
        <h3 className="text-[15px] font-semibold text-ink">{t("通用设置", "General")}</h3>
        {(saving || savedAt) && (
          <span className="ml-auto text-[10.5px] text-faint">
            {saving ? t("保存中…", "Saving…") : t("已保存", "Saved")}
          </span>
        )}
      </div>

      <SettingRows>
        <SettingRow
          title={t("默认权限", "Default permission")}
          desc={t("新建会话时使用的权限模式。", "Permission mode for new sessions.")}
        >
          <Select
            variant="pill"
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
        </SettingRow>

        <SettingRow title={t("外观", "Appearance")} desc={t("选择浅色、深色，或跟随系统。", "Choose light, dark, or follow the system.")}>
          <Segmented
            ariaLabel={t("外观", "Appearance")}
            value={theme}
            items={THEMES.map((item) => ({
              value: item,
              label: item === "light" ? t("浅色", "Light") : item === "dark" ? t("深色", "Dark") : t("跟随系统", "System"),
            }))}
            onChange={(next) => {
              setThemePreference(next);
              setTheme(next);
            }}
          />
        </SettingRow>

        <SettingRow title={t("语言", "Language")} desc={t("切换界面语言；模型与工具输出保持原文。", "Switch the interface language; model and tool output stays as-is.")}>
          <Segmented
            ariaLabel={t("语言", "Language")}
            value={locale === "en" ? "en" : "zh"}
            items={LOCALES.map((item) => ({ value: item, label: item === "zh" ? "简体中文" : "English" }))}
            onChange={(next) => void save({ locale: next })}
          />
        </SettingRow>

        <SettingRow
          title={t("字号", "Font size")}
          desc={
            <>
              {t("仅调整会话内容与输入框的字号。", "Adjusts conversation and composer text only.")}
              {/* 预览挂在说明下面：单独占一行会让这一项比别的行高出一截。 */}
              <span className="mt-1 flex items-baseline gap-1.5">
                <span className="shrink-0 text-[10.5px] text-faint">{t("预览", "Preview")}</span>
                <span className="chat-text min-w-0 truncate text-muted">
                  {t("Claude 会在当前工作区读取文件并执行命令。", "Claude reads files and runs commands in the current workspace.")}
                </span>
              </span>
            </>
          }
        >
          <div className="flex items-center gap-1.5">
            <div className="inline-flex items-center rounded-lg bg-panel dark:bg-panel-strong">
              <button
                type="button"
                onClick={() => bumpFontSize(-1)}
                disabled={shownFontSize <= 12}
                className="h-8 w-8 rounded-l-lg text-[13px] text-muted hover:bg-panel-strong hover:text-ink disabled:opacity-30 dark:hover:bg-line disabled:hover:bg-transparent"
                aria-label={t("减小字号", "Decrease font size")}
              >
                −
              </button>
              <span className="w-8 text-center font-mono text-[12.5px] text-ink tabular-nums">{shownFontSize}</span>
              <button
                type="button"
                onClick={() => bumpFontSize(1)}
                disabled={shownFontSize >= 20}
                className="h-8 w-8 rounded-r-lg text-[13px] text-muted hover:bg-panel-strong hover:text-ink disabled:opacity-30 dark:hover:bg-line disabled:hover:bg-transparent"
                aria-label={t("增大字号", "Increase font size")}
              >
                +
              </button>
            </div>
            <span className="text-[11.5px] text-muted">px</span>
          </div>
        </SettingRow>

        <SettingRow title={t("过程展示", "Process display")} desc={viewHint}>
          <Select
            variant="pill"
            ariaLabel={t("过程展示", "Process display")}
            value={view}
            onChange={(next) => setProcessView(next as typeof view)}
            options={PROCESS_VIEWS.map((item) => ({
              value: item,
              label: item === "concise" ? t("简洁", "Concise") : item === "standard" ? t("标准", "Standard") : t("详细", "Detailed"),
            }))}
            menuWidth={140}
          />
        </SettingRow>

        <SettingRow title={t("收起时机", "Collapse timing")} desc={timingHint}>
          <Select
            variant="pill"
            ariaLabel={t("收起时机", "Collapse timing")}
            value={timing}
            onChange={(next) => setCollapseTiming(next as typeof timing)}
            options={COLLAPSE_TIMINGS.map((item) => ({
              value: item,
              label: item === "onComplete" ? t("完成时收起", "On completion") : t("下次发送时收起", "On next message"),
            }))}
            menuWidth={168}
          />
        </SettingRow>

        <SettingRow title={t("收起后的回复", "Replies after folding")} desc={repliesHint}>
          <Select
            variant="pill"
            ariaLabel={t("收起后的回复", "Replies after folding")}
            value={replies}
            onChange={(next) => setFoldedReplies(next as typeof replies)}
            options={FOLDED_REPLIES.map((item) => ({
              value: item,
              label: item === "all" ? t("全部回复", "All replies") : t("仅最终回答", "Final answer only"),
            }))}
            menuWidth={168}
          />
        </SettingRow>

        {/* 只有「环境变量令牌」这一种凭据在这里填；TCP 访问密码在「设置 → 访问」里管。 */}
        {info?.auth_mode === "token" && (
          <SettingRow
            stacked
            title={t("访问令牌", "Access token")}
            desc={t("后端启用了 CCWEB_AUTH_TOKEN。令牌只保存在本浏览器。", "The backend requires CCWEB_AUTH_TOKEN. The token is stored only in this browser.")}
          >
            <div className="flex gap-2">
              <input
                {...NO_AUTOFILL}
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
                className="shrink-0 rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-canvas hover:opacity-90"
              >
                {t("保存并重新加载", "Save and reload")}
              </button>
            </div>
          </SettingRow>
        )}

        {/* 计时行那句「少女祈祷中」的自定义文案（`lib/waitLabel`）：一行说明写清「换的是
            哪句话 + 口径」，再凑第二条解释就是噪音。不合法时边框变红、失焦后退回上次
            生效的值：悄悄吞掉输入等于让人以为自己没敲进去。
            输入框右端那个小计数器是实时的口径反馈——中英混写时「宽了几个字符」光看
            字数看不出来（四个汉字就已经 8 了）。 */}
        <SettingRow
          title={t("自定义", "Custom")}
          desc={t("计时行的那句等待文案；6–12 个字符，汉字算 2 个。", "The waiting text next to the timer; 6–12 characters, CJK counts as 2.")}
        >
          <div className="relative">
            <input
              {...NO_AUTOFILL}
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onBlur={commitLabel}
              onKeyDown={(e) => {
                // Enter 只是「提交」的手势：真正落盘的那一次在 blur 里，
                // 两条路都写会让回退逻辑分叉。
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              aria-label={t("自定义", "Custom")}
              aria-invalid={labelInvalid || undefined}
              placeholder={t("少女祈祷中", "Waiting on Claude")}
              className={`w-40 rounded-lg border bg-canvas py-1.5 pl-2.5 pr-10 text-[12px] outline-none focus:border-brand/60 ${
                labelInvalid ? "border-warn/70" : "border-line-strong"
              }`}
            />
            {labelDraft.trim() !== "" && (
              <span
                aria-hidden
                className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[10px] tabular-nums ${
                  labelInvalid ? "text-warn" : "text-faint"
                }`}
              >
                {waitLabelWidth(labelDraft)}/{WAIT_LABEL_MAX}
              </span>
            )}
          </div>
        </SettingRow>
      </SettingRows>
    </div>
  );
}
