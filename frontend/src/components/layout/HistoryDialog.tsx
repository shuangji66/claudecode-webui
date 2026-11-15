import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import { relativeTime } from "../../lib/labels";
import { IconClose, IconFolder, IconHistory, IconSearch } from "../common/Icons";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * 历史记录：读 ~/.claude/projects 下各会话的 jsonl 摘要。
 *
 * 本应用暂不支持把历史转录回放进当前 claude 进程（CLI 的 --resume 需要
 * 另一套握手），所以点击条目 = 授权其目录并在那里开一个新会话；
 * 文案必须写清楚，避免用户以为能接着旧上下文聊。
 */
export function HistoryDialog({ open, onClose }: Props) {
  const history = useAppStore((s) => s.history);
  const workspaces = useAppStore((s) => s.workspaces);
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const switchWorkspace = useAppStore((s) => s.switchWorkspace);
  const [query, setQuery] = useState("");
  const [busyCwd, setBusyCwd] = useState<string | null>(null);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return history.filter(
      (h) => !q || h.title.toLowerCase().includes(q) || h.cwd.toLowerCase().includes(q),
    );
  }, [history, query]);

  if (!open) return null;

  const openInWorkspace = async (cwd: string) => {
    if (busyCwd) return;
    setBusyCwd(cwd);
    try {
      const authorized = workspaces.some((w) => cwd === w.path || cwd.startsWith(`${w.path}/`));
      if (!authorized) {
        const ok = await addWorkspace(cwd);
        if (!ok) return;
      } else {
        await switchWorkspace(cwd);
      }
      onClose();
    } finally {
      setBusyCwd(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/35 md:items-center md:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-label="历史记录"
        className="flex h-[88dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-canvas shadow-2xl md:h-auto md:max-h-[80vh] md:max-w-xl md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="safe-top flex items-center gap-2 border-b border-line px-4 py-3.5 md:pt-3.5">
          <IconHistory size={17} className="text-muted" />
          <h2 className="text-[15px] font-semibold text-ink">历史记录</h2>
          <button type="button" onClick={onClose} className="ml-auto rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink" aria-label="关闭">
            <IconClose size={18} />
          </button>
        </div>

        <div className="border-b border-line px-4 py-2.5">
          <div className="flex items-center gap-2 rounded-[10px] border border-line-strong px-2.5 py-1.5 focus-within:border-brand/60">
            <IconSearch size={14} className="text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索历史会话"
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-faint"
            />
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-faint">
            点击条目会切换到该目录并打开会话（暂不支持回放旧上下文）。未授权的目录会自动添加授权。
          </p>
        </div>

        <div className="dsh-scroll min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {rows.length === 0 && <p className="px-3 py-8 text-center text-[12px] text-muted">没有匹配的历史会话。</p>}
          {rows.map((h) => (
            <button
              key={`${h.project}/${h.id}`}
              type="button"
              disabled={Boolean(busyCwd)}
              onClick={() => void openInWorkspace(h.cwd)}
              className="side-row items-start text-left disabled:opacity-50"
              title={h.cwd}
            >
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-panel-strong text-muted">
                <IconFolder size={14} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-ink">{h.title}</span>
                <span className="mt-0.5 block truncate font-mono text-[10px] text-faint">{h.cwd}</span>
              </span>
              <span className="ml-2 shrink-0 text-right text-[10px] text-faint">
                <span className="block">{relativeTime(h.updated_at)}</span>
                <span className="block">{h.messages} 条</span>
              </span>
            </button>
          ))}
        </div>

        <div className="safe-bottom border-t border-line px-4 pt-2.5">
          <p className="text-[10px] text-faint">{busyCwd ? `正在切换到 ${busyCwd}…` : `共 ${history.length} 条历史会话`}</p>
        </div>
      </div>
    </div>
  );
}
