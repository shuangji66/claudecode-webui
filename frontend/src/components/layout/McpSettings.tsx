// 「设置 → MCP」：claude 的 MCP server 配置管理。
//
// 真源是两份文件（用户级 $HOME/.claude.json、项目级 <工作区>/.mcp.json），后端
// 直接读写它们；这里只做表单与列表。
//
// 三个必须让用户看见的事实：
//   1. 改完不会热加载——MCP server 是 claude 会话启动时连接的，要重开会话；
//   2. 停用是「把配置摘到本应用自己的暂存文件」，期间外部工具看不到这条配置；
//   3. 探测只针对已保存的服务，命令写错了（PATH 里没有 npx 之类）会在这里报出来。
//
// 这一页**自己渲染 `PageShell`**（与模型页同一套）：页头右侧是「添加」——它是这一页
// 唯一的整体动作，而正文里的分组（内置搜索 / 内置浏览器 / 自动化任务 / 用户级 /
// 项目级）都可以长到一屏以外，钉在正文顶部等于滚下去之后要一路翻回来才能加一条。

import { useEffect, useRef, useState } from "react";
import { NO_AUTOFILL } from "../../lib/autofill";
import { useT } from "../../lib/i18n";
import { useMcpStore } from "../../store/useMcpStore";
import { useAppStore } from "../../store/useAppStore";
import { initialTarget, workspaceOptions } from "../../lib/workspaceTarget";
import type { McpScope, McpServer, McpType } from "../../transport/types";
import { formatArgs, formatPairs, parseArgs, parsePairs, summarize, validateDraft } from "../../lib/mcpForm";
import { Button } from "../common/Button";
import { Dialog } from "../common/Dialog";
import { Select } from "../common/Select";
import { askConfirm } from "../common/SystemDialogs";
import { IconAlert, IconClock, IconPlus, IconRefresh, IconTrash } from "../common/Icons";
import { Collapsible } from "../common/Collapsible";
import { PageShell } from "./FeaturePage";
import { SETTINGS_PANE_FLEX } from "./settings/SettingsSurface";
import { SearchSettings } from "./SearchSettings";
import { BrowserSettings } from "./BrowserSettings";

/** 编辑中的表单。name + scope 是标识，编辑已有项时不允许改。 */
interface Draft {
  scope: McpScope;
  name: string;
  type: McpType;
  command: string;
  args: string;
  url: string;
  env: string;
  headers: string;
  alwaysLoad: boolean;
  /** true = 编辑已有项（名字与作用域锁定）。 */
  existing: boolean;
}

const EMPTY_DRAFT: Draft = {
  scope: "user",
  name: "",
  type: "stdio",
  command: "",
  args: "",
  url: "",
  env: "",
  headers: "",
  alwaysLoad: false,
  existing: false,
};

function draftOf(srv: McpServer): Draft {
  return {
    scope: srv.scope,
    name: srv.name,
    type: srv.type,
    command: srv.command ?? "",
    args: formatArgs(srv.args),
    url: srv.url ?? "",
    env: formatPairs(srv.env),
    headers: formatPairs(srv.headers),
    alwaysLoad: srv.always_load === true,
    existing: true,
  };
}

const inputClass =
  "w-full rounded-lg border border-line-strong bg-canvas px-2.5 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-faint focus-visible:border-brand/60";

export function McpSettings({
  cwd,
  onClose,
  onOpenSidebar,
}: {
  cwd: string;
  /** 回到对话；不传时不渲染页头的关闭键（设置抽屉里嵌进来时由抽屉自己给）。 */
  onClose?: () => void;
  /** 移动端抽屉入口（见 PageShell）。 */
  onOpenSidebar?: () => void;
}) {
  const t = useT();
  const data = useMcpStore((s) => s.data);
  const probes = useMcpStore((s) => s.probes);
  const error = useMcpStore((s) => s.error);
  const busy = useMcpStore((s) => s.busy);
  const probing = useMcpStore((s) => s.probing);
  const load = useMcpStore((s) => s.load);
  const save = useMcpStore((s) => s.save);
  const remove = useMcpStore((s) => s.remove);
  const setEnabled = useMcpStore((s) => s.setEnabled);
  const probe = useMcpStore((s) => s.probe);
  const setError = useMcpStore((s) => s.setError);

  const [draft, setDraft] = useState<Draft | null>(null);
  const workspaces = useAppStore((s) => s.workspaces);

  // target 是「项目级配置写到哪个工作区」。用户一旦自己选过，就不再被
  // 上层传下来的 cwd 覆盖（否则切个对话，选好的工作区会悄悄跳走）。
  const [target, setTarget] = useState(() => initialTarget(cwd, workspaces));
  const picked = useRef(false);

  // 页面顶部的下拉与「添加/编辑」弹窗里的是同一个选择：在弹窗里换工作区，
  // 背景列表也跟着切过去，保存时写的就是用户眼前那个 .mcp.json。
  const chooseTarget = (v: string) => {
    picked.current = true;
    setTarget(v);
  };
  const options = workspaceOptions(workspaces);

  useEffect(() => {
    // 选过就尊重用户的选择；但那个工作区被移除后必须回到默认值，
    // 否则后续每个请求都会撞 400（cwd 已不在授权列表里）。
    if (picked.current && workspaces.some((w) => w.path === target)) return;
    setTarget(initialTarget(cwd, workspaces));
  }, [cwd, workspaces, target]);

  useEffect(() => {
    void load(target);
  }, [target, load]);

  const submit = async () => {
    if (!draft) return;
    // 项目级配置写在 <工作区>/.mcp.json 里，没有工作区就没地方落盘：
    // 与其让用户填完一整个表单再吃一个 400，不如现在说清楚。
    if (draft.scope === "project" && !target) {
      setError(t("先选一个工作区，才能添加项目级服务", "Pick a workspace first to add project-scope servers"));
      return;
    }
    const bad = validateDraft(draft);
    if (bad === "name") {
      setError(t("服务名只能用字母、数字、点、下划线与短横线，且不能以符号开头", "Names may only contain letters, digits, dot, underscore and dash, and cannot start with a symbol"));
      return;
    }
    if (bad === "command") {
      setError(t("stdio 类型必须填命令，例如 npx", "stdio servers need a command, e.g. npx"));
      return;
    }
    if (bad === "url") {
      setError(t("远程类型必须填 http(s) 地址", "Remote servers need an http(s) URL"));
      return;
    }
    const env = parsePairs(draft.env);
    const headers = parsePairs(draft.headers);
    if (env.invalid.length > 0 || headers.invalid.length > 0) {
      const lines = [...env.invalid, ...headers.invalid].join("、");
      setError(t(`这些行不是合法的 KEY=VALUE：${lines}`, `Not valid KEY=VALUE lines: ${lines}`));
      return;
    }
    const server: McpServer = {
      name: draft.name.trim(),
      scope: draft.scope,
      type: draft.type,
      config_path: "",
      disabled: false,
      ...(draft.alwaysLoad ? { always_load: true } : {}),
      ...(draft.type === "stdio"
        ? { command: draft.command.trim(), args: parseArgs(draft.args), env: env.pairs }
        : { url: draft.url.trim(), headers: headers.pairs }),
    };
    if (await save(server)) setDraft(null);
  };

  const confirmRemove = async (srv: McpServer) => {
    const ok = await askConfirm({
      title: t(`删除 MCP 服务「${srv.name}」？`, `Delete MCP server "${srv.name}"?`),
      message: t(
        `会从 ${srv.config_path} 里删掉这条配置，无法撤销。`,
        `This removes the entry from ${srv.config_path}. It cannot be undone.`,
      ),
      danger: true,
      confirmText: t("删除", "Delete"),
    });
    if (ok) await remove(srv.scope, srv.name);
  };

  const rows = (list: McpServer[]) =>
    list.map((srv) => {
      const key = `${srv.scope}:${srv.name}`;
      const res = probes[key];
      return (
        <div key={key} className="rounded-xl border border-line bg-panel/40 p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[12.5px] font-medium text-ink">{srv.name}</span>
            <span className="rounded-full bg-panel-strong px-1.5 py-0.5 text-[10px] text-muted">{srv.type}</span>
            {srv.builtin && (
              <span className="rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] text-brand">{t("内置", "Built-in")}</span>
            )}
            {srv.disabled && (
              <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] text-warn dark:bg-amber-950/30">
                {t("已停用", "Disabled")}
              </span>
            )}
            <span className="ml-auto flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || srv.disabled || probing === key}
                onClick={() => void probe(srv.scope, srv.name)}
                icon={<IconRefresh size={12} />}
              >
                {probing === key ? t("探测中…", "Probing…") : t("探测", "Probe")}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setEnabled(srv.scope, srv.name, srv.disabled)}>
                {srv.disabled ? t("启用", "Enable") : t("停用", "Disable")}
              </Button>
              {/* 内置服务（自动化任务的 ccweb-schedule）只留探测与启停：配置由后端每次启动
                  写回，改完下次启动又变回去、删掉下次启动又长出来。想临时关掉用「停用」——
                  那个状态留在本应用的暂存文件里，重启后保持。 */}
              {!srv.builtin && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(draftOf(srv))}>
                  {t("编辑", "Edit")}
                </Button>
              )}
              {!srv.builtin && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void confirmRemove(srv)}
                  icon={<IconTrash size={12} />}
                  aria-label={t("删除", "Delete")}
                >
                  {""}
                </Button>
              )}
            </span>
          </div>
          <div className="mt-1 min-w-0 truncate font-mono text-[11px] text-muted">
            {summarize(srv)}
            {srv.always_load && (
              <span className="ml-1.5 rounded bg-panel-strong px-1 py-0.5 align-middle text-[10px] text-muted">
                {t("常驻", "always load")}
              </span>
            )}
          </div>
          {res && (
            <div className={`mt-1 flex items-start gap-1 text-[11px] ${res.ok ? "text-muted" : "text-danger"}`}>
              {!res.ok && <IconAlert size={12} className="mt-0.5 shrink-0" />}
              <span className="min-w-0 break-words">
                {res.ok
                  ? t(
                      `连接正常${res.server_name ? ` · ${res.server_name}` : ""}${res.server_version ? ` ${res.server_version}` : ""} · ${res.latency_ms}ms`,
                      `Connected${res.server_name ? ` · ${res.server_name}` : ""}${res.server_version ? ` ${res.server_version}` : ""} · ${res.latency_ms}ms`,
                    )
                  : res.error}
              </span>
            </div>
          )}
          {srv.disabled && (
            <div className="mt-1 text-[10.5px] text-faint">
              {t("停用期间这条配置不在 claude 的配置文件里，启用后原样写回。", "While disabled the entry is removed from claude's config; enabling writes it back.")}
            </div>
          )}
        </div>
      );
    });

  return (
    <PageShell
      title="MCP"
      onClose={onClose}
      onOpenSidebar={onOpenSidebar}
      bodyClassName={SETTINGS_PANE_FLEX}
      // 「添加」放页头右侧：正文里三个分组（内置搜索 / 用户级 / 项目级）随时会长过
      // 一屏，动作钉在正文顶部就是「滚下去之后要翻回来才能加一条」。与模型页的保存
      // 同一个位置、同一个理由。
      actions={
        <Button variant="primary" size="sm" icon={<IconPlus size={13} />} disabled={busy} onClick={() => setDraft({ ...EMPTY_DRAFT })}>
          {t("添加", "Add")}
        </Button>
      }
    >
      {/* pr-2 给滚动条留位：macOS / 部分 webview 是覆盖式滚动条，内容会一直画到
          容器右边缘，右对齐的按钮与文字就会被压在滚动条下面。
          底部安全区由 `PageShell` 的 `SETTINGS_PANE_FLEX` 之外这一层自己给：
          这一页是满高 flex，最后一个分组紧贴屏幕下沿。 */}
      <div className="dsh-scroll min-h-0 flex-1 overflow-y-auto pb-[calc(env(safe-area-inset-bottom,0px)+20px)] pr-2">
        <p className="mb-3 text-[11.5px] leading-relaxed text-muted">
          {t(
            "MCP 是给 Claude 增加外部工具的方式（GitHub、数据库、浏览器…）。",
            "MCP adds external tools to Claude (GitHub, databases, browsers…).",
          )}
        </p>

        {error && (
          <div className="mb-3 flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11.5px] text-danger dark:border-rose-900/60 dark:bg-rose-950/30">
            <IconAlert size={13} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}

        <SearchSettings />
        <BrowserSettings />
        {/* 自动化任务：与上面两块同一排「内置能力」，也是一块默认收起的折叠块——
            这一排的样子必须一致（一行标题 + 摘要，点开才看内容），否则第三块像
            贴错了位置。但它只有说明：任务在侧栏的「自动化任务」页里建、在用户级
            列表里停用，所以没有 actions、没有表单。 */}
        <div className="mb-5" data-mcp-card="schedule">
          <Collapsible
            title={t("自动化任务", "Scheduled tasks")}
            icon={<IconClock size={13} />}
            summary="ccweb-schedule"
            tone="muted"
          >
            <p className="text-[11px] leading-relaxed text-muted">
              {t(
                "让模型按时间办事：说一句「每天早上 9 点提醒我」，它就落成一条任务，到点由本应用把消息发进指定的对话（新建一条，或接着某条聊）。任务在左侧栏的「自动化任务」里查看和修改，这一页不需要配。",
                "Runs work on a schedule: “remind me every day at 9” becomes a task, and the app delivers the message into a conversation when it is due (new or resumed). Tasks are managed under Scheduled tasks on the left; nothing to set up here.",
              )}
            </p>
          </Collapsible>
        </div>

        <section className="mb-4">
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <h3 className="text-[12px] font-medium text-ink">{t("用户级", "User scope")}</h3>
            <span className="min-w-0 truncate font-mono text-[10px] text-faint" title={data.user_path}>
              {data.user_path}
            </span>
          </div>
          <div className="space-y-2">
            {data.user.length > 0 ? rows(data.user) : <p className="text-[11.5px] text-faint">{t("还没有用户级服务。", "No user-scope servers yet.")}</p>}
          </div>
        </section>

        <section>
          <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <h3 className="shrink-0 text-[12px] font-medium text-ink">{t("项目级", "Project scope")}</h3>
            {/* 工作区在这里选，不跟着「当前对话在哪」：多工作区时经常要把一条
                服务加到别的目录的 .mcp.json 里。 */}
            {options.length > 0 && (
              <div className="w-[12rem] max-w-full min-w-0">
                <Select ariaLabel={t("工作区", "Workspace")} value={target} onChange={chooseTarget} options={options} />
              </div>
            )}
            <span className="ml-auto min-w-0 max-w-full truncate font-mono text-[10px] text-faint" title={data.project_path}>
              {data.project_path}
            </span>
          </div>
          {target ? (
            <div className="space-y-2">
              {data.project.length > 0 ? rows(data.project) : <p className="text-[11.5px] text-faint">{t("这个工作区还没有项目级服务。", "No project-scope servers for this workspace.")}</p>}
            </div>
          ) : (
            <p className="text-[11.5px] text-faint">{t("先选一个工作区，才能读写项目级配置。", "Pick a workspace first to read and write project-scope config.")}</p>
          )}
        </section>

        <p className="mt-4 text-[10.5px] leading-relaxed text-faint">
          {t(
            "注：条目按 claude 的格式写入。stdio 走本地命令（npx / node / uvx…），http 与 sse 走远端地址。服务名会成为工具前缀 mcp__<名字>__<工具>。",
            "Entries use claude's own format: stdio runs a local command (npx / node / uvx…), http and sse connect to a URL. The name becomes the tool prefix mcp__<name>__<tool>.",
          )}
        </p>
      </div>

      <Dialog
        open={draft !== null}
        onClose={() => setDraft(null)}
        label={t("MCP 服务", "MCP server")}
        title={draft?.existing ? t("编辑 MCP 服务", "Edit MCP server") : t("添加 MCP 服务", "Add MCP server")}
        // Dialog 的 body 默认没有内边距（列表类弹窗自己给 px-2）；这里是表单，
        // 必须和标题/底栏的 px-4 对齐，否则手机上面板铺满宽度时输入框会贴到边框上。
        bodyClassName="px-4 py-3.5"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setDraft(null)}>{t("取消", "Cancel")}</Button>
            <Button variant="primary" disabled={busy} onClick={() => void submit()}>
              {t("保存", "Save")}
            </Button>
          </div>
        }
      >
        {draft && (
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-[11.5px] text-muted">{t("名称", "Name")}</span>
              <input
                className={inputClass}
                value={draft.name}
                disabled={draft.existing}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="github"
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="mb-1 block text-[11.5px] text-muted">{t("作用域", "Scope")}</span>
                <Select
                  ariaLabel={t("作用域", "Scope")}
                  value={draft.scope}
                  disabled={draft.existing}
                  onChange={(v) => setDraft({ ...draft, scope: v as McpScope })}
                  options={[
                    { value: "user", label: t("用户级（所有项目）", "User (all projects)") },
                    { value: "project", label: t("项目级（所选工作区）", "Project (picked workspace)") },
                  ]}
                />
              </div>
              <div>
                <span className="mb-1 block text-[11.5px] text-muted">{t("类型", "Type")}</span>
                <Select
                  ariaLabel={t("类型", "Type")}
                  value={draft.type}
                  onChange={(v) => setDraft({ ...draft, type: v as McpType })}
                  options={[
                    { value: "stdio", label: "stdio" },
                    { value: "http", label: "http" },
                    { value: "sse", label: "sse" },
                  ]}
                />
              </div>
            </div>

            <label className="flex items-start gap-2 rounded-lg border border-line bg-canvas px-2.5 py-2">
              <input
                {...NO_AUTOFILL}
                type="checkbox"
                className="mt-0.5 accent-[var(--c-brand)]"
                checked={draft.alwaysLoad}
                onChange={(e) => setDraft({ ...draft, alwaysLoad: e.target.checked })}
              />
              <span className="min-w-0">
                <span className="block text-[12px] text-ink">{t("工具常驻工具表", "Always load tools")}</span>
                <span className="block text-[10.5px] leading-relaxed text-faint">
                  {t(
                    "不勾选时 claude 会把工具延迟到 ToolSearch 后面：模型只看到工具名、看不到描述，往往意识不到该用它。让模型主动想起来用的服务（搜索、抓取）建议勾上。",
                    "Unchecked, claude defers the tools behind ToolSearch: the model sees only names, not descriptions, and often never reaches for them. Enable it for tools the model should think of on its own (search, fetch).",
                  )}
                </span>
              </span>
            </label>

            {draft.scope === "project" && (
              <div>
                <span className="mb-1 block text-[11.5px] text-muted">{t("工作区", "Workspace")}</span>
                {options.length > 0 ? (
                  <Select
                    ariaLabel={t("目标工作区", "Target workspace")}
                    value={target}
                    // 编辑已有条目时不能换工作区：那等于「搬走」一条现成配置，
                    // 界面没有这个语义（要换目录就删了重加）。
                    disabled={draft.existing}
                    onChange={chooseTarget}
                    options={options}
                  />
                ) : (
                  <p className="text-[11.5px] text-faint">{t("还没有授权目录。", "No workspaces yet.")}</p>
                )}
                <p className="mt-1 truncate font-mono text-[10.5px] text-faint" title={target ? `${target}/.mcp.json` : ""}>
                  {target
                    ? t(`写入 ${target}/.mcp.json`, `Writes to ${target}/.mcp.json`)
                    : t("先选一个工作区", "Pick a workspace first")}
                </p>
              </div>
            )}

            {draft.type === "stdio" ? (
              <>
                <label className="block">
                  <span className="mb-1 block text-[11.5px] text-muted">{t("命令", "Command")}</span>
                  <input className={inputClass} value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} placeholder="npx" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11.5px] text-muted">{t("参数（一行一个）", "Args (one per line)")}</span>
                  <textarea
                    className={`${inputClass} h-20 resize-y font-mono`}
                    value={draft.args}
                    onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                    placeholder={"-y\n@modelcontextprotocol/server-github"}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11.5px] text-muted">{t("环境变量（KEY=VALUE，一行一个）", "Environment (KEY=VALUE, one per line)")}</span>
                  <textarea
                    {...NO_AUTOFILL}
                    className={`${inputClass} h-16 resize-y font-mono`}
                    value={draft.env}
                    onChange={(e) => setDraft({ ...draft, env: e.target.value })}
                    placeholder="GITHUB_TOKEN=ghp_..."
                  />
                </label>
              </>
            ) : (
              <>
                <label className="block">
                  <span className="mb-1 block text-[11.5px] text-muted">{t("地址", "URL")}</span>
                  <input
                    className={inputClass}
                    value={draft.url}
                    onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                    placeholder="https://example.com/mcp"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11.5px] text-muted">{t("请求头（KEY=VALUE，一行一个）", "Headers (KEY=VALUE, one per line)")}</span>
                  <textarea
                    {...NO_AUTOFILL}
                    className={`${inputClass} h-16 resize-y font-mono`}
                    value={draft.headers}
                    onChange={(e) => setDraft({ ...draft, headers: e.target.value })}
                    placeholder="Authorization=Bearer ..."
                  />
                </label>
              </>
            )}

            <p className="text-[10.5px] leading-relaxed text-faint">
              {t(
                "保存后需要重开会话才会连接（MCP server 在会话启动时建立）。probe 只能验证能不能连上，不代表工具一定可用。",
                "Reopen the conversation afterwards — MCP servers connect at session start. A successful probe only proves connectivity.",
              )}
            </p>
          </div>
        )}
      </Dialog>
    </PageShell>
  );
}
