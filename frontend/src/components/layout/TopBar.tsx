import type { InitPayload, SessionInfo } from "../../transport/types";

interface Props {
  session: SessionInfo | null;
  init: InitPayload | undefined;
  conn: string;
  busy: boolean;
  onInterrupt: () => void;
  onModel: (m: string) => void;
  onPermissionMode: (m: string) => void;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
}

const PERMISSION_MODES = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];

export function TopBar({
  session,
  init,
  conn,
  busy,
  onInterrupt,
  onModel,
  onPermissionMode,
  onToggleSidebar,
  onOpenSettings,
}: Props) {
  const models = init?.models ?? [];
  const currentMode = init?.current_permission_mode ?? "default";

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
        </div>
      </div>

      <label className="flex items-center gap-1 text-[11px] text-slate-500">
        模型
        <select
          value=""
          onChange={(e) => e.target.value && onModel(e.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
        >
          <option value="">默认</option>
          {models.map((m) => (
            <option key={m.value} value={m.value}>
              {m.displayName ?? m.value}
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
    </div>
  );
}
