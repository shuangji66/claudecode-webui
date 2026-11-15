import { useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import { getToken, setToken } from "../../lib/runtime";

export function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const info = useAppStore((s) => s.info);
  const [token, setTokenDraft] = useState(getToken());

  if (!open) return null;

  const rows: [string, string][] = [
    ["版本", info?.version ?? "-"],
    ["claude", `${info?.claude_bin ?? "-"} ${info?.claude_version ?? ""}`.trim()],
    ["socket", info?.socket ?? "-"],
    ["baseurl", info?.base_url || "（根路径）"],
    ["项目根", info?.projects_root ?? "-"],
    ["会话上限", String(info?.max_sessions ?? "-")],
    ["前端产物", info?.frontend ? "已内嵌" : "缺失"],
  ];

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="h-full w-80 overflow-y-auto bg-white p-4 shadow-xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">设置</h2>
          <button type="button" onClick={onClose} aria-label="关闭设置">
            ✕
          </button>
        </div>

        <dl className="mt-4 space-y-2 text-xs">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="w-20 shrink-0 text-slate-400">{k}</dt>
              <dd className="min-w-0 break-all font-mono text-slate-600 dark:text-slate-300">{v}</dd>
            </div>
          ))}
        </dl>

        {info?.auth_required && (
          <div className="mt-5">
            <label className="block text-xs font-medium text-slate-500">访问令牌</label>
            <input
              value={token}
              onChange={(e) => setTokenDraft(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            />
            <button
              type="button"
              onClick={() => {
                setToken(token.trim());
                location.reload();
              }}
              className="mt-2 w-full rounded-lg bg-blue-600 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              保存并重新加载
            </button>
          </div>
        )}

        <p className="mt-6 text-[11px] leading-relaxed text-slate-400">
          令牌只保存在浏览器 localStorage；WebSocket 因浏览器限制通过 query 参数传递。
          若经公网访问，请务必配置 CCWEB_AUTH_TOKEN 并在网关层再加一层鉴权。
        </p>
      </div>
    </div>
  );
}
