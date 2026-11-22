// 「设置 → MCP → 内置搜索」：DeepSeek Search / Fetch API 的配置。
//
// 它和下面那些 MCP server 不是一回事：这里配的是本应用自带的
// `ccweb mcp-web` 子命令，由它去调网关的 /search 与 /fetch。
// 一次搜索是一次 HTTP 请求，不额外花模型回合；密钥与对话用的分开填。
//
// **这一块没有「注册 / 移除」按钮**：这条服务与自动化任务、内置浏览器一样由后端维护
// （`EnsureSearchMCP`），启用开关就是它的开关。以前那两个按钮让同一份用户级配置有了
// 两个入口——MCP 页能删、这里能注册，删完设置里还写着「已启用」，工具却没了。
import { useEffect, useState } from "react";
import { NO_AUTOFILL } from "../../lib/autofill";
import { useT } from "../../lib/i18n";
import { useSearchStore } from "../../store/useSearchStore";
import { Button } from "../common/Button";
import { Collapsible } from "../common/Collapsible";
import { IconAlert, IconGlobe, IconTrash } from "../common/Icons";

const inputClass =
  "w-full rounded-lg border border-line-strong bg-canvas px-2.5 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-faint focus-visible:border-brand/60";

export function SearchSettings() {
  const t = useT();
  const status = useSearchStore((s) => s.status);
  const error = useSearchStore((s) => s.error);
  const busy = useSearchStore((s) => s.busy);
  const testing = useSearchStore((s) => s.testing);
  const test = useSearchStore((s) => s.test);
  const load = useSearchStore((s) => s.load);
  const save = useSearchStore((s) => s.save);
  const runTest = useSearchStore((s) => s.runTest);

  const [base, setBase] = useState("");
  const [count, setCount] = useState("10");
  const [key, setKey] = useState("");

  useEffect(() => {
    void load();
  }, [load]);

  // 只在后端状态变化时回填（保存/注册后都会拿到新状态）；
  // 密钥框永远留空——它只用于「换一把新的」，回填明文既无必要也不安全。
  // 标签旁也不显示脱敏串：截图、录屏、共享屏幕时那几个尾巴同样是泄漏，
  // 「已保存，留空则不修改」这个 placeholder 已经说明了一切。
  useEffect(() => {
    if (!status) return;
    setBase(status.base_url);
    setCount(String(status.search_count));
  }, [status]);

  const enabled = status?.search_enabled ?? false;

  // 折叠成一行时要能看出「现在是什么状态」：否则收起来之后既不知道开没开，
  // 也看不出有没有注册到 Claude，用户还得点开确认一遍，省空间的代价就白付了。
  // 启停状态不重复写一遍——右边那颗按钮的文案（启用 / 已启用）已经说明了这件事。
  // 状态还没读到时不写「未注册」——那是把「不知道」说成了「没配」。
  // 停用与已注册是两个不同的答案：前者在 MCP 页被摘进了本应用的暂存，会话连不上。
  const summary = status
    ? [
        ...(status.mcp_supported
          ? [status.attached ? t("已注册", "Registered") : status.disabled ? t("已停用", "Disabled") : t("未注册", "Not registered")]
          : []),
        ...(error ? [t("出错", "Error")] : []),
      ].join(" · ")
    : "";

  const submit = async () => {
    const n = Number.parseInt(count, 10);
    if (!Number.isFinite(n) || n < 1 || n > 50) {
      useSearchStore.getState().setError(t("结果条数必须在 1–50 之间", "Result count must be between 1 and 50"));
      return;
    }
    await save({
      base_url: base,
      count: n,
      api_key: key.trim() ? key.trim() : undefined,
    });
    setKey("");
  };

  return (
    // 折叠成一行：这块是「设置 → MCP」页最上面的一块，但它只有配好之后才需要动，
    // 平时占掉的大半屏把下面的服务列表推到了看不见的地方（手机上尤其明显）。
    // 用库里已有的 Collapsible（与工具卡片、思考过程同一套外观与键盘行为），
    // 摘要报状态、右侧留启停按钮——收起时既看得出开没开，也不用点开才能启用。
    <div className="mb-5">
      <Collapsible
        title={t("内置搜索（DeepSeek）", "Built-in search (DeepSeek)")}
        icon={<IconGlobe size={13} />}
        summary={summary}
        tone="muted"
        actions={
          <Button
            size="sm"
            variant={enabled ? "primary" : "secondary"}
            disabled={busy}
            aria-pressed={enabled}
            onClick={() => void save({ enabled: !enabled })}
          >
            {enabled ? t("已启用", "Enabled") : t("启用", "Enable")}
          </Button>
        }
      >
        <p className="mb-2 text-[11px] leading-relaxed text-muted">
          {t(
            "走 DeepSeek 的 Search / Fetch API：一次搜索是一次 HTTP 请求，不额外花模型回合。一次请求最多 50 条。",
            "Uses the DeepSeek Search / Fetch API: one search is one HTTP request, no extra model turn. Up to 50 results per request.",
          )}
        </p>

        {error && (
          <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-danger dark:border-rose-900/60 dark:bg-rose-950/30">
            <IconAlert size={12} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}

        <div className="grid gap-2 md:grid-cols-2">
          <label className="block md:col-span-2">
            <span className="mb-1 block text-[11px] text-muted">{t("网关基地址", "API base URL")}</span>
            <input
              {...NO_AUTOFILL}
              className={`${inputClass} font-mono`}
              value={base}
              disabled={busy}
              onChange={(e) => setBase(e.target.value)}
              placeholder="https://api.deepseek.com/v1/tools"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] text-muted">{t("搜索密钥", "Search API key")}</span>
            <input
              {...NO_AUTOFILL}
              className={`${inputClass} font-mono`}
              type="password"
              value={key}
              disabled={busy}
              onChange={(e) => setKey(e.target.value)}
              placeholder={status?.search_api_key_set ? t("已保存，留空则不修改", "Saved — leave empty to keep") : "sk-..."}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] text-muted">{t("结果条数（1–50）", "Results per search (1–50)")}</span>
            <input className={inputClass} value={count} disabled={busy} onChange={(e) => setCount(e.target.value)} inputMode="numeric" />
          </label>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void submit()}>
            {t("保存", "Save")}
          </Button>
          <Button size="sm" variant="secondary" disabled={testing || busy || !status?.search_api_key_set} onClick={() => void runTest()}>
            {testing ? t("测试中…", "Testing…") : t("测试连接", "Test connection")}
          </Button>
          {status?.search_api_key_set && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void save({ clear_key: true })}
              icon={<IconTrash size={12} />}
            >
              {t("清除密钥", "Clear key")}
            </Button>
          )}
          {test && (
            <span className={`text-[11px] ${test.ok ? "text-muted" : "text-danger"}`}>
              {test.ok
                ? t(`连接正常 · ${test.count ?? 0} 条结果 · ${test.latency_ms}ms`, `OK · ${test.count ?? 0} results · ${test.latency_ms}ms`)
                : test.error}
            </span>
          )}
        </div>

        <div className="mt-3 border-t border-line pt-2 text-[11px] leading-relaxed text-muted">
          {!status?.mcp_supported ? (
            <span>{t("这套部署没有启用 MCP 管理，无法注册到 Claude。", "MCP management is not enabled in this deployment.")}</span>
          ) : status.attached ? (
            <span className="min-w-0">
              {t("已注册到用户级 MCP 配置（所有项目可用）", "Registered in user-scope MCP config (all projects)")}
              <span className="ml-1 font-mono text-[10px] text-faint">{status.server_name}</span>
              {t("；要临时关掉，就在下面的用户级列表里「停用」。", "; use Disable in the user-scope list below to switch it off for now.")}
            </span>
          ) : status.disabled ? (
            // 用户在 MCP 页点过「停用」：配置已经摘进本应用的暂存，会话连不上。
            // 这一行不能写「已注册」——那会让「搜索为什么用不了」变成一个谜。
            <span className="text-warn">
              {t(
                "已停用——下面的用户级列表里「启用」它，搜索工具才会重新接上。",
                "Disabled — use Enable on it in the user-scope list below to bring the search tools back.",
              )}
            </span>
          ) : enabled && status.search_api_key_set ? (
            // 启用且有密钥却不在配置里：正常路径上不会停在这（保存即同步）。
            // 说清楚怎么补，而不是留一句「正在注册」永远转下去。
            <span className="text-warn">
              {t(
                "已启用，但这条服务还不在 MCP 配置里——再保存一次即可补上。",
                "Enabled, but the server is not in the MCP config yet — save once more to add it.",
              )}
            </span>
          ) : (
            <span>
              {t(
                "启用并保存密钥后，会自动注册成 ccweb-web（下面用户级列表里能看到它）。",
                "Enabling it with a saved key registers ccweb-web automatically (it then shows up in the user-scope list below).",
              )}
            </span>
          )}
        </div>
        <p className="mt-1 text-[10.5px] leading-relaxed text-faint">
          {t(
            "启用 / 停用后要重开会话才生效（MCP server 在会话启动时连接）。",
            "Reopen the conversation after enabling or disabling (MCP servers connect at session start).",
          )}
        </p>
      </Collapsible>
    </div>
  );
}
