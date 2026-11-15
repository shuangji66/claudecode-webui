import { useMemo, useState } from "react";
import type { PermissionPayload, PermissionSuggestion } from "../../transport/types";
import { useT } from "../../lib/i18n";
import { IconAlert, IconShield } from "../common/Icons";

export interface PermissionReply {
  allow: boolean;
  updatedInput?: unknown;
  updatedPermissions?: unknown;
  message?: string;
}

interface Props {
  perm: PermissionPayload;
  onReply: (opts: PermissionReply) => void;
}

/**
 * 工具审批面板。
 *
 * `permission_suggestions` 是后端原样透传的「可选项」，直接对应按钮：
 *   addRules → 始终允许这类调用（把规则写回设置）
 *   setMode  → 切到更宽松的权限模式
 * 这也是本项目相对 TUI 的增强点：可以把命令编辑后再放行（updatedInput）。
 */
export function PermissionPanel({ perm, onReply }: Props) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => safePretty(perm.input));
  const [editError, setEditError] = useState<string | null>(null);

  const suggestions = useMemo(() => perm.permission_suggestions ?? [], [perm.permission_suggestions]);
  const addRules = suggestions.find((s) => s.type === "addRules") as Extract<PermissionSuggestion, { type: "addRules" }> | undefined;
  const setMode = suggestions.find((s) => s.type === "setMode") as Extract<PermissionSuggestion, { type: "setMode" }> | undefined;

  const allowOnce = () => onReply({ allow: true });
  const allowForever = () => onReply({ allow: true, updatedPermissions: addRules });
  const switchMode = () => onReply({ allow: true, updatedPermissions: setMode });
  const deny = () => onReply({ allow: false, message: t("用户拒绝", "User denied") });

  const allowEdited = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : t("JSON 解析失败", "Invalid JSON"));
      return;
    }
    setEditError(null);
    onReply({ allow: true, updatedInput: parsed });
  };

  const ruleLabel =
    addRules?.rules?.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join("、") ??
    perm.tool_name;

  return (
    <div
      role="dialog"
      aria-label={t("工具调用审批", "Tool permission request")}
      className="overflow-hidden rounded-2xl border border-amber-300/70 bg-amber-50/80 shadow-soft dark:border-amber-800/60 dark:bg-amber-950/20"
    >
      <div className="flex items-center gap-2 px-3.5 pt-3 text-[13px] font-semibold text-amber-900 dark:text-amber-200">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
          <IconAlert size={15} />
        </span>
        <span>{t("需要授权：", "Permission required: ")}{perm.display_name || perm.tool_name}</span>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-amber-100/70 px-2 py-0.5 text-[10px] font-normal text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
          <IconShield size={11} />
          {t("待确认", "Pending")}
        </span>
      </div>
      {perm.description && <p className="px-3.5 pt-1 text-[11.5px] leading-relaxed text-amber-800 dark:text-amber-300">{perm.description}</p>}
      {perm.blocked_path && (
        <p className="px-3.5 pt-1 break-all font-mono text-[10.5px] text-amber-700 dark:text-amber-400">{t("路径：", "Path: ")}{perm.blocked_path}</p>
      )}

      <pre className="mx-3.5 mt-2 max-h-40 overflow-auto rounded-xl border border-amber-200/60 bg-white/70 p-2.5 font-mono text-[11px] leading-relaxed text-ink-2 dark:border-amber-900/40 dark:bg-black/20">
        {safePretty(perm.input)}
      </pre>

      {editing && (
        <div className="mx-3.5 mt-2">
          <textarea
            className="h-32 w-full rounded-xl border border-amber-300 bg-canvas p-2.5 font-mono text-[11px] outline-none dark:border-amber-800 dark:text-ink"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          {editError && <p className="mt-1 text-[11px] text-danger">{editError}</p>}
          <div className="mt-1.5 flex gap-2">
            <button type="button" onClick={allowEdited} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[11.5px] font-medium text-white hover:bg-emerald-700">
              {t("执行修改后的输入", "Run edited input")}
            </button>
            <button type="button" onClick={() => setEditing(false)} className="rounded-lg px-3 py-1.5 text-[11.5px] text-muted hover:bg-black/5">
              {t("取消编辑", "Cancel editing")}
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-amber-200/60 px-3.5 py-3 dark:border-amber-900/40">
        <button
          type="button"
          onClick={allowOnce}
          className="rounded-lg bg-ink px-3 py-1.5 text-[11.5px] font-medium text-canvas hover:opacity-90"
        >
          {t("仅此次允许", "Allow once")}
        </button>
        {addRules && (
          <button
            type="button"
            onClick={allowForever}
            className="rounded-lg bg-emerald-50 px-3 py-1.5 text-[11.5px] font-medium text-emerald-800 ring-1 ring-emerald-300 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800"
          >
            {t("始终允许", "Always allow")} {ruleLabel}
          </button>
        )}
        {setMode?.mode && !addRules && (
          <button
            type="button"
            onClick={switchMode}
            className="rounded-lg bg-sky-50 px-3 py-1.5 text-[11.5px] font-medium text-sky-800 ring-1 ring-sky-300 hover:bg-sky-100 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-800"
          >
            {t("切到", "Switch to")} {setMode.mode} {t("模式", "mode")}
          </button>
        )}
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-lg px-3 py-1.5 text-[11.5px] text-muted ring-1 ring-line-strong hover:bg-canvas hover:text-ink"
          >
            {t("编辑后运行", "Edit then run")}
          </button>
        )}
        <button
          type="button"
          onClick={deny}
          className="ml-auto rounded-lg px-3 py-1.5 text-[11.5px] font-medium text-danger ring-1 ring-rose-300 hover:bg-rose-50 dark:ring-rose-900"
        >
          {t("拒绝", "Deny")}
        </button>
      </div>
    </div>
  );
}

function safePretty(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch {
    return String(v);
  }
}
