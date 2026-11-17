import { NO_AUTOFILL } from "../../../lib/autofill";
import { useEffect, useState } from "react";
import { useAppStore } from "../../../store/useAppStore";
import { useT } from "../../../lib/i18n";
import { loginAccess, setToken } from "../../../lib/runtime";
import { passwordIssue, type PasswordIssue } from "../../../lib/password";
import { TCP_PORT_MAX, TCP_PORT_MIN, validTCPPort } from "../../../lib/access";
import { Button } from "../../common/Button";
import { IconCheck, IconEye, IconEyeOff } from "../../common/Icons";
import { Section } from "./Section";

/** 开关：角色是 switch，外观走主题令牌（不摆原生 checkbox）。 */
function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-brand" : "bg-line-strong"}`}
    >
      <span
        aria-hidden
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all ${checked ? "left-[22px]" : "left-0.5"}`}
      />
    </button>
  );
}

/**
 * 「设置 → 访问」：TCP 端口访问开关、端口与访问密码。
 *
 * 规则：
 *   - 端口访问默认关闭；开启后必须登录（单个访问密码，无用户名）；
 *   - 密码开启前必须设置，且有基础复杂度（≥8 位、含字母与数字）——后端存 PBKDF2
 *     摘要，不落明文；
 *   - 端口范围 1025–65535，保存时后端会真的 bind 一次，端口被占用就报错、不落盘；
 *   - unix socket（前置网关反代）是本机可信入口，不校验这个密码。
 */
export function AccessSettings() {
  const t = useT();
  const settings = useAppStore((s) => s.settings);
  const info = useAppStore((s) => s.info);
  const saving = useAppStore((s) => s.settingsSaving);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const loadInfo = useAppStore((s) => s.loadInfo);

  const savedEnabled = Boolean(settings?.tcp_enabled);
  const savedPort = settings?.tcp_port ?? 3141;
  const passwordSet = Boolean(settings?.tcp_password_set);

  const [enabled, setEnabled] = useState(savedEnabled);
  const [port, setPort] = useState(String(savedPort));
  const [pwd, setPwd] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 保存成功后后端会回新的 Public，重置草稿；密码框永远清空（不回显明文）。
  useEffect(() => {
    setEnabled(savedEnabled);
    setPort(String(savedPort));
    setPwd("");
    setNotice(null);
    setSaveError(null);
  }, [savedEnabled, savedPort, passwordSet]);

  const portValid = validTCPPort(port);
  const issue = pwd ? passwordIssue(pwd) : null;
  const pwdValid = pwd === "" || issue === null;
  // 开启时必须有一个密码：要么已经存过，要么这次输入一个合规的。
  const hasPassword = passwordSet || (pwd !== "" && issue === null);
  const dirty = enabled !== savedEnabled || Number(port) !== savedPort || pwd !== "";
  const canSave = !saving && portValid && pwdValid && (!enabled || hasPassword) && dirty;

  const issueText = (v: PasswordIssue) => {
    switch (v) {
      case "short":
        return t("密码至少 8 位", "At least 8 characters");
      case "long":
        return t("密码最长 128 位", "At most 128 characters");
      case "control":
        return t("密码不能包含控制字符", "No control characters");
      case "letter":
        return t("密码需要包含字母", "Include at least one letter");
      case "digit":
        return t("密码需要包含数字", "Include at least one digit");
      default:
        return t("至少 8 位，需同时包含字母与数字。", "At least 8 characters, with letters and digits.");
    }
  };

  const save = async () => {
    setNotice(null);
    setSaveError(null);
    const turningOff = savedEnabled && !enabled;
    const patch: Parameters<typeof saveSettings>[0] = {
      tcp_enabled: enabled,
      tcp_port: Number(port),
    };
    if (pwd !== "") patch.tcp_password = pwd;

    const ok = await saveSettings(patch);
    if (!ok) {
      // 端口被占用 / 权限不足等错误由后端在落盘前返回，这里就地显示，
      // 不只依赖顶部那条全局提示。
      setSaveError(useAppStore.getState().error ?? t("保存失败，请重试。", "Save failed. Try again."));
      return;
    }
    setSavedAt(Date.now());

    // 正在用 TCP 访问时改密码：旧会话立刻失效，用刚输入的密码换一个新令牌，
    // 否则下一个请求就 401、看起来像「保存把自己锁在门外」。
    // unix 通道用的是环境变量令牌，绝不能拿访问密码覆盖它。
    if (pwd !== "" && info?.channel === "tcp") {
      try {
        setToken(await loginAccess(pwd));
      } catch {
        setNotice(t("密码已更新，请刷新页面重新登录。", "Password updated. Reload the page and sign in again."));
      }
    }
    setPwd("");

    if (turningOff) {
      setNotice(
        t(
          "端口访问已关闭，TCP 连接会随之断开；unix socket（网关）入口不受影响。",
          "Port access is off; TCP connections are being closed. The unix socket (gateway) entry is unaffected.",
        ),
      );
      return;
    }
    void loadInfo();
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h3 className="text-[15px] font-semibold text-ink">{t("访问", "Access")}</h3>

      <div className="border-b border-line pb-6">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12.5px] font-medium text-ink">{t("启用端口访问", "Enable port access")}</span>
          <Switch
            checked={enabled}
            onChange={(v) => {
              setEnabled(v);
              setSavedAt(null);
              setSaveError(null);
            }}
            label={t("启用端口访问", "Enable port access")}
          />
        </div>
        {!enabled ? (
          <p className="mt-2 text-[11px] text-muted">{t("端口访问已关闭。", "Port access is off.")}</p>
        ) : info?.tcp_listening ? (
          <p className="mt-2 text-[11px] text-ok">
            {t(`监听中：端口 ${info.tcp_port}`, `Listening on port ${info.tcp_port}`)}
          </p>
        ) : (
          <p className="mt-2 text-[11px] text-danger">{t("当前没有在监听 TCP 端口。", "Not listening on a TCP port right now.")}</p>
        )}
        {info?.tcp_error && (
          <p className="mt-1 break-words text-[11px] text-danger">
            {t("最近一次监听失败：", "Last listen attempt failed: ")}
            {info.tcp_error}
          </p>
        )}

        <div className="mt-4 flex items-center gap-2">
          <input
            value={port}
            onChange={(e) => {
              setPort(e.target.value.replace(/[^\d]/g, ""));
              setSavedAt(null);
              setSaveError(null);
            }}
            inputMode="numeric"
            spellCheck={false}
            aria-label={t("TCP 端口", "TCP port")}
            className="w-28 rounded-lg border border-line-strong bg-canvas px-2.5 py-2 font-mono text-[12px] outline-none focus:border-brand/60"
          />
        </div>
        {!portValid && (
          <p className="mt-1 text-[11px] text-danger">
            {t(`端口必须在 ${TCP_PORT_MIN}–${TCP_PORT_MAX} 之间`, `Port must be between ${TCP_PORT_MIN} and ${TCP_PORT_MAX}`)}
          </p>
        )}
      </div>

      <Section title={t("访问密码", "Access password")}>
        <div className="relative">
          <input
            {...NO_AUTOFILL}
            id="ccweb-tcp-password"
            type={showPwd ? "text" : "password"}
            value={pwd}
            onChange={(e) => {
              setPwd(e.target.value);
              setSavedAt(null);
              setSaveError(null);
            }}
            autoComplete="new-password"
            aria-label={t("访问密码", "Access password")}
            placeholder={
              passwordSet
                ? t("已设置（留空不修改）", "Set — leave blank to keep")
                : t("设置访问密码", "Set an access password")
            }
            className="w-full rounded-lg border border-line-strong bg-canvas py-2 pl-2.5 pr-10 font-mono text-[12px] outline-none placeholder:text-faint focus:border-brand/60"
          />
          <button
            type="button"
            onClick={() => setShowPwd((v) => !v)}
            aria-label={showPwd ? t("隐藏密码", "Hide password") : t("显示密码", "Show password")}
            title={showPwd ? t("隐藏密码", "Hide password") : t("显示密码", "Show password")}
            className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted transition hover:bg-black/5 hover:text-ink dark:hover:bg-white/5"
          >
            {showPwd ? <IconEyeOff size={15} /> : <IconEye size={15} />}
          </button>
        </div>
        <p className={`mt-1.5 text-[11px] leading-relaxed ${pwd !== "" && issue ? "text-danger" : "text-muted"}`}>
          {pwd !== "" && issue ? issueText(issue) : issueText(null)}
        </p>
        {enabled && !hasPassword && (
          <p className="mt-1 text-[11px] text-danger">
            {t("开启端口访问前必须先设置访问密码。", "Set an access password before enabling port access.")}
          </p>
        )}
      </Section>

      <div className="flex items-center gap-3">
        {(saving || savedAt) && (
          <span className="text-[10.5px] text-faint">
            {saving ? t("保存中…", "Saving…") : t("已保存", "Saved")}
          </span>
        )}
        <Button variant="primary" onClick={() => void save()} disabled={!canSave} icon={<IconCheck size={14} />} className="ml-auto">
          {t("保存访问设置", "Save access settings")}
        </Button>
      </div>
      {saveError && <p className="break-words rounded-lg bg-rose-50 px-3 py-2 text-[11px] leading-relaxed text-danger dark:bg-rose-950/30">{saveError}</p>}
      {notice && <p className="rounded-lg bg-brand-soft px-3 py-2 text-[11px] leading-relaxed text-ink-2">{notice}</p>}
    </div>
  );
}
