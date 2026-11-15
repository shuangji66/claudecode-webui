import { useEffect, useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import type { FsListing } from "../../transport/types";
import { baseName } from "../../lib/labels";
import { IconChevronRight, IconClose, IconFolder, IconFolderPlus, IconSearch, IconTrash } from "../common/Icons";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * 添加授权目录：服务端目录浏览器。
 *
 * 与 DSH 的「Select Workspace Directory」一致：路径输入 + 目录列表 +
 * 「显示隐藏目录」+ 底部确认。授权成功后后端会把它设为当前工作区，
 * store 紧接着 ensure 一个 claude 会话。
 */
export function WorkspaceDialog({ open, onClose }: Props) {
  const workspaces = useAppStore((s) => s.workspaces);
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);
  const workspaceBusy = useAppStore((s) => s.workspaceBusy);
  const browseDirs = useAppStore((s) => s.browseDirs);
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);

  const [path, setPath] = useState("");
  const [listing, setListing] = useState<FsListing | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async (p: string, showHidden = hidden) => {
    setLoading(true);
    setErr(null);
    setPath(p);
    try {
      const r = await browseDirs(p, showHidden);
      setListing(r);
      setPath(r.path);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setHidden(false);
    void load(currentWorkspace || workspaceRoot || "", false);
    // 只在打开时初始化；后续输入由用户控制。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // 用户可能改了输入框但没点「前往」；提交时以输入框为准，避免
  // 把当前列表目录当成目标授权出去。
  const target = (path.trim() || listing?.path || "").trim();
  const submit = async () => {
    if (!target) return;
    const ok = await addWorkspace(target);
    if (ok) onClose();
  };

  const toggleHidden = (v: boolean) => {
    setHidden(v);
    void load(path, v);
  };

  const roots = listing?.roots ?? [];
  const quick = [...new Set([workspaceRoot, ...workspaces.map((w) => w.path), ...roots].filter(Boolean))];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/35 md:items-center md:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-label="添加授权目录"
        className="flex h-[90dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-canvas shadow-2xl md:h-auto md:max-h-[82vh] md:max-w-2xl md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="safe-top flex items-start gap-3 border-b border-line px-4 py-3.5 md:pt-3.5">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-ink">添加授权目录</h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
              授权后该目录可作为工作区，Claude 会在其中读写文件。选择后立即切换并启动会话。
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink" aria-label="关闭">
            <IconClose size={18} />
          </button>
        </div>

        <div className="border-b border-line px-4 py-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void load(path);
            }}
            className="flex items-center gap-2"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-line-strong bg-canvas px-2.5 py-1.5 focus-within:border-brand/60">
              <IconFolder size={15} className="shrink-0 text-muted" />
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/path/to/workspace"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-faint"
                aria-label="目录路径"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="flex items-center gap-1 rounded-[10px] border border-line-strong px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-panel-strong disabled:opacity-40"
            >
              <IconSearch size={14} />
              前往
            </button>
          </form>

          {quick.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] text-faint">快捷入口</span>
              {quick.slice(0, 6).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => void load(p)}
                  className={`max-w-[12rem] truncate rounded-full border px-2 py-0.5 text-[10px] ${
                    p === currentWorkspace ? "border-brand/40 bg-brand-soft text-brand" : "border-line text-muted hover:bg-panel-strong"
                  }`}
                  title={p}
                >
                  {baseName(p)}
                </button>
              ))}
            </div>
          )}

          {err && <p className="mt-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-[11px] text-danger dark:bg-rose-950/30">{err}</p>}
        </div>

        <div className="dsh-scroll min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {listing?.parent && listing.parent !== listing.path && (
            <button
              type="button"
              onClick={() => void load(listing.parent)}
              className="side-row mb-0.5 text-muted"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-panel-strong text-[13px]">..</span>
              <span className="text-[12px]">上一级</span>
              <span className="ml-auto max-w-[50%] truncate font-mono text-[10px] text-faint">{listing.parent}</span>
            </button>
          )}
          {loading && !listing && <p className="px-3 py-6 text-center text-[12px] text-muted">正在读取目录…</p>}
          {listing && listing.entries.length === 0 && !loading && (
            <p className="px-3 py-8 text-center text-[12px] text-muted">这个目录下没有子目录。</p>
          )}
          {listing?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => void load(entry.path)}
              onDoubleClick={() => void load(entry.path)}
              className="side-row text-ink-2"
              title={entry.path}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                <IconFolder size={15} />
              </span>
              <span className="truncate text-[12.5px]">{entry.name}</span>
              <IconChevronRight size={14} className="ml-auto shrink-0 text-faint" />
            </button>
          ))}
        </div>

        <div className="border-t border-line px-4 pb-[calc(env(safe-area-inset-bottom,0px)+12px)] pt-3 md:pb-3">
          <div className="mb-2 flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[11px] text-muted">
              <input type="checkbox" checked={hidden} onChange={(e) => toggleHidden(e.target.checked)} className="accent-[var(--c-brand)]" />
              显示隐藏目录
            </label>
            <span className="ml-auto max-w-[60%] truncate font-mono text-[10px] text-faint" title={target}>
              {target || "未选择目录"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-[10px] border border-line-strong px-3.5 py-2 text-[12px] font-medium text-ink hover:bg-panel-strong"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!target || workspaceBusy || loading}
              onClick={() => void submit()}
              className="ml-auto flex items-center gap-1.5 rounded-[10px] bg-ink px-4 py-2 text-[12px] font-medium text-canvas hover:opacity-90 disabled:opacity-40"
            >
              <IconFolderPlus size={14} />
              {workspaceBusy ? "授权中…" : "授权并切换"}
            </button>
          </div>
          {workspaces.length > 0 && (
            <div className="mt-3 border-t border-line pt-2">
              <p className="mb-1 text-[10px] text-faint">已授权目录</p>
              <div className="dsh-scroll flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
                {workspaces.map((w) => (
                  <span key={w.path} className="flex max-w-full items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[10px] text-muted">
                    <span className="max-w-[12rem] truncate" title={w.path}>
                      {w.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`移除授权目录「${w.path}」？`)) void removeWorkspace(w.path);
                      }}
                      className="text-faint hover:text-danger"
                      aria-label={`移除 ${w.path}`}
                    >
                      <IconTrash size={11} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
