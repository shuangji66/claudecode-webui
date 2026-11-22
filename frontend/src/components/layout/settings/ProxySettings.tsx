import { NO_AUTOFILL } from "../../../lib/autofill";
import { useEffect, useState } from "react";
import { useAppStore } from "../../../store/useAppStore";
import { useT } from "../../../lib/i18n";
import { proxyUrlIssue } from "../../../lib/proxy";
import { askConfirm } from "../../common/SystemDialogs";
import { IconCheck } from "../../common/Icons";
import { Section } from "./Section";

export function ProxySettings() {
  const t = useT();
  const settings = useAppStore((s) => s.settings);
  const sessions = useAppStore((s) => s.sessions);
  const saving = useAppStore((s) => s.settingsSaving);
  const applyProxy = useAppStore((s) => s.applyProxy);
  const [url, setUrl] = useState(settings?.proxy_url ?? "");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const issue = proxyUrlIssue(url);

  useEffect(() => {
    setUrl(settings?.proxy_url ?? "");
    setSavedAt(null);
    setLocalError(null);
  }, [settings?.proxy_url]);

  const save = async () => {
    if (proxyUrlIssue(url)) return;
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
          {t("为 claude 子进程、右侧栏的 git 拉取，以及面板自己的请求（拉模型列表、探测端点、下载 claude）设置 HTTP / HTTPS 代理；留空表示直连。", "Set an HTTP / HTTPS proxy for the claude subprocess, the sidebar's git pull, and the panel's own requests (model list, endpoint probe, claude download). Leave blank for direct access.")}
        </p>
      </div>

      <Section title={t("代理地址", "Proxy URL")} desc={t("只支持 http:// 与 https://；可包含用户名密码。", "Only http:// and https:// are supported; credentials are allowed.")}>
        <input {...NO_AUTOFILL}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setSavedAt(null);
            setLocalError(null);
          }}
          placeholder="http://127.0.0.1:7890"
          spellCheck={false}
          className="w-full rounded-lg border border-line-strong bg-canvas px-2.5 py-2 font-mono text-[12px] outline-none placeholder:text-faint focus:border-brand/60"
          aria-label={t("代理地址", "Proxy URL")}
        />
      </Section>

      {issue && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-[11px] text-danger dark:bg-rose-950/30">
          {issue === "scheme"
            ? t("不支持 SOCKS 代理：claude 只认 HTTP 代理，填 SOCKS 地址会直接报 UnsupportedProxyProtocol。请改用代理客户端提供的 HTTP 端口，例如 http://127.0.0.1:7890。", "SOCKS proxies are not supported: claude only speaks HTTP proxies and fails with UnsupportedProxyProtocol. Use the HTTP port your proxy client exposes, e.g. http://127.0.0.1:7890.")
            : t("代理地址无效：需要带协议与主机，例如 http://127.0.0.1:7890。", "Invalid proxy URL: include the scheme and host, e.g. http://127.0.0.1:7890.")}
        </p>
      )}

      <div className="flex items-center gap-3">
        {(saving || savedAt) && (
          <span className="text-[10.5px] text-faint">
            {saving ? t("保存并重启中…", "Saving and restarting…") : t("已保存并重启 Claude", "Saved and restarted Claude")}
          </span>
        )}
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || issue !== null}
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

