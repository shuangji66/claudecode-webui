import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useT } from "../../lib/i18n";
import { copyText } from "../../lib/clipboard";
import { rawFileUrl } from "../../lib/runtime";
import { formatBytes, previewKind } from "../../lib/workspace";
import { useSidebarStore } from "../../store/useSidebarStore";
import type { FsEntry, FsFile } from "../../transport/types";
import { Markdown } from "../common/Markdown";
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconExternal,
  IconEye,
  IconEyeOff,
  IconFolder,
  IconMore,
  IconRetry,
} from "../common/Icons";
import { FileIcon, FolderIcon } from "../common/FileIcon";
import { Menu, type MenuItem } from "../common/Menu";
import { fnosHostAvailable, openFnosFileManager, showFnosFileDetails } from "../../lib/fnos";

interface Props {
  cwd: string;
  active: boolean;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function dirName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : "";
}

/** 工作区文件树 + 简单预览。树按目录懒加载；预览替换树的显示但保留展开状态。 */
export function FilesPanel({ cwd, active }: Props) {
  const t = useT();
  const levels = useSidebarStore((s) => s.levels);
  const loading = useSidebarStore((s) => s.loading);
  const truncated = useSidebarStore((s) => s.truncated);
  const errors = useSidebarStore((s) => s.errors);
  const hidden = useSidebarStore((s) => s.hidden);
  const loadDir = useSidebarStore((s) => s.loadDir);
  const reloadTree = useSidebarStore((s) => s.reloadTree);
  const setHidden = useSidebarStore((s) => s.setHidden);
  const readFile = useSidebarStore((s) => s.readFile);

  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<FsFile | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState("");
  const [copied, setCopied] = useState(false);
  /** 目录/文件行的「更多」菜单（宿主里才有完整项）。 */
  const [rowMenu, setRowMenu] = useState<{ anchor: HTMLElement; entry: FsEntry } | null>(null);
  const [actionError, setActionError] = useState("");
  const requestSeq = useRef(0);

  useEffect(() => {
    setSelected(null);
    setFile(null);
    setFileError("");
    setActionError("");
    setRowMenu(null);
    requestSeq.current += 1;
  }, [cwd]);

  // 菜单里的失败提示几秒后自己消失，别一直挂在面板上。
  useEffect(() => {
    if (!actionError) return;
    const timer = window.setTimeout(() => setActionError(""), 4000);
    return () => window.clearTimeout(timer);
  }, [actionError]);

  // 侧栏首次显示 / 重开时补一次根目录；setCwd 已加载过则这里什么也不做。
  useEffect(() => {
    if (active && cwd && levels[""] === undefined && !loading[""] && !errors[""]) void loadDir("");
  }, [active, cwd, levels, loading, errors, loadDir]);

  const openFile = async (entry: FsEntry) => {
    if (entry.type !== "file") return;
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    setSelected(entry.path);
    setFile(null);
    setFileError("");
    setFileLoading(true);
    try {
      const next = await readFile(entry.path);
      if (requestSeq.current !== seq) return;
      setFile(next);
    } catch (reason) {
      if (requestSeq.current !== seq) return;
      setFileError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (requestSeq.current === seq) setFileLoading(false);
    }
  };

  const back = () => {
    requestSeq.current += 1;
    setSelected(null);
    setFile(null);
    setFileError("");
    setFileLoading(false);
  };

  /** 相对路径 → NAS 绝对路径（宿主 API 只认绝对路径）。 */
  const absolute = (rel: string) => (rel ? `${cwd.replace(/\/+$/, "")}/${rel}` : cwd);

  const entryMenuItems = (entry: FsEntry): MenuItem[] => {
    const host = fnosHostAvailable();
    const items: MenuItem[] = [];
    if (host) {
      items.push({
        id: "reveal",
        label: t("在文件夹显示", "Show in folder"),
        icon: <IconFolder size={13} className="text-muted" />,
        onSelect: () => void revealEntry(entry),
      });
    }
    items.push({
      id: "copy",
      label: entry.type === "dir" ? t("复制文件夹路径", "Copy folder path") : t("复制文件路径", "Copy file path"),
      icon: <IconCopy size={13} className="text-muted" />,
      onSelect: () => void copyEntryPath(entry),
    });
    if (host) {
      items.push({
        id: "details",
        label: t("文件详情", "File details"),
        icon: <IconEye size={13} className="text-muted" />,
        onSelect: () => void showEntryDetails(entry),
      });
    }
    return items;
  };

  const revealEntry = async (entry: FsEntry) => {
    // 文件是「在它所在的文件夹里显示」，目录则直接打开自己。
    const target = entry.type === "dir" ? absolute(entry.path) : absolute(dirName(entry.path));
    const r = await openFnosFileManager(target);
    if (!r.ok) {
      setActionError(
        r.reason === "bridge"
          ? t("飞牛宿主连接不可用，请稍后重试", "The fnOS host is not responding; retry later")
          : t(`打开失败：${r.reason ?? "未知错误"}`, `Open failed: ${r.reason ?? "unknown error"}`),
      );
    }
  };

  const copyEntryPath = async (entry: FsEntry) => {
    if (!(await copyText(absolute(entry.path)))) setActionError(t("复制失败", "Copy failed"));
  };

  const showEntryDetails = async (entry: FsEntry) => {
    const r = await showFnosFileDetails([absolute(entry.path)]);
    if (!r.ok) {
      setActionError(
        r.reason === "bridge"
          ? t("飞牛宿主连接不可用，请稍后重试", "The fnOS host is not responding; retry later")
          : t(`查看详情失败：${r.reason ?? "未知错误"}`, `Details failed: ${r.reason ?? "unknown error"}`),
      );
    }
  };

  const copyPath = async () => {
    if (!selected) return;
    const ok = await copyText(selected);
    setCopied(ok);
    if (ok) window.setTimeout(() => setCopied(false), 1200);
  };

  const rootEntries = levels[""] ?? [];
  const rootLoading = Boolean(loading[""]);
  const rootLabel = baseName(cwd);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[42px] shrink-0 items-center gap-1 border-b border-line px-2">
        <FolderIcon open size={14} className="ml-1 shrink-0" />
        <span className="min-w-0 truncate text-[12px] font-medium text-ink" title={cwd}>
          {rootLabel}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => void setHidden(!hidden)}
            className={`rounded-md p-1.5 hover:bg-black/5 ${hidden ? "text-brand" : "text-muted hover:text-ink"}`}
            aria-label={hidden ? t("隐藏点文件", "Hide dotfiles") : t("显示点文件", "Show dotfiles")}
            aria-pressed={hidden}
            title={hidden ? t("隐藏点文件", "Hide dotfiles") : t("显示点文件", "Show dotfiles")}
          >
            {hidden ? <IconEye size={14} /> : <IconEyeOff size={14} />}
          </button>
          <button
            type="button"
            onClick={() => void reloadTree()}
            className="rounded-md p-1.5 text-muted hover:bg-black/5 hover:text-ink"
            aria-label={t("刷新文件树", "Refresh files")}
            title={t("刷新", "Refresh")}
          >
            <IconRetry size={14} />
          </button>
        </div>
      </div>

      <div className={selected ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        <div className="dsh-scroll min-h-0 flex-1 overflow-y-auto px-1 py-1">
          {errors[""] && (
            <div className="mx-1 mb-1 rounded-lg border border-danger/25 bg-danger/[0.06] px-2 py-1.5 text-[11px] leading-relaxed text-danger">
              {errors[""]}
            </div>
          )}
          {rootLoading && rootEntries.length === 0 && (
            <p className="px-2 py-3 text-[11.5px] text-faint">{t("正在读取目录…", "Loading…")}</p>
          )}
          {!rootLoading && rootEntries.length === 0 && !errors[""] && (
            <p className="px-2 py-3 text-[11.5px] text-faint">{t("目录为空", "Empty directory")}</p>
          )}
          {rootEntries.map((entry) => (
            <TreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              loading={loading}
              levels={levels}
              errors={errors}
              loadDir={loadDir}
              onOpenFile={openFile}
              onMenu={(e, entry) => setRowMenu({ anchor: e.currentTarget, entry })}
            />
          ))}
          {truncated[""] && (
            <p className="px-2 py-2 text-[10.5px] text-warn">{t("目录项过多，仅显示前一部分。", "Directory truncated.")}</p>
          )}
        </div>
      </div>

      <Menu
        open={Boolean(rowMenu)}
        anchor={rowMenu?.anchor ?? null}
        onClose={() => setRowMenu(null)}
        width={200}
        align="end"
        items={rowMenu ? entryMenuItems(rowMenu.entry) : []}
      />

      {actionError && (
        <p className="shrink-0 border-b border-line px-2 py-1 text-[10.5px] text-danger">{actionError}</p>
      )}

      {selected && (
        <FilePreview
          cwd={cwd}
          path={selected}
          file={file}
          loading={fileLoading}
          error={fileError}
          copied={copied}
          onBack={back}
          onCopy={() => void copyPath()}
        />
      )}
    </div>
  );
}

interface TreeNodeProps {
  entry: FsEntry;
  depth: number;
  levels: Record<string, FsEntry[]>;
  loading: Record<string, boolean>;
  errors: Record<string, string>;
  loadDir: (path: string, force?: boolean) => Promise<void>;
  onOpenFile: (entry: FsEntry) => void;
  onMenu: (event: MouseEvent<HTMLButtonElement>, entry: FsEntry) => void;
}

function TreeNode({ entry, depth, levels, loading, errors, loadDir, onOpenFile, onMenu }: TreeNodeProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const children = levels[entry.path];
  const isLoading = Boolean(loading[entry.path]);
  const error = errors[entry.path];

  useEffect(() => {
    if (!open) return;
    if (children === undefined && !isLoading && !error) void loadDir(entry.path);
  }, [open, children, isLoading, error, entry.path, loadDir]);

  const isDir = entry.type === "dir";
  const disabled = entry.type === "other";

  return (
    <>
      <div className="group/entry flex items-center">
      <button
        type="button"
        onClick={() => {
          if (isDir) setOpen((v) => !v);
          else if (entry.type === "file") onOpenFile(entry);
        }}
        disabled={disabled}
        title={entry.path}
        className="flex min-w-0 flex-1 items-center gap-1 rounded-md py-[3px] pr-1.5 text-left text-ink-2 transition hover:bg-black/[0.045] disabled:cursor-not-allowed disabled:opacity-40"
        style={{ paddingLeft: 4 + depth * 13 }}
      >
        <span className="flex w-3.5 shrink-0 items-center justify-center text-faint">
          {isDir ? open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} /> : null}
        </span>
        {isDir ? (
          <FolderIcon open={open} size={14} className="shrink-0" />
        ) : (
          <FileIcon name={entry.name} size={14} className="shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate text-[12px]">{entry.name}</span>
        {isDir && isLoading && <span className="shrink-0 text-[10px] text-faint">…</span>}
        {entry.type === "file" && entry.size !== undefined && (
          <span className="shrink-0 text-[10px] text-faint">{formatBytes(entry.size)}</span>
        )}
        {disabled && <span className="shrink-0 text-[9.5px] text-faint">{t("链接", "link")}</span>}
      </button>
      {!disabled && (
        <button
          type="button"
          onClick={(e) => onMenu(e, entry)}
          className="mr-0.5 rounded p-0.5 text-muted opacity-100 transition hover:bg-black/5 hover:text-ink md:opacity-0 md:group-hover/entry:opacity-100 md:focus:opacity-100"
          aria-label={`${t("更多操作", "More actions")} ${entry.name}`}
          aria-haspopup="menu"
          title={t("更多", "More")}
        >
          <IconMore size={13} />
        </button>
      )}
      </div>
      {isDir && open && (
        <div>
          {children?.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              levels={levels}
              loading={loading}
              errors={errors}
              loadDir={loadDir}
              onOpenFile={onOpenFile}
              onMenu={onMenu}
            />
          ))}
          {children === undefined && isLoading && (
            <p className="py-1 text-[10.5px] text-faint" style={{ paddingLeft: 22 + depth * 13 }}>
              {t("读取中…", "Loading…")}
            </p>
          )}
          {children?.length === 0 && (
            <p className="py-1 text-[10.5px] text-faint" style={{ paddingLeft: 22 + depth * 13 }}>
              {t("空目录", "Empty")}
            </p>
          )}
          {error && (
            <p className="py-1 pr-2 text-[10.5px] leading-relaxed text-danger" style={{ paddingLeft: 22 + depth * 13 }}>
              {error}
            </p>
          )}
        </div>
      )}
    </>
  );
}

interface PreviewProps {
  cwd: string;
  path: string;
  file: FsFile | null;
  loading: boolean;
  error: string;
  copied: boolean;
  onBack: () => void;
  onCopy: () => void;
}

const MAX_PREVIEW_LINES = 3000;

function FilePreview({ cwd, path, file, loading, error, copied, onBack, onCopy }: PreviewProps) {
  const t = useT();
  const name = baseName(path);
  const dir = dirName(path);
  const kind = previewKind(name);
  const rawUrl = rawFileUrl(cwd, path);
  const lines = file && !file.binary && kind === "text" ? file.content.split("\n") : [];
  const shown = lines.slice(0, MAX_PREVIEW_LINES);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[42px] shrink-0 items-center gap-1 border-b border-line px-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md p-1.5 text-muted hover:bg-black/5 hover:text-ink"
          aria-label={t("返回文件树", "Back to files")}
          title={t("返回", "Back")}
        >
          <IconChevronLeft size={15} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-medium text-ink" title={path}>
            {name}
          </p>
          <p className="truncate text-[10px] text-faint" title={path}>
            {dir ? `${dir}/` : ""}
            {file ? ` · ${formatBytes(file.size)}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="rounded-md p-1.5 text-muted hover:bg-black/5 hover:text-ink"
          aria-label={t("复制相对路径", "Copy relative path")}
          title={copied ? t("已复制", "Copied") : t("复制路径", "Copy path")}
        >
          <IconCopy size={14} className={copied ? "text-ok" : undefined} />
        </button>
        <a
          href={rawUrl}
          target="_blank"
          rel="noreferrer"
          className="rounded-md p-1.5 text-muted hover:bg-black/5 hover:text-ink"
          aria-label={t("新窗口打开", "Open in new tab")}
          title={t("新窗口打开", "Open in new tab")}
        >
          <IconExternal size={14} />
        </a>
      </div>

      <div className="dsh-scroll min-h-0 flex-1 overflow-auto">
        {loading && <p className="px-3 py-3 text-[11.5px] text-faint">{t("读取文件…", "Loading file…")}</p>}
        {error && (
          <div className="m-3 rounded-lg border border-danger/25 bg-danger/[0.06] px-2.5 py-2 text-[11.5px] leading-relaxed text-danger">
            {error}
          </div>
        )}
        {file && !loading && !error && (
          <>
            {file.binary && kind !== "image" && kind !== "pdf" ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <FileIcon name={name} size={26} />
                <p className="text-[12px] font-medium text-ink">{t("二进制文件", "Binary file")}</p>
                <p className="text-[11px] text-muted">
                  {t(`大小 ${formatBytes(file.size)}，不支持文本预览。`, `${formatBytes(file.size)}, no text preview.`)}
                </p>
                <a href={rawUrl} target="_blank" rel="noreferrer" className="text-[11.5px] font-medium text-brand hover:underline">
                  {t("新窗口打开", "Open in new tab")}
                </a>
              </div>
            ) : kind === "image" ? (
              <div className="flex min-h-full items-center justify-center p-3">
                <img src={rawUrl} alt={name} className="max-w-full rounded-lg border border-line" />
              </div>
            ) : kind === "pdf" ? (
              <iframe src={rawUrl} title={name} className="h-full min-h-[420px] w-full border-0 bg-panel" />
            ) : kind === "markdown" ? (
              <div className="px-3 py-3">
                <Markdown text={file.content} />
              </div>
            ) : (
              <div className="min-w-max py-1 font-mono text-[11.5px] leading-[1.55]">
                {shown.map((line, i) => (
                  <div key={i} className="flex hover:bg-black/[0.025]">
                    <span className="w-10 shrink-0 select-none pr-2 text-right text-faint">{i + 1}</span>
                    <span className="whitespace-pre pr-3 text-ink-2">{line || " "}</span>
                  </div>
                ))}
              </div>
            )}
            {file.truncated && (
              <p className="mx-3 mb-3 mt-2 rounded-md bg-warn/10 px-2 py-1 text-[10.5px] text-warn">
                {t("文件超过 1MB，仅预览前 1MB。", "File exceeds 1MB; preview truncated.")}
              </p>
            )}
            {kind === "text" && lines.length > MAX_PREVIEW_LINES && (
              <p className="mx-3 mb-3 mt-1 rounded-md bg-warn/10 px-2 py-1 text-[10.5px] text-warn">
                {t(`仅渲染前 ${MAX_PREVIEW_LINES} 行（共 ${lines.length} 行）。`, `Showing first ${MAX_PREVIEW_LINES} of ${lines.length} lines.`)}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
