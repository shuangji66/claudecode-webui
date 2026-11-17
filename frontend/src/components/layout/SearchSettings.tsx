// 「设置 → MCP → 内置搜索」：DeepSeek Search / Fetch API 的配置与注册。
//
// 它和下面那些 MCP server 不是一回事：这里配的是本应用自带的
// `ccweb mcp-web` 子命令，由它去调网关的 /search 与 /fetch。
// 一次搜索是一次 HTTP 请求，不额外花模型回合；密钥与对话用的分开填。
import { useEffect, useState } from "react";
import { NO_AUTOFILL } from "../../lib/autofill";
import { useT } from "../../lib/i18n";
import { useSearchStore } from "../../store/useSearchStore";
import { Button } from "../common/Button";
import { IconAlert, IconGlobe, IconPlus, IconRefresh, IconTrash } from "../common/Icons";

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
  const attach = useSearchStore((s) => s.attach);
  const detach = useSearchStore((s) => s.detach);

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
    <section className="mb-5 rounded-xl border border-line bg-panel/40 p-3">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[12rem] flex-1">
          <h3 className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
            <IconGlobe size={13} />
            {t("内置搜索（DeepSeek）", "Built-in search (DeepSeek)")}
          </h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
            {t(
              "走 DeepSeek 的 Search / Fetch API：一次搜索是一次 HTTP 请求，不额外花模型回合。一次请求最多 50 条。",
              "Uses the DeepSeek Search / Fetch API: one search is one HTTP request, no extra model turn. Up to 50 results per request.",
            )}
          </p>
        </div>
        <Button
          size="sm"
          variant={enabled ? "primary" : "secondary"}
          disabled={busy}
          aria-pressed={enabled}
          onClick={() => void save({ enabled: !enabled })}
        >
          {enabled ? t("已启用", "Enabled") : t("启用", "Enable")}
        </Button>
      </div>

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

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-2 text-[11px] text-muted">
        {!status?.mcp_supported ? (
          <span>{t("这套部署没有启用 MCP 管理，无法注册到 Claude。", "MCP management is not enabled in this deployment.")}</span>
        ) : status.attached ? (
          <>
            <span className="min-w-0">
              {t("已注册到用户级 MCP 配置（所有项目可用）", "Registered in user-scope MCP config (all projects)")}
              <span className="ml-1 font-mono text-[10px] text-faint">{status.server_name}</span>
            </span>
            {!status.always_load && (
              // 老版本注册的条目没有 alwaysLoad：工具被延迟到 ToolSearch 后面，
              // 模型只看到名字。重新注册一次就补上了。
              <span className="min-w-0 text-warn">
                {t("这条注册来自旧版本，工具没有常驻工具表，模型可能想不到用它。", "This registration predates always-load, so the tools may stay hidden from the model.")}
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void attach()}
              icon={<IconRefresh size={12} />}
            >
              {status.always_load ? t("重新注册", "Re-register") : t("补上常驻", "Enable always-load")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void detach()} icon={<IconTrash size={12} />}>
              {t("移除", "Remove")}
            </Button>
          </>
        ) : (
          <>
            <span>{t("还没注册到 Claude——注册后会多出 web_search / web_fetch 两个工具。", "Not registered yet — registering adds the web_search and web_fetch tools.")}</span>
            <Button size="sm" variant="secondary" disabled={busy || !enabled || !status.search_api_key_set} onClick={() => void attach()} icon={<IconPlus size={12} />}>
              {t("注册到 Claude", "Register with Claude")}
            </Button>
          </>
        )}
      </div>
      <p className="mt-1 text-[10.5px] leading-relaxed text-faint">
        {t(
          "注册/移除后要重开会话才生效（MCP server 在会话启动时连接）。",
          "Reopen the conversation after registering or removing (MCP servers connect at session start).",
        )}
      </p>
    </section>
  );
}
