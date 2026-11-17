// 「设置 → MCP」：claude 的 MCP server 配置管理。
//
// 真源是两份文件（用户级 $HOME/.claude.json、项目级 <工作区>/.mcp.json），后端
// 直接读写它们；这里只做表单与列表。
//
// 三个必须让用户看见的事实：
//   1. 改完不会热加载——MCP server 是 claude 会话启动时连接的，要重开会话；
//   2. 停用是「把配置摘到本应用自己的暂存文件」，期间外部工具看不到这条配置；
//   3. 探测只针对已保存的服务，命令写错了（PATH 里没有 npx 之类）会在这里报出来。

import { useEffect, useState } from "react";
import { NO_AUTOFILL } from "../../lib/autofill";
import { useT } from "../../lib/i18n";
import { useMcpStore } from "../../store/useMcpStore";
import type { McpScope, McpServer, McpType } from "../../transport/types";
import { formatArgs, formatPairs, parseArgs, parsePairs, summarize, validateDraft } from "../../lib/mcpForm";
import { Button } from "../common/Button";
import { Dialog } from "../common/Dialog";
import { Select } from "../common/Select";
import { askConfirm } from "../common/SystemDialogs";
import { IconAlert, IconPlus, IconRefresh, IconTrash } from "../common/Icons";
import { SearchSettings } from "./SearchSettings";

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
    existing: true,
  };
}

const inputClass =
  "w-full rounded-lg border border-line-strong bg-canvas px-2.5 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-faint focus-visible:border-brand/60";

export function McpSettings({ cwd }: { cwd: string }) {
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

  useEffect(() => {
    void load(cwd);
  }, [cwd, load]);

  const submit = async () => {
    if (!draft) return;
    // 项目级配置写在 <工作区>/.mcp.json 里，没有工作区就没地方落盘：
    // 与其让用户填完一整个表单再吃一个 400，不如现在说清楚。
    if (draft.scope === "project" && !cwd) {
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
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(draftOf(srv))}>
                {t("编辑", "Edit")}
              </Button>
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
            </span>
          </div>
          <div className="mt-1 min-w-0 truncate font-mono text-[11px] text-muted">{summarize(srv)}</div>
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
    // pr-2 给滚动条留位：macOS / 部分 webview 是覆盖式滚动条，内容会一直画到
    // 容器右边缘，右对齐的按钮与文字就会被压在滚动条下面。
    <div className="dsh-scroll min-h-0 flex-1 overflow-y-auto pb-[calc(env(safe-area-inset-bottom,0px)+20px)] pr-2">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        {/* min-w-[12rem] 而不是 min-w-0：中文可以在任意字之间断行，min-content 只有
            一个字符宽——空间不足时文字会被压成「每行两三个字」，而按钮还在同一行。
            给说明挤出一个下限，按钮才会整体折到下一行。 */}
        <div className="min-w-[12rem] flex-1">
          <h2 className="text-[15px] font-semibold text-ink">{t("MCP 服务", "MCP servers")}</h2>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted">
            {t(
              "MCP 是给 Claude 增加外部工具的方式（GitHub、数据库、浏览器…）。配置直接写进 claude 的文件，改完需要重开会话才生效。",
              "MCP adds external tools to Claude (GitHub, databases, browsers…). Entries are written into claude's own files; restart the conversation to apply.",
            )}
          </p>
        </div>
        <Button variant="primary" size="sm" icon={<IconPlus size={13} />} disabled={busy} onClick={() => setDraft({ ...EMPTY_DRAFT })}>
          {t("添加", "Add")}
        </Button>
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11.5px] text-danger dark:border-rose-900/60 dark:bg-rose-950/30">
          <IconAlert size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      <SearchSettings />

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
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <h3 className="text-[12px] font-medium text-ink">{t("项目级", "Project scope")}</h3>
          <span className="min-w-0 truncate font-mono text-[10px] text-faint" title={data.project_path}>
            {data.project_path}
          </span>
        </div>
        {cwd ? (
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

      <Dialog
        open={draft !== null}
        onClose={() => setDraft(null)}
        label={t("MCP 服务", "MCP server")}
        title={draft?.existing ? t("编辑 MCP 服务", "Edit MCP server") : t("添加 MCP 服务", "Add MCP server")}
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
                    { value: "project", label: t("项目级（仅当前工作区）", "Project (this workspace)") },
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
    </div>
  );
}
