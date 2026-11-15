import { useMemo, useState } from "react";
import { useAppStore } from "../../store/useAppStore";

export function Sidebar({ onClose }: { onClose?: () => void }) {
  const sessions = useAppStore((s) => s.sessions);
  const history = useAppStore((s) => s.history);
  const projects = useAppStore((s) => s.projects);
  const activeId = useAppStore((s) => s.activeId);
  const states = useAppStore((s) => s.states);
  const setActive = useAppStore((s) => s.setActive);
  const createSession = useAppStore((s) => s.createSession);
  const closeSession = useAppStore((s) => s.closeSession);

  const [target, setTarget] = useState("");
  const [customPath, setCustomPath] = useState("");
  const [creating, setCreating] = useState(false);

  const projectOptions = useMemo(() => projects, [projects]);

  const create = async () => {
    const cwd = customPath.trim() || target;
    if (!cwd) return;
    setCreating(true);
    await createSession(cwd);
    setCreating(false);
    onClose?.();
  };

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900">
      <div className="border-b border-slate-200 p-3 dark:border-slate-700">
        <h1 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Claude Code 控制台</h1>
        <p className="mt-0.5 text-[11px] text-slate-400">通过 stream-json 协议驱动本地 CLI</p>
      </div>

      <div className="border-b border-slate-200 p-3 dark:border-slate-700">
        <label className="block text-[11px] font-medium text-slate-500">新建会话</label>
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
        >
          <option value="">选择项目目录…</option>
          {projectOptions.map((p) => (
            <option key={p.path} value={p.path}>
              {p.name}
              {p.has_git ? " (git)" : ""}
            </option>
          ))}
        </select>
        <input
          value={customPath}
          onChange={(e) => setCustomPath(e.target.value)}
          placeholder="或直接填绝对路径"
          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
        />
        <button
          type="button"
          onClick={create}
          disabled={creating || (!target && !customPath.trim())}
          className="mt-2 w-full rounded-lg bg-blue-600 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {creating ? "启动中…" : "启动 Claude"}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <h2 className="px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">运行中</h2>
        {sessions.length === 0 && <p className="px-1 py-2 text-xs text-slate-400">暂无运行中的会话</p>}
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`group mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${
              s.id === activeId ? "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200" : "hover:bg-slate-100 dark:hover:bg-slate-800"
            }`}
          >
            <button type="button" onClick={() => setActive(s.id)} className="min-w-0 flex-1 text-left">
              <div className="truncate font-medium">{baseName(s.cwd)}</div>
              <div className="flex items-center gap-1 text-[10px] text-slate-400">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    (states[s.id] ?? s.state) === "busy" ? "bg-amber-500" : "bg-emerald-500"
                  }`}
                />
                <span className="truncate font-mono">{s.cwd}</span>
              </div>
            </button>
            <button
              type="button"
              onClick={() => closeSession(s.id)}
              className="opacity-0 transition group-hover:opacity-100"
              aria-label={`关闭 ${s.cwd}`}
              title="关闭会话（会终止进程）"
            >
              ✕
            </button>
          </div>
        ))}

        <h2 className="mt-3 px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">历史</h2>
        {history.length === 0 && <p className="px-1 py-2 text-xs text-slate-400">暂无历史记录</p>}
        {history.slice(0, 50).map((h) => (
          <button
            key={`${h.project}/${h.id}`}
            type="button"
            onClick={() => setTarget(h.cwd)}
            className="mb-1 block w-full rounded-lg px-2 py-1.5 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-800"
            title={h.cwd}
          >
            <div className="truncate text-slate-700 dark:text-slate-300">{h.title}</div>
            <div className="truncate text-[10px] text-slate-400">
              {h.messages} 条 · {new Date(h.updated_at).toLocaleString()}
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}

function baseName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
