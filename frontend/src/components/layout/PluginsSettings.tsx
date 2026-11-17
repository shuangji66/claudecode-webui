// 「设置 → 插件」：驱动 `claude plugin`，管理插件与 marketplace。
//
// 后端是 CLI 的薄封装（internal/plugin），变更操作跑在后台任务里（克隆 marketplace
// 最长 120s），所以这里的按钮都是「发出请求 → 轮询 job → 结束后刷新列表」。
//
// 两处必须说清楚的事：
//   1. 插件能在会话里执行命令（hooks）或起进程（自带 MCP server），安装等于运行第三方代码。
//   2. 插件在**会话启动时**加载：装/停用/更新之后要重开会话才生效。

import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { NO_AUTOFILL } from "../../lib/autofill";
import { Button } from "../common/Button";
import { Select } from "../common/Select";
import { askConfirm } from "../common/SystemDialogs";
import { usePluginStore } from "../../store/usePluginStore";
import type { PluginEntry, PluginJob } from "../../transport/types";
import {
  IconAlert,
  IconCheck,
  IconChevronLeft,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
} from "../common/Icons";

const SCOPE_OPTIONS = [
  { value: "user", label: "用户级（所有项目）" },
  { value: "project", label: "项目级（仅当前工作区）" },
];

/**
 * 任务类型 → 两句人话：进行中与已完成分开说。
 *
 * 拼成「正在停用完成」只会让人愣一下，所以两个阶段各有一套文案。
 */
function jobLabel(job: PluginJob, t: (zh: string, en: string) => string): { running: string; done: string } {
  const map: Record<string, [{ running: string; done: string }, { running: string; done: string }]> = {
    install: [{ running: "正在安装", done: "已安装" }, { running: "Installing", done: "Installed" }],
    enable: [{ running: "正在启用", done: "已启用" }, { running: "Enabling", done: "Enabled" }],
    disable: [{ running: "正在停用", done: "已停用" }, { running: "Disabling", done: "Disabled" }],
    update: [{ running: "正在更新", done: "已更新" }, { running: "Updating", done: "Updated" }],
    uninstall: [{ running: "正在卸载", done: "已卸载" }, { running: "Uninstalling", done: "Uninstalled" }],
    "marketplace-add": [{ running: "正在添加市场", done: "市场已添加" }, { running: "Adding marketplace", done: "Marketplace added" }],
    "marketplace-update": [{ running: "正在刷新市场", done: "市场已刷新" }, { running: "Refreshing marketplace", done: "Marketplace refreshed" }],
    "marketplace-remove": [{ running: "正在移除市场", done: "市场已移除" }, { running: "Removing marketplace", done: "Marketplace removed" }],
    refresh: [{ running: "正在拉取可用插件", done: "可用插件已刷新" }, { running: "Loading available plugins", done: "Available refreshed" }],
  };
  const hit = map[job.kind];
  if (!hit) return { running: job.kind, done: job.kind };
  return { running: t(hit[0].running, hit[1].running), done: t(hit[0].done, hit[1].done) };
}

export function PluginsSettings({ cwd }: { cwd: string }) {
  const t = useT();
  const data = usePluginStore((s) => s.data);
  const job = usePluginStore((s) => s.job);
  const error = usePluginStore((s) => s.error);
  const busy = usePluginStore((s) => s.busy);
  const loaded = usePluginStore((s) => s.loaded);
  const details = usePluginStore((s) => s.details);
  const loadingDetails = usePluginStore((s) => s.loadingDetails);
  const load = usePluginStore((s) => s.load);
  const refreshAvailable = usePluginStore((s) => s.refreshAvailable);
  const install = usePluginStore((s) => s.install);
  const setEnabled = usePluginStore((s) => s.setEnabled);
  const update = usePluginStore((s) => s.update);
  const uninstall = usePluginStore((s) => s.uninstall);
  const marketplace = usePluginStore((s) => s.marketplace);
  const openDetails = usePluginStore((s) => s.openDetails);
  const clearDetails = usePluginStore((s) => s.clearDetails);
  const setError = usePluginStore((s) => s.setError);
  const storeAvail = usePluginStore((s) => s.avail);
  const setAvailQuery = usePluginStore((s) => s.setAvailQuery);
  const setAvailMarket = usePluginStore((s) => s.setAvailMarket);
  const setAvailHideInstalled = usePluginStore((s) => s.setAvailHideInstalled);
  const showMoreAvailable = usePluginStore((s) => s.showMoreAvailable);

  const [scope, setScope] = useState("user");
  const [source, setSource] = useState("");
  const [installTarget, setInstallTarget] = useState("");
  const [installMarket, setInstallMarket] = useState("");

  useEffect(() => {
    void load(cwd);
  }, [cwd, load]);

  const running = job?.phase === "running";
  const installed = data.installed;
  const installedIds = new Set(installed.map((p) => p.id));
  const availableTotal = data.available_total;
  const avail = storeAvail;

  const doInstall = async (id: string, market: string) => {
    await install(id, market, scope);
    setInstallTarget("");
    setInstallMarket("");
  };

  const confirmUninstall = async (p: PluginEntry) => {
    const ok = await askConfirm({
      title: t(`卸载插件「${p.id}」？`, `Uninstall "${p.id}"?`),
      message: t(
        "会删掉它的缓存副本与启用状态；插件自己的数据目录默认保留。",
        "Its cached copy and enable state are removed; the plugin's own data directory is kept.",
      ),
      danger: true,
      confirmText: t("卸载", "Uninstall"),
    });
    if (ok) await uninstall(p.id, p.scope, true);
  };

  // 详情做成页内视图，而不是在设置模态上再开一层弹窗：
  // 手机上两层模态会互相盖住（底部 sheet 只露出半屏，清单根本翻不动），
  // 而组件清单常常很长（CLI 原文 + token 成本表），需要整页滚动。
  if (details) {
    const entry = installed.find((p) => p.id === details.id);
    const skills = details.details.text ? details.details.skills : details.inspect.skills;
    const hooks = details.details.text ? details.details.hooks : details.inspect.hooks ? 1 : 0;
    const mcp = details.details.text ? details.details.mcp_servers : details.inspect.mcp_servers ? 1 : 0;
    const risky = hooks > 0 || mcp > 0;
    const backToList = () => {
      clearDetails();
      void load(cwd);
    };
    return (
      <div className="space-y-3 pb-2">
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={backToList} icon={<IconChevronLeft size={12} />}>
            {t("返回", "Back")}
          </Button>
          <h3 className="min-w-0 flex-1 break-all font-mono text-[12px] text-ink">{details.id}</h3>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
          {entry && (
            <>
              <span className="rounded bg-panel-strong px-1.5 py-0.5 text-muted">{entry.version || "?"}</span>
              <span className="rounded bg-panel-strong px-1.5 py-0.5 text-muted">
                {entry.scope === "project" ? t("项目级", "project") : entry.scope === "local" ? t("本地", "local") : t("用户级", "user")}
              </span>
              <span className={`rounded px-1.5 py-0.5 ${entry.enabled ? "bg-panel-strong text-muted" : "bg-panel-strong text-warn"}`}>
                {entry.enabled ? t("已启用", "enabled") : t("已停用", "disabled")}
              </span>
            </>
          )}
          {!entry && (
            <span className="rounded bg-panel-strong px-1.5 py-0.5 text-muted">{t("未安装", "not installed")}</span>
          )}
        </div>

        {risky && (
          <p className="flex items-start gap-1.5 rounded-lg border border-danger/40 bg-danger/5 px-2.5 py-2 text-[11px] leading-relaxed text-danger">
            <IconAlert size={12} className="mt-0.5 shrink-0" />
            <span>
              {t(
                "这个插件会执行代码（hooks 或自带 MCP server）：只在信任来源时启用。",
                "This plugin runs code (hooks or bundled MCP servers). Only enable it if you trust the source.",
              )}
            </span>
          </p>
        )}

        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {[
            [t("技能", "Skills"), skills],
            [t("命令", "Commands"), details.inspect.commands],
            ["Hooks", hooks],
            [t("MCP server", "MCP servers"), mcp],
          ].map(([label, n]) => (
            <div key={String(label)} className="rounded-lg border border-line bg-panel px-2.5 py-1.5">
              <div className="text-[10px] text-faint">{label}</div>
              <div className="text-[13px] text-ink">{n}</div>
            </div>
          ))}
        </div>

        {details.inspect.dir && (
          <div className="break-all rounded-lg border border-line bg-panel px-2.5 py-1.5 font-mono text-[10px] text-faint">
            {details.inspect.dir}
          </div>
        )}

        {loadingDetails && <p className="text-[11px] text-muted">{t("读取中…", "Loading…")}</p>}

        {details.details.text ? (
          // 自动换行而不是横向滚动：这是给人读的清单，右侧被切掉一半最容易误会成「显示不全」。
          <pre className="dsh-scroll max-h-80 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words rounded-lg border border-line bg-canvas p-2 font-mono text-[10.5px] leading-relaxed text-ink">
            {details.details.text}
          </pre>
        ) : (
          <p className="text-[11px] leading-relaxed text-muted">
            {details.inspect.found
              ? t(
                  "还没安装：以下是清单文件里能看到的内容；完整清单（含 token 成本）要装完才能读。",
                  "Not installed yet: this comes from the manifest on disk. The full inventory (with token cost) is only available after install.",
                )
              : t(
                  "读不到这个插件的清单文件（市场缓存里没有对应目录），也没安装过，所以只能先装上再在详情里看组件清单。",
                  "No manifest found for this plugin (its marketplace cache has no matching directory) and it is not installed, so the inventory only shows up after installing.",
                )}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || (scope === "project" && !cwd)}
            onClick={() => void install(details.id, "", entry?.scope ?? scope)}
          >
            {entry ? t("重新安装", "Reinstall") : t("安装", "Install")}
          </Button>
          {entry && (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setEnabled(entry.id, entry.scope, !entry.enabled)}>
                {entry.enabled ? t("停用", "Disable") : t("启用", "Enable")}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void update(entry.id, entry.scope)}>
                {t("更新", "Update")}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void confirmUninstall(entry)} icon={<IconTrash size={12} />}>
                {t("卸载", "Uninstall")}
              </Button>
            </>
          )}
        </div>

        {details.error && !details.details.text && (
          // 加个前缀，否则单独一句 `exit status 1` 看着像程序出错，而不是「没装所以读不到」。
          <p className="break-words text-[10.5px] text-faint">
            {t("`claude plugin details` 的返回：", "`claude plugin details` returned: ")}
            {details.error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-[12rem]">
          <h3 className="text-[13px] font-medium text-ink">{t("插件", "Plugins")}</h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
            {t(
              "由 claude 自己管理（面板只是驱动 `claude plugin`）。插件能执行命令或起进程，装之前先看详情里的组件清单。",
              "Managed by claude itself — this panel drives `claude plugin`. Plugins can run commands or spawn processes, so check the component inventory first.",
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || (!data.supported && !error)}
            onClick={() => void refreshAvailable()}
            icon={<IconRefresh size={12} />}
          >
            {t("刷新可用插件", "Refresh available")}
          </Button>
        </div>
      </div>

      {/* 只有「探测到不支持」才说版本不支持：读取失败会落在下面的 error 上，
          混为一谈会让用户以为该去升级 claude，其实是刚才那一次请求挂了。 */}
      {!loaded && !error && (
        <p className="rounded-lg border border-line bg-panel-strong px-2.5 py-2 text-[11px] text-muted">
          {t("读取插件状态…", "Loading plugin state…")}
        </p>
      )}
      {loaded && !data.supported && !error && (
        <p className="rounded-lg border border-line bg-panel-strong px-2.5 py-2 text-[11px] leading-relaxed text-muted">
          {data.reason || t("当前 claude 版本不支持 plugin 子命令。", "This claude version has no plugin subcommand.")}
        </p>
      )}
      {data.supported && data.reason && !error && (
        <p className="rounded-lg border border-line bg-panel-strong px-2.5 py-2 text-[11px] leading-relaxed text-warn">
          {data.reason}
        </p>
      )}

      {error && (
        <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-danger/40 bg-danger/5 px-2.5 py-2 text-[11px] leading-relaxed text-danger">
          <span className="min-w-0 break-words">{error}</span>
          <Button size="sm" variant="ghost" onClick={() => void load(cwd)} icon={<IconRefresh size={12} />}>
            {t("重试", "Retry")}
          </Button>
        </div>
      )}

      {job && (
        <div
          className={`rounded-lg border px-2.5 py-2 text-[11px] leading-relaxed ${
            job.phase === "error" ? "border-danger/40 text-danger" : "border-line text-muted"
          }`}
        >
          <div className="flex items-start gap-1.5">
            {job.phase === "error" ? <IconAlert size={12} className="mt-0.5 shrink-0" /> : <IconCheck size={12} className="mt-0.5 shrink-0" />}
            <span className="min-w-0 break-words">
              {job.phase === "running"
                ? `${jobLabel(job, t).running}${job.target ? ` · ${job.target}` : ""}…`
                : job.phase === "error"
                  ? `${jobLabel(job, t).running}失败：${job.error ?? ""}`
                  : `${jobLabel(job, t).done}${job.target ? ` · ${job.target}` : ""}`}
            </span>
          </div>
        </div>
      )}

      <div>
        <h4 className="text-[12px] font-medium text-ink">{t("已安装", "Installed")}</h4>
        {installed.length === 0 ? (
          loaded && <p className="mt-1 text-[11px] text-muted">{t("还没有安装任何插件。", "No plugins installed yet.")}</p>
        ) : (
          <ul className="mt-1.5 space-y-1.5">
            {installed.map((p) => (
              <li key={`${p.scope}:${p.id}`} className="rounded-lg border border-line bg-panel px-2.5 py-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[12px] text-ink">{p.id}</span>
                      <span className="rounded bg-panel-strong px-1 py-0.5 text-[10px] text-muted">{p.version || "?"}</span>
                      <span className="rounded bg-panel-strong px-1 py-0.5 text-[10px] text-muted">
                        {p.scope === "project" ? t("项目级", "project") : p.scope === "local" ? t("本地", "local") : t("用户级", "user")}
                      </span>
                      {!p.enabled && (
                        <span className="rounded bg-panel-strong px-1 py-0.5 text-[10px] text-warn">{t("已停用", "disabled")}</span>
                      )}
                      {p.has_mcp_servers && (
                        <span className="rounded bg-panel-strong px-1 py-0.5 text-[10px] text-warn">
                          {t("自带 MCP server", "bundles MCP servers")}
                        </span>
                      )}
                    </div>
                    {p.project_path && (
                      <div className="mt-0.5 truncate font-mono text-[10.5px] text-faint">{p.project_path}</div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void openDetails(p.id)}>
                      {t("详情", "Details")}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setEnabled(p.id, p.scope, !p.enabled)}>
                      {p.enabled ? t("停用", "Disable") : t("启用", "Enable")}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void update(p.id, p.scope)}>
                      {t("更新", "Update")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void confirmUninstall(p)}
                      icon={<IconTrash size={12} />}
                      aria-label={t("卸载", "Uninstall")}
                    >
                      {""}
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="text-[12px] font-medium text-ink">{t("市场（marketplace）", "Marketplaces")}</h4>
        <p className="mt-0.5 text-[10.5px] leading-relaxed text-faint">
          {t(
            "可以填 owner/repo（自动补成 https）或 https 地址。SSH 形式不被接受：claude 的 HOME 里通常没有 known_hosts，必然报 host key 校验失败。",
            "Use owner/repo (auto-expanded to https) or an https URL. SSH forms are rejected: the claude HOME usually has no known_hosts, so they always fail host-key checks.",
          )}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <input
            {...NO_AUTOFILL}
            className="min-w-[12rem] flex-1 rounded-lg border border-line-strong bg-canvas px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-faint focus-visible:border-brand/60"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="anthropics/claude-code"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !data.supported || !source.trim()}
            onClick={() => {
              void marketplace("add", { source: source.trim() }).then(() => setSource(""));
            }}
            icon={<IconPlus size={12} />}
          >
            {t("添加市场", "Add")}
          </Button>
        </div>
        {data.marketplaces.length > 0 && (
          <ul className="mt-1.5 space-y-1">
            {data.marketplaces.map((m) => (
              <li key={m.name} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-panel px-2.5 py-1.5">
                <div className="min-w-0">
                  <span className="font-mono text-[12px] text-ink">{m.name}</span>
                  <span className="ml-1.5 text-[10.5px] text-muted">{m.source}</span>
                  {m.install_location && (
                    <div className="truncate font-mono text-[10px] text-faint">{m.install_location}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void marketplace("update", { name: m.name })}>
                    {t("更新", "Update")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={async () => {
                      const ok = await askConfirm({
                        title: t(`移除市场「${m.name}」？`, `Remove marketplace "${m.name}"?`),
                        message: t(
                          "只删掉这个市场目录与它的注册信息，已安装的插件不受影响（但之后无法从这里更新）。",
                          "Only the marketplace checkout and its registration are removed; installed plugins stay, but can no longer be updated from it.",
                        ),
                        danger: true,
                        confirmText: t("移除", "Remove"),
                      });
                      if (ok) await marketplace("remove", { name: m.name });
                    }}
                    icon={<IconTrash size={12} />}
                    aria-label={t("移除市场", "Remove marketplace")}
                  >
                    {""}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted">{t("安装作用域", "Install scope")}</span>
          <Select
            ariaLabel={t("安装作用域", "Install scope")}
            value={scope}
            onChange={setScope}
            options={SCOPE_OPTIONS.map((o) => ({ value: o.value, label: t(o.label, o.value === "user" ? "User (all projects)" : "Project (this workspace)") }))}
            disabled={!cwd && scope === "project"}
          />
          {scope === "project" && !cwd && (
            <span className="text-[10.5px] text-warn">{t("先选一个工作区才能装到项目级", "Pick a workspace to install at project scope")}</span>
          )}
        </div>
      </div>

      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-[12px] font-medium text-ink">
            {t("可安装", "Available")}
            {availableTotal > 0 && (
              <span className="ml-1.5 font-normal text-faint">
                {/* 过滤生效时给「命中 / 总数」，否则用户会以为列表没刷新全。 */}
                {avail.query.trim() || avail.market || avail.hideInstalled
                  ? t(`${avail.matched} / ${availableTotal} 个`, `${avail.matched} of ${availableTotal}`)
                  : t(`${availableTotal} 个`, `${availableTotal} total`)}
                {installedIds.size > 0 && t(` · 已装 ${installedIds.size}`, ` · ${installedIds.size} installed`)}
              </span>
            )}
          </h4>
          {data.available_at && (
            <span className="text-[10px] text-faint">
              {t("刷新于", "refreshed")} {new Date(data.available_at).toLocaleString()}
            </span>
          )}
        </div>
        {data.available_note && <p className="mt-0.5 text-[10.5px] text-warn">{data.available_note}</p>}

        {availableTotal === 0 ? (
          loaded && (
            <p className="mt-1 text-[11px] text-muted">
              {running && job?.kind === "refresh"
                ? t(
                    "正在读取插件目录（首次要联网抓一次，可能要几十秒）…",
                    "Loading the plugin catalog (the first fetch needs network and may take a while)…",
                  )
                : t(
                    "还没读到插件目录。点右上「刷新可用插件」读一次，之后会缓存在本地，重进不必再等。",
                    "No catalog yet. Use “Refresh available” once; it is cached locally afterwards.",
                  )}
            </p>
          )
        ) : (
          <>
            {/* 目录可能有几千条（官方市场实测 3743）：过滤与分页都在服务端，这里只拿一页。 */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <label className="relative min-w-[10rem] flex-1">
                <IconSearch size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
                <input
                  {...NO_AUTOFILL}
                  className="w-full rounded-lg border border-line-strong bg-canvas py-1.5 pl-7 pr-2.5 text-[12px] text-ink outline-none placeholder:text-faint focus-visible:border-brand/60"
                  value={avail.query}
                  onChange={(e) => setAvailQuery(e.target.value)}
                  placeholder={t("搜索插件名或说明", "Search plugins")}
                />
              </label>
              {data.marketplaces.length > 1 && (
                <Select
                  ariaLabel={t("按市场筛选", "Filter by marketplace")}
                  value={avail.market}
                  onChange={setAvailMarket}
                  options={[
                    { value: "", label: t("全部市场", "All marketplaces") },
                    ...data.marketplaces.map((m) => ({ value: m.name, label: m.name })),
                  ]}
                />
              )}
              <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted">
                <input
                  {...NO_AUTOFILL}
                  type="checkbox"
                  className="accent-[var(--c-brand)]"
                  checked={avail.hideInstalled}
                  onChange={(e) => setAvailHideInstalled(e.target.checked)}
                />
                {t("只看未安装", "Hide installed")}
              </label>
            </div>

            {avail.items.length === 0 ? (
              <p className="mt-2 text-[11px] text-muted">
                {avail.loading
                  ? t("读取中…", "Loading…")
                  : avail.query.trim()
                    ? t(`没有匹配「${avail.query.trim()}」的插件。`, `No plugins match “${avail.query.trim()}”.`)
                    : t("这个条件下没有插件。", "No plugins under this filter.")}
              </p>
            ) : (
              <ul className="mt-1.5 space-y-1">
                {avail.items.map((item) => {
                  const target = installTarget === item.plugin_id && installMarket === item.marketplace;
                  const already = installedIds.has(item.plugin_id);
                  return (
                    <li key={item.plugin_id} className="rounded-lg border border-line bg-panel px-2.5 py-1.5">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <span className="font-mono text-[12px] text-ink">{item.name}</span>
                          {already && (
                            <span className="ml-1.5 rounded bg-panel-strong px-1 py-0.5 text-[10px] text-muted">
                              {t("已安装", "installed")}
                            </span>
                          )}
                          <div className="mt-0.5 text-[10.5px] leading-relaxed text-muted">{item.description}</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void openDetails(item.plugin_id)}>
                            {t("详情", "Details")}
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy || (scope === "project" && !cwd)}
                            onClick={() => {
                              setInstallTarget(item.plugin_id);
                              setInstallMarket(item.marketplace);
                              void doInstall(item.plugin_id, item.marketplace);
                            }}
                          >
                            {already
                              ? t("重新安装", "Reinstall")
                              : target && running
                                ? t("安装中…", "Installing…")
                                : t("安装", "Install")}
                          </Button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {avail.items.length < avail.matched && (
              <div className="mt-1.5">
                <Button size="sm" variant="ghost" disabled={avail.loading} onClick={() => void showMoreAvailable()}>
                  {avail.loading
                    ? t("读取中…", "Loading…")
                    : t(`显示更多（还剩 ${avail.matched - avail.items.length} 个）`, `Show more (${avail.matched - avail.items.length} left)`)}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <p className="text-[10.5px] leading-relaxed text-faint">
        {t(
          "插件在会话启动时加载：装、停用、更新之后要重开会话才生效。状态文件在 claude 的 HOME 下（上面显示的位置），不在本应用的数据目录。",
          "Plugins load at session start: reopen the conversation after installing, disabling or updating. Their state lives under claude's HOME (shown above), not this app's data directory.",
        )}
      </p>


      {error && (
        <button type="button" className="text-[10.5px] text-muted underline" onClick={() => setError(null)}>
          {t("清除提示", "Dismiss")}
        </button>
      )}
    </div>
  );
}
