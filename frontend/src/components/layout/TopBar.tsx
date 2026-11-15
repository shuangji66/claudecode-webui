import type { InitPayload, PublicSettings, SessionInfo } from "../../transport/types";

interface Props {
  session: SessionInfo | null;
  init: InitPayload | undefined;
  settings: PublicSettings | null;
  conn: string;
  busy: boolean;
  onInterrupt: () => void;
  onPermissionMode: (m: string) => void;
  onSelectModel: (provider: string, model: string) => void;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
}

const PERMISSION_MODES = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];

export function TopBar({
  session,
  init,
  settings,
  conn,
  busy,
  onInterrupt,
  onPermissionMode,
  onSelectModel,
  onToggleSidebar,
  onOpenSettings,
}: Props) {
  const currentMode = init?.current_permission_mode ?? "default";

  // 聊天页只列「已添加的第三方模型」——CLI 固定用默认模型，不再暴露内置模型列表。
  const options = (settings?.providers ?? []).flatMap((p) =>
    (p.models ?? []).map((m) => ({ provider: p.id, model: m, label: `${m} · ${p.name || p.id}` })),
  );
  const selected = settings?.selected;
  // 注意：后端在「未选择」时返回 {provider:"", model:""} —— 这是个真值对象，
  // 直接拼成 "/" 会匹配不到任何 option，浏览器就回落到第一项，
  // 看起来像"已选中模型"，实际什么都没选。必须两个字段都非空才算选中。
  const selectedKey =
    selected && selected.provider && selected.model ? `${selected.provider}/${selected.model}` : "";

  // 会话创建时绑定的提供商与当前选择不一致 → 需要新建会话
  const mismatch = Boolean(session?.provider) && Boolean(selected?.provider) && session!.provider !== selected!.provider;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
      <button
        type="button"
        onClick={onToggleSidebar}
        className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 md:hidden dark:hover:bg-slate-800"
        aria-label="切换会话列表"
      >
        ☰
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-slate-600 dark:text-slate-300" title={session?.cwd}>
          {session?.cwd ?? "未选择会话"}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-slate-400">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              conn === "open" ? "bg-emerald-500" : conn === "closed" ? "bg-rose-500" : "bg-slate-400"
            }`}
          />
          <span>{conn === "open" ? "已连接" : conn === "closed" ? "已断开" : "连接中"}</span>
          {init?.claude_code_version && <span>CLI {init.claude_code_version}</span>}
          {session?.model && <span className="truncate">会话模型 {session.model}</span>}
        </div>
      </div>

      <label className="flex items-center gap-1 text-[11px] text-slate-500">
        模型
        <select
          value={selectedKey}
          onChange={(e) => {
            const opt = options.find((o) => `${o.provider}/${o.model}` === e.target.value);
            if (opt) onSelectModel(opt.provider, opt.model);
          }}
          className="max-w-[16rem] rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
        >
          {options.length === 0 && <option value="">未添加模型</option>}
          {options.length > 0 && !selectedKey && <option value="">未选择模型</option>}
          {options.map((o) => (
            <option key={`${o.provider}/${o.model}`} value={`${o.provider}/${o.model}`}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1 text-[11px] text-slate-500">
        权限
        <select
          value={currentMode}
          onChange={(e) => onPermissionMode(e.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
        >
          {PERMISSION_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>

      {busy && (
        <button
          type="button"
          onClick={onInterrupt}
          className="rounded-lg bg-rose-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-rose-700"
        >
          中断
        </button>
      )}
      <button
        type="button"
        onClick={onOpenSettings}
        className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
        aria-label="设置"
      >
        ⚙
      </button>

      {mismatch && (
        <div className="w-full rounded-lg bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          当前会话使用的是「{session?.provider}」，与所选模型的提供商不同。切提供商的模型需要新建会话。
        </div>
      )}
    </div>
  );
}
