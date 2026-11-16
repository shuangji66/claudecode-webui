import { useEffect, useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import type { FsListing } from "../../transport/types";
import { baseName } from "../../lib/labels";
import { authorizeFnosDir, pickFnosDir } from "../../lib/fnos";
import { useT } from "../../lib/i18n";
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
  const t = useT();
  const workspaces = useAppStore((s) => s.workspaces);
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);
  const workspaceBusy = useAppStore((s) => s.workspaceBusy);
  const browseDirs = useAppStore((s) => s.browseDirs);
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const mkdirDir = useAppStore((s) => s.mkdirDir);

  const [path, setPath] = useState("");
  const [listing, setListing] = useState<FsListing | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
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
  const busy = authorizing || workspaceBusy;
  const submit = async () => {
    if (!target) return;
    setErr(null);
    setAuthorizing(true);
    try {
      // 先请飞牛把该目录的 ACL 授予应用用户，再登记工作区：ACL 没写进去，
      // claude 起来后读写真目录会被 trim_acl 拒掉（表现为一切都没权限）。
      const verdict = await authorizeFnosDir(target);
      if (verdict.state === "denied") {
        setErr(
          verdict.reason === "cancel"
            ? t("已取消飞牛目录授权，未添加工作区。", "fnOS authorization cancelled; the directory was not added.")
            : t(`飞牛目录授权失败：${verdict.message}`, `fnOS authorization failed: ${verdict.message}`),
        );
        return;
      }
      if (verdict.state === "skipped") {
        // 不在飞牛宿主里（直连端口 / 本地开发）：按旧行为继续，不阻塞添加目录。
        console.warn("[fnos] 跳过飞牛目录授权:", verdict.reason);
      }
      if (await addWorkspace(target)) onClose();
    } finally {
      setAuthorizing(false);
    }
  };

  // 「选择飞牛目录」：用户自己挑，挑完即授权（飞牛选择器本身就是授权入口）。
  const pickFnos = async () => {
    setErr(null);
    setAuthorizing(true);
    try {
      const picked = await pickFnosDir({
        title: t("选择工作区目录", "Choose a workspace directory"),
        okText: t("添加", "Add"),
      });
      if (picked.state === "skipped") {
        setErr(t("当前不在飞牛宿主中，无法打开飞牛目录选择器；可在上方浏览目录后点「添加」。", "Not running inside fnOS, so the fnOS picker is unavailable; browse above and use Add instead."));
        return;
      }
      if (picked.state === "denied") {
        if (picked.reason === "message") setErr(t(`飞牛目录选择失败：${picked.message}`, `fnOS directory pick failed: ${picked.message}`));
        return;
      }
      if (await addWorkspace(picked.path)) onClose();
    } finally {
      setAuthorizing(false);
    }
  };

  // 「新建文件夹」：在当前浏览的目录下建一层，然后直接进去。
  const mkdir = async () => {
    const parent = (listing?.path || path).trim();
    if (!parent) return;
    const name = window.prompt(t("新建文件夹名称", "New folder name"), "");
    if (name === null) return;
    setErr(null);
    setLoading(true);
    try {
      const created = await mkdirDir(parent, name);
      await load(created);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
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
        aria-label={t("添加授权目录", "Add authorized directory")}
        className="flex h-[90dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-canvas shadow-2xl md:h-auto md:max-h-[82vh] md:max-w-2xl md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="safe-top flex items-start gap-3 border-b border-line px-4 py-3.5 md:pt-3.5">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-ink">{t("添加授权目录", "Add authorized directory")}</h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
              {t("选中后飞牛会弹窗确认目录授权；确认后该目录成为工作区，Claude 在其中读写文件并立即启动会话。", "fnOS asks you to confirm the directory authorization; once confirmed it becomes a workspace where Claude reads and writes, and a session starts immediately.")}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink" aria-label={t("关闭", "Close")}>
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
                aria-label={t("目录路径", "Directory path")}
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="flex items-center gap-1 rounded-[10px] border border-line-strong px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-panel-strong disabled:opacity-40"
            >
              <IconSearch size={14} />
              {t("前往", "Go")}
            </button>
          </form>

          {quick.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] text-faint">{t("快捷入口", "Shortcuts")}</span>
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
              <span className="text-[12px]">{t("上一级", "Parent")}</span>
              <span className="ml-auto max-w-[50%] truncate font-mono text-[10px] text-faint">{listing.parent}</span>
            </button>
          )}
          {loading && !listing && <p className="px-3 py-6 text-center text-[12px] text-muted">{t("正在读取目录…", "Reading directory…")}</p>}
          {listing && listing.entries.length === 0 && !loading && (
            <p className="px-3 py-8 text-center text-[12px] text-muted">{t("这个目录下没有子目录。", "No subdirectories here.")}</p>
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
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || loading}
              onClick={() => void pickFnos()}
              className="flex items-center gap-1.5 rounded-[10px] border border-line-strong px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-panel-strong disabled:opacity-40"
            >
              <IconFolder size={14} />
              {t("选择飞牛目录", "Choose in fnOS")}
            </button>
            <button
              type="button"
              disabled={busy || loading || !target}
              onClick={() => void mkdir()}
              className="flex items-center gap-1.5 rounded-[10px] border border-line-strong px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-panel-strong disabled:opacity-40"
            >
              <IconFolderPlus size={14} />
              {t("新建文件夹", "New folder")}
            </button>
            <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted">
              <input type="checkbox" checked={hidden} onChange={(e) => toggleHidden(e.target.checked)} className="accent-[var(--c-brand)]" />
              {t("显示隐藏目录", "Show hidden")}
            </label>
          </div>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-faint" title={target}>
              {target || t("未选择目录", "No directory selected")}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-[10px] border border-line-strong px-3.5 py-2 text-[12px] font-medium text-ink hover:bg-panel-strong"
            >
              {t("取消", "Cancel")}
            </button>
            <button
              type="button"
              disabled={!target || busy || loading}
              onClick={() => void submit()}
              className="flex shrink-0 items-center gap-1.5 rounded-[10px] bg-brand px-4 py-2 text-[12px] font-medium text-white hover:bg-brand-hover disabled:opacity-40"
            >
              <IconFolderPlus size={14} />
              {busy ? t("授权中…", "Authorizing…") : t("添加", "Add")}
            </button>
          </div>
          {workspaces.length > 0 && (
            <div className="mt-3 border-t border-line pt-2">
              <p className="mb-1 text-[10px] text-faint">{t("已授权目录", "Authorized directories")}</p>
              <div className="dsh-scroll flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
                {workspaces.map((w) => (
                  <span key={w.path} className="flex max-w-full items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[10px] text-muted">
                    <span className="max-w-[12rem] truncate" title={w.path}>
                      {w.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(t(`移除授权目录「${w.path}」？`, `Remove authorized directory "${w.path}"?`))) void removeWorkspace(w.path);
                      }}
                      className="text-faint hover:text-danger"
                      aria-label={`${t("移除", "Remove")} ${w.path}`}
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
