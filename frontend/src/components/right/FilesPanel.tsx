import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { useT } from "../../lib/i18n";
import { copyText } from "../../lib/clipboard";
import { downloadFromUrl, downloadInFrame } from "../../lib/download";
import { fsDownloadUrl, rawFileUrl } from "../../lib/runtime";
import { useAppStore } from "../../store/useAppStore";
import { formatBytes, previewKind } from "../../lib/workspace";
import { useSidebarStore } from "../../store/useSidebarStore";
import type { FsEntry, FsFile } from "../../transport/types";
import { Markdown } from "../common/Markdown";
import { ZoomBar, ZoomableImage } from "../common/Zoomable";
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCode,
  IconChat,
  IconCopy,
  IconDownload,
  IconExternal,
  IconClose,
  IconEye,
  IconEyeOff,
  IconFolder,
  IconMore,
  IconRetry,
  IconSearch,
  IconType,
} from "../common/Icons";
import { FileIcon, FolderIcon } from "../common/FileIcon";
import { Menu, type MenuItem } from "../common/Menu";
import { OfficePane } from "./preview/OfficePane";
import { fnosHostAvailable, openFnosFile, openFnosFileManager, showFnosFileDetails } from "../../lib/fnos";

interface Props {
  cwd: string;
  active: boolean;
  /**
   * 正文灯箱「在右侧栏打开」透传过来的路径（由 RightSidebar 消费 store 的请求）。
   * 用 `seq` 去重：同一张图点第二次时 path 没变，effect 不该重跑。
   */
  pending?: { path: string; seq: number } | null;
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
export function FilesPanel({ cwd, active, pending = null }: Props) {
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
  const requestMention = useAppStore((s) => s.requestMention);

  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<FsFile | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState("");
  const [copied, setCopied] = useState(false);
  /** 目录/文件行的「更多」菜单（宿主里才有完整项）。 */
  const [rowMenu, setRowMenu] = useState<{ anchor: HTMLElement; entry: FsEntry } | null>(null);
  const [actionError, setActionError] = useState("");
  const requestSeq = useRef(0);

  // 文件页顶部搜索：输入防抖 300ms，新查询用 AbortController 取消上一次遍历。
  // 结果只回相对路径；目录命中可以直接在树里定位，文件命中直接进预览。
  const searchFiles = useSidebarStore((s) => s.searchFiles);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FsEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchError, setSearchError] = useState("");
  const searchSeq = useRef(0);
  /**
   * 当前 `results` 对应的是哪一次查询。
   *
   * 防抖 300ms + 请求往返期间 `results` 还是**上一次查询**的结果：这时按 Enter 会打开
   * 旧查询的第一条（用户看到的是新查询还没出结果，点下去却跳到了别处）。
   */
  const resultsQuery = useRef("");
  const searchInput = useRef<HTMLInputElement | null>(null);
  // 搜索结果的目录命中：把它的祖先逐层展开，再滚到那一行。
  const [reveal, setReveal] = useState<{ path: string; seq: number } | null>(null);
  const revealSeq = useRef(0);

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (!active || !cwd) return;
    const needle = query.trim();
    if (!needle) {
      searchSeq.current += 1;
      resultsQuery.current = "";
      setResults(null);
      setSearching(false);
      setSearchTruncated(false);
      setSearchError("");
      return;
    }
    const seq = searchSeq.current + 1;
    searchSeq.current = seq;
    const controller = new AbortController();
    setSearching(true);
    setSearchError("");
    const timer = window.setTimeout(() => {
      void searchFiles(needle, { cwd, signal: controller.signal })
        .then((listing) => {
          if (searchSeq.current !== seq) return;
          resultsQuery.current = needle;
          setResults(listing.entries ?? []);
          setSearchTruncated(Boolean(listing.truncated));
        })
        .catch((reason: unknown) => {
          if (controller.signal.aborted || searchSeq.current !== seq) return;
          setResults([]);
          setSearchError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (searchSeq.current === seq) setSearching(false);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [active, cwd, query, hidden, searchFiles]);

  useEffect(() => {
    setSelected(null);
    setFile(null);
    setFileError("");
    setActionError("");
    setRowMenu(null);
    setQuery("");
    setResults(null);
    setSearchError("");
    setSearchTruncated(false);
    setReveal(null);
    requestSeq.current += 1;
    searchSeq.current += 1;
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

  /** 按路径打开预览。树点击与正文「在右侧栏打开」共用这一段。 */
  const openPath = useCallback(async (path: string) => {
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    setSelected(path);
    setFile(null);
    setFileError("");
    setFileLoading(true);
    try {
      const next = await readFile(path);
      if (requestSeq.current !== seq) return;
      setFile(next);
    } catch (reason) {
      if (requestSeq.current !== seq) return;
      setFileError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (requestSeq.current === seq) setFileLoading(false);
    }
  }, [readFile]);

  const openFile = (entry: FsEntry) => {
    if (entry.type !== "file") return;
    void openPath(entry.path);
  };

  // 正文灯箱里点「在右侧栏打开」：由 RightSidebar 透传进来，这里只管打开。
  //
  // 请求不在本组件里订阅 store：侧栏是「先开标签、面板才挂载」的，两个组件各自
  // 消费同一个 seq 时，先挂载的那个会把请求吞掉，另一个永远等不到（曾经的表现：
  // 首次点击只开了「文件」标签，不进预览）。cwd 未就绪时**不消费**——
  // 留着等下一轮 effect，`readFile` 才不会因为「未选择工作区」白丢一次请求。
  const consumedPending = useRef(0);
  useEffect(() => {
    if (pending === null || pending.seq <= consumedPending.current) return;
    if (!cwd) return;
    consumedPending.current = pending.seq;
    void openPath(pending.path);
  }, [pending, cwd, openPath]);


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
    // 「用默认应用打开」只对文件有意义，且只有宿主能办：容器里没有桌面环境，
    // 由飞牛按扩展名挑应用（等同文件管理器里的「打开方式」）。
    if (host && entry.type === "file") {
      items.push({
        id: "open",
        label: t("用默认应用打开", "Open in default app"),
        icon: <IconExternal size={13} className="text-muted" />,
        onSelect: () => void openEntryWithApp(entry),
      });
    }
    // 「other」是软链/设备文件：引用进对话没有意义，下载也只会 400。
    if (entry.type === "file" || entry.type === "dir") {
      items.push(
        {
          id: "mention",
          label: t("引用到对话", "Reference in chat"),
          icon: <IconChat size={13} className="text-muted" />,
          onSelect: () => referenceEntry(entry),
        },
        {
          id: "download",
          label: t("下载", "Download"),
          icon: <IconDownload size={13} className="text-muted" />,
          onSelect: () => downloadEntry(entry),
        },
      );
    }
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

  /** 引用到对话：只把绝对路径交给 store，相对/绝对由输入框按会话 cwd 折算。 */
  const referenceEntry = (entry: FsEntry) => {
    requestMention(absolute(entry.path), entry.type === "dir" ? "dir" : "file");
  };

  /**
   * 下载：文件走 blob（不导航页面，WS 不会因此断线）；目录是现打包的 zip，
   * 体积不可知，交给隐藏 iframe 原生下载。
   */
  const downloadEntry = (entry: FsEntry) => {
    const url = fsDownloadUrl(cwd, entry.path);
    if (entry.type === "dir") {
      downloadInFrame(url);
      return;
    }
    void downloadFromUrl(url, entry.name).catch((reason: unknown) => {
      setActionError(
        t(
          `下载失败：${reason instanceof Error ? reason.message : String(reason)}`,
          `Download failed: ${reason instanceof Error ? reason.message : String(reason)}`,
        ),
      );
    });
  };

  /** 用默认应用打开：宿主不支持时已静默降级到「在文件夹显示」，这里只报真错误。 */
  const openEntryWithApp = async (entry: FsEntry) => {
    const r = await openFnosFile(absolute(entry.path));
    if (!r.ok) {
      setActionError(
        r.reason === "bridge"
          ? t("飞牛宿主连接不可用，请稍后重试", "The fnOS host is not responding; retry later")
          : t(`打开失败：${r.reason ?? "未知错误"}`, `Open failed: ${r.reason ?? "unknown error"}`),
      );
    }
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
  const needle = query.trim();
  const showingResults = needle !== "";

  /** 搜索结果里点目录：展开祖先把它露出来；点文件：直接进预览。 */
  const openResult = (entry: FsEntry) => {
    if (entry.type === "dir") {
      revealSeq.current += 1;
      setReveal({ path: entry.path, seq: revealSeq.current });
      setQuery("");
      return;
    }
    if (entry.type === "file") void openPath(entry.path);
  };

  return (
    // 底部安全区：右侧栏在移动端是全屏抽屉（`fixed inset-y-0 h-[100dvh]`），
    // 面板底边就是屏幕底边——文件树的最后一行会被 iPhone 的 Home Indicator 盖住。
    // 留白放在整列上而不是滚动区里：树、预览、PDF/Office 的 iframe 都是这一层
    // 之下的分支，逐个加漏一个就是一整块内容贴着屏幕底边。
    // **不按断点复位**：侧栏在 1000px 以下一律是浮层（`DOCK_MIN`），平板竖屏
    // （768px）也在这条路上，那时它照样贴着屏幕底边；桌面停靠时 env() 为 0，
    // 只剩这 8px，不影响原有布局。
    <div className="flex h-full min-h-0 flex-col pb-[calc(env(safe-area-inset-bottom,0px)+8px)]">
      <div className="flex h-[42px] shrink-0 items-center gap-1 border-b border-line px-2">
        <FolderIcon open size={14} className="ml-1 shrink-0" />
        {/* 完整工作区路径（对齐 DSH 的文件页头）：宽度不够时从**开头**省略，
            保留末尾几段——路径越长，用户越关心的是最后那几级目录。 */}
        <div className="path-start-ellipsis min-w-0 flex-1 text-[12px] font-medium text-ink" title={cwd} data-files-path>
          <span>{cwd}</span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => {
              setSearchOpen((open) => {
                if (open) setQuery("");
                return !open;
              });
            }}
            className={`rounded-md p-1.5 hover:bg-black/5 ${searchOpen ? "text-brand" : "text-muted hover:text-ink"}`}
            aria-label={searchOpen ? t("关闭搜索", "Close search") : t("搜索工作区文件", "Search workspace files")}
            aria-pressed={searchOpen}
            title={t("搜索工作区文件", "Search workspace files")}
          >
            <IconSearch size={14} />
          </button>
          <button
            type="button"
            onClick={() => void setHidden(!hidden)}
            className={`rounded-md p-1.5 hover:bg-black/5 ${hidden ? "text-brand" : "text-muted hover:text-ink"}`}
            aria-label={hidden ? t("不显示隐藏文件", "Hide hidden files") : t("显示隐藏文件", "Show hidden files")}
            aria-pressed={hidden}
            title={hidden ? t("不显示隐藏文件", "Hide hidden files") : t("显示隐藏文件", "Show hidden files")}
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

      {searchOpen && (
        <div className="flex h-[38px] shrink-0 items-center gap-1.5 border-b border-line px-2">
          <IconSearch size={13} className="shrink-0 text-faint" />
          <input
            ref={searchInput}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
                setSearchOpen(false);
              } else if (event.key === "Enter" && results && results.length > 0) {
                // 结果还挂在旧查询上（防抖 / 请求未回）：别打开一条对不上的文件。
                if (resultsQuery.current !== query.trim()) return;
                openResult(results[0]!);
              }
            }}
            placeholder={t("搜索文件名称或路径", "Search file names or paths")}
            aria-label={t("搜索工作区文件", "Search workspace files")}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-faint"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="shrink-0 rounded p-0.5 text-faint hover:bg-black/5 hover:text-ink"
              aria-label={t("清空搜索", "Clear search")}
              title={t("清空", "Clear")}
            >
              <IconClose size={12} />
            </button>
          )}
        </div>
      )}

      <div className={selected ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        {/* 搜索命中列表与文件树并列，两边都只隐藏不卸载：`TreeNode` 的展开状态在
            组件本地，卸载一次就全丢（清空搜索后用户还得把目录重新点开一遍）。 */}
        {showingResults && (
          <div className="dsh-scroll min-h-0 flex-1 overflow-y-auto px-1 py-1" data-fs-search-results>
            {searchError && (
              <div className="mx-1 mb-1 rounded-lg border border-danger/25 bg-danger/[0.06] px-2 py-1.5 text-[11px] leading-relaxed text-danger">
                {searchError}
              </div>
            )}
            {!searchError && results === null && (
              <p className="px-2 py-3 text-[11.5px] text-faint">{t("正在搜索…", "Searching…")}</p>
            )}
            {!searchError && results !== null && results.length === 0 && !searching && (
              <p className="px-2 py-3 text-[11.5px] text-faint">{t("没有匹配的文件。", "No matching files.")}</p>
            )}
            {results?.map((entry) => {
              const dir = dirName(entry.path);
              return (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => openResult(entry)}
                  title={entry.path}
                  className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-[3px] pl-2 pr-1.5 text-left transition hover:bg-black/[0.045]"
                >
                  {entry.type === "dir" ? (
                    <FolderIcon size={14} className="shrink-0" />
                  ) : (
                    <FileIcon name={entry.name} size={14} className="shrink-0" />
                  )}
                  <span className="max-w-[70%] shrink-0 truncate text-[12px] text-ink-2">{entry.name}</span>
                  {dir && <span className="min-w-0 flex-1 truncate text-[10.5px] text-faint">{dir}</span>}
                  {entry.type === "file" && entry.size ? (
                    <span className="ml-auto shrink-0 text-[10px] text-faint">{formatBytes(entry.size)}</span>
                  ) : null}
                </button>
              );
            })}
            {searchTruncated && (
              <p className="px-2 py-2 text-[10.5px] text-warn">
                {t(
                  `结果过多，仅显示前 ${results?.length ?? 0} 条。`,
                  `Too many results; showing the first ${results?.length ?? 0}.`,
                )}
              </p>
            )}
          </div>
        )}
        <div
          data-fs-tree
          className={showingResults ? "hidden" : "dsh-scroll min-h-0 flex-1 overflow-y-auto px-1 py-1"}
        >
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
              reveal={reveal}
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
          key={selected}
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
  /** 搜索结果里点中的目录：把它的祖先逐层展开，并滚到那一行。 */
  reveal: { path: string; seq: number } | null;
  onOpenFile: (entry: FsEntry) => void;
  onMenu: (event: MouseEvent<HTMLButtonElement>, entry: FsEntry) => void;
}

function TreeNode({ entry, depth, levels, loading, errors, loadDir, reveal, onOpenFile, onMenu }: TreeNodeProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const children = levels[entry.path];
  const isLoading = Boolean(loading[entry.path]);
  const error = errors[entry.path];
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    if (children === undefined && !isLoading && !error) void loadDir(entry.path);
  }, [open, children, isLoading, error, entry.path, loadDir]);

  // 搜索命中的目录：它自己与它的每一层祖先都要展开，否则定位到一个看不见的节点。
  useEffect(() => {
    if (!reveal) return;
    if (reveal.path === entry.path || reveal.path.startsWith(entry.path + "/")) setOpen(true);
  }, [reveal, entry.path]);

  // 目标行可能在祖先的目录加载完之后才挂载：挂载时滚一次，别让用户自己翻。
  useEffect(() => {
    if (!reveal || reveal.path !== entry.path) return;
    const timer = window.setTimeout(() => rowRef.current?.scrollIntoView({ block: "center" }), 16);
    return () => window.clearTimeout(timer);
  }, [reveal, entry.path, children]);

  const isDir = entry.type === "dir";
  const disabled = entry.type === "other";

  return (
    <>
      <div className="group/entry flex items-center" ref={rowRef}>
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
          className="mr-0.5 rounded p-0.5 text-muted opacity-100 transition hover:bg-black/5 hover:text-ink md:opacity-0 md:group-hover/entry:opacity-100 md:group-has-focus-visible/entry:opacity-100"
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
              reveal={reveal}
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
  // 缩放只对图片有意义；调用方用 key={path} 保证换文件时复位。
  const [zoom, setZoom] = useState(1);
  const name = baseName(path);
  const dir = dirName(path);
  const kind = previewKind(name);
  const rawUrl = rawFileUrl(cwd, path);
  // 原始字节预览只放行图片/PDF（后端白名单），其它类型点开会拿到 415，不如不摆这个入口。
  const rawAllowed = kind === "image" || kind === "pdf";
  // md / html 既能看源码又能渲染：默认都先给源码——打开一个文件时先看它到底写了
  // 什么，比直接吃一份渲染结果更安全（渲染是显式的第二下）。其余类型只有一种看法，
  // 不摆切换按钮。
  const togglable = kind === "markdown" || kind === "html";
  const [view, setView] = useState<"render" | "source">("source");
  const showSource = !togglable || view === "source";
  // Office 文件走字节 + 前端解析器（/api/fs/blob），既不进文本预览也不能当二进制占位：
  // 它的 `binary` 一定为 true，先判类型再判 binary。
  const isOffice = kind === "docx" || kind === "xlsx" || kind === "pptx";
  const textLike = !isOffice && kind !== "image" && kind !== "pdf";
  // 源码行按面板宽度折行（下面用 whitespace-pre-wrap + overflow-wrap:anywhere）：
  // 右侧栏宽度是拖出来的，窄栏里的横向滚动条基本没法用。只写 break-words 不够，
  // 它在无空格的长串（base64 / 长路径 / 长 URL）上不给断点。
  const lines = file && !file.binary && textLike ? file.content.split("\n") : [];
  const shown = lines.slice(0, MAX_PREVIEW_LINES);
  // 图片自己接管取景（滚轮缩放 + 拖动平移，见 ZoomableImage 的 pannable）：
  // 外层不能再是滚动容器，否则放大后两个轴各挂一条滚动条，而拖不动——图片那层是
  // overflow-hidden，滚动条既没用又会被误认成「这里能滚」。缩放条与滚动容器共用这一个
  // 判断（两处各写一遍条件，改一处漏一处时图片会既没有缩放条也拖不动）。
  const imageView = kind === "image" && file !== null && !loading && !error;

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
        {togglable && (
          <button
            type="button"
            onClick={() => setView((v) => (v === "render" ? "source" : "render"))}
            className="rounded-md p-1.5 text-muted hover:bg-black/5 hover:text-ink"
            aria-label={view === "source" ? t("查看渲染效果", "Show rendered view") : t("查看源码", "Show source")}
            title={view === "source" ? t("查看渲染效果", "Show rendered view") : t("查看源码", "Show source")}
            aria-pressed={view === "render"}
          >
            {view === "source" ? <IconType size={14} /> : <IconCode size={14} />}
          </button>
        )}
        <button
          type="button"
          onClick={onCopy}
          className="rounded-md p-1.5 text-muted hover:bg-black/5 hover:text-ink"
          aria-label={t("复制相对路径", "Copy relative path")}
          title={copied ? t("已复制", "Copied") : t("复制路径", "Copy path")}
        >
          <IconCopy size={14} className={copied ? "text-ok" : undefined} />
        </button>
        {rawAllowed && (
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
        )}
      </div>

      <div className={imageView ? "min-h-0 flex-1 overflow-hidden" : "dsh-scroll min-h-0 flex-1 overflow-auto"}>
        {loading && <p className="px-3 py-3 text-[11.5px] text-faint">{t("读取文件…", "Loading file…")}</p>}
        {error && (
          <div className="m-3 rounded-lg border border-danger/25 bg-danger/[0.06] px-2.5 py-2 text-[11.5px] leading-relaxed text-danger">
            {error}
          </div>
        )}
        {file && !loading && !error && (
          <>
            {isOffice ? (
              <OfficePane cwd={cwd} path={path} kind={kind} name={name} />
            ) : file.binary && kind !== "image" && kind !== "pdf" ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <FileIcon name={name} size={26} />
                <p className="text-[12px] font-medium text-ink">{t("二进制文件", "Binary file")}</p>
                <p className="text-[11px] text-muted">
                  {t(`大小 ${formatBytes(file.size)}，不支持文本预览。`, `${formatBytes(file.size)}, no text preview.`)}
                </p>
              </div>
            ) : kind === "image" ? (
              /* 内缩挂在**测量元素外面**这一层：`ZoomableImage` 用 clientWidth/clientHeight
                 量窗口（含 padding），把 `p-2` 加在它身上会让 fitSize 认为可用宽度多出
                 16px——图按那个宽度算出来，右侧就被 overflow-hidden 裁掉一截，平移上限
                 也跟着偏。以前这条内缩在非 pannable 分支的 `min-w-full p-2` 上，那正是
                 「图片总是顶着一条横向滚动条」的来源。 */
              <div className="h-full p-2">
                <ZoomableImage
                  src={rawUrl}
                  alt={name}
                  zoom={zoom}
                  pannable
                  onZoomChange={setZoom}
                  imgClassName="rounded-lg border border-line"
                />
              </div>
            ) : kind === "pdf" ? (
              <iframe src={rawUrl} title={name} className="h-full min-h-[420px] w-full border-0 bg-panel" />
            ) : kind === "markdown" && !showSource ? (
              <div className="px-3 py-3">
                <Markdown text={file.content} />
              </div>
            ) : kind === "html" && !showSource ? (
              /* 工作区里的 HTML 只在这层沙箱里跑：`sandbox=""` 同时禁掉脚本和
                 allow-same-origin，页面拿到的是一份不透明源，读不到本页的
                 localStorage（token 就在那里），也发不出同源请求。内容用已经取回的
                 文本走 srcDoc，不走 /api/fs/raw——那条路的白名单只有图片/PDF，而且
                 不该为「预览」把 text/html 变成一个同源 URL。 */
              <iframe
                sandbox=""
                srcDoc={file.content}
                title={name}
                className="h-full min-h-[420px] w-full border-0 bg-white"
              />
            ) : (
              <div className="py-1 font-mono text-[11.5px] leading-[1.55]">
                {shown.map((line, i) => (
                  <div key={i} className="flex hover:bg-black/[0.025]">
                    <span className="w-10 shrink-0 select-none pr-2 text-right text-faint">{i + 1}</span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap pr-3 text-ink-2 [overflow-wrap:anywhere]">{line || " "}</span>
                  </div>
                ))}
              </div>
            )}
            {/* `file.truncated` 说的是**文本读出来的 content 被截到 1MB**。图片 / PDF 走
                /api/fs/raw、Office 走 /api/fs/blob，三者都不读 content；二进制占位更是
                一行正文都没有。这些分支提示「仅预览前 1MB」是假的，图片那条尤其明显——
                外层已经是 overflow-hidden，挂在图下面的提示还会被裁掉，用户只看到半句
                不存在的警告。只有真的渲染了文本的才说这句。 */}
            {file.truncated && !file.binary && textLike && (
              <p className="mx-3 mb-3 mt-2 rounded-md bg-warn/10 px-2 py-1 text-[10.5px] text-warn">
                {t("文件超过 1MB，仅预览前 1MB。", "File exceeds 1MB; preview truncated.")}
              </p>
            )}
            {showSource && lines.length > MAX_PREVIEW_LINES && (
              <p className="mx-3 mb-3 mt-1 rounded-md bg-warn/10 px-2 py-1 text-[10.5px] text-warn">
                {t(`仅渲染前 ${MAX_PREVIEW_LINES} 行（共 ${lines.length} 行）。`, `Showing first ${MAX_PREVIEW_LINES} of ${lines.length} lines.`)}
              </p>
            )}
          </>
        )}
      </div>
      {imageView && <ZoomBar zoom={zoom} onChange={setZoom} />}
    </div>
  );
}
