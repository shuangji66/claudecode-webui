// 输入框的 `@` 补全菜单：工作区文件/目录 + 「从飞牛选择」。
//
// 纯展示：候选、高亮、面包屑都由 `useMention` 给，键盘也由它仲裁（焦点始终留在
// textarea 里，这样 Enter/Tab 才能被统一拦截）。这里只负责画出来并把点击转回去。
// 行的形状对齐 DSH 的 `@` 菜单：图标 + 名字 +（不在当前层时）父目录，目录行右侧给
// 一个 Tab 提示——Tab 是进入目录，Enter 才是引用这个目录。

import { FolderIcon, FileIcon } from "../common/FileIcon";
import { IconFolder } from "../common/Icons";
import { useT } from "../../lib/i18n";
import type { MentionCrumb } from "../../lib/mention";
import type { MentionRow } from "./useMention";

interface Props {
  rows: MentionRow[];
  crumbs: MentionCrumb[];
  highlight: number;
  loading: boolean;
  error: string | null;
  onHover: (index: number) => void;
  onPick: (index: number) => void;
  onDrill: (index: number) => void;
  onCrumb: (query: string) => void;
}

/** 点行时不抢焦点：焦点一旦离开 textarea，键盘仲裁就断了。 */
const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();

export function MentionMenu({
  rows,
  crumbs,
  highlight,
  loading,
  error,
  onHover,
  onPick,
  onDrill,
  onCrumb,
}: Props) {
  const t = useT();
  // 一条文件候选都没有（也没有飞牛那一行）时才是「没有匹配」：飞牛行本身算一条内容。
  const noFiles = rows.every((row) => row.kind === "fnos");
  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-line bg-canvas shadow-soft">
      {crumbs.length > 0 && (
        <div className="flex flex-wrap items-center gap-0.5 border-b border-line px-2 py-1 text-[10.5px] text-muted">
          <button
            type="button"
            onClick={() => onCrumb("")}
            onMouseDown={keepFocus}
            className="rounded px-1 py-0.5 hover:bg-panel-strong hover:text-ink"
          >
            {t("工作区", "Workspace")}
          </button>
          {crumbs.map((crumb) => (
            <span key={crumb.query} className="flex items-center gap-0.5">
              <span className="text-faint">/</span>
              <button
                type="button"
                onClick={() => onCrumb(crumb.query)}
                onMouseDown={keepFocus}
                className="max-w-[10rem] truncate rounded px-1 py-0.5 hover:bg-panel-strong hover:text-ink"
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </div>
      )}

      <ul className="max-h-56 overflow-y-auto p-1" aria-label={t("文件引用候选", "File reference candidates")}>
        {!loading && noFiles && (
          <li className="px-2 py-1.5 text-[11px] text-faint">{t("没有匹配的文件", "No matching files")}</li>
        )}
        {rows.map((row, index) => {
          const active = index === highlight;
          return (
            <li key={row.kind === "fnos" ? "fnos" : row.path}>
              <div
                onMouseEnter={() => onHover(index)}
                className={`flex items-center gap-1 rounded-lg ${active ? "bg-panel-strong" : ""}`}
              >
                <button
                  type="button"
                  onClick={() => onPick(index)}
                  onMouseDown={keepFocus}
                  aria-current={active ? "true" : undefined}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[12px] text-ink"
                  title={row.kind === "fnos" ? undefined : row.path}
                >
                  {row.kind === "fnos" ? (
                    <IconFolder size={13} className="shrink-0 text-muted" />
                  ) : row.kind === "dir" ? (
                    <FolderIcon size={13} className="shrink-0" />
                  ) : (
                    <FileIcon name={row.name} size={13} className="shrink-0" />
                  )}
                  <span className="min-w-0 truncate font-mono">
                    {row.kind === "fnos" ? t("从飞牛选择…", "Choose in fnOS…") : row.name}
                    {row.kind === "dir" ? "/" : ""}
                  </span>
                  {row.kind === "fnos" ? (
                    <span className="ml-auto shrink-0 text-[10px] text-faint">
                      {t("飞牛文件选择器", "fnOS file picker")}
                    </span>
                  ) : (
                    row.location !== undefined && (
                      <span className="ml-auto min-w-0 max-w-[45%] truncate text-[10px] text-faint">{row.location}</span>
                    )
                  )}
                </button>
                {row.kind === "dir" && (
                  <button
                    type="button"
                    onClick={() => onDrill(index)}
                    onMouseDown={keepFocus}
                    aria-label={t(`进入 ${row.name}`, `Open ${row.name}`)}
                    title={t("进入这个目录（Tab）", "Open this folder (Tab)")}
                    className="mr-1 shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted hover:bg-canvas hover:text-ink"
                  >
                    <kbd className="font-sans">Tab</kbd>
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center gap-2 border-t border-line px-2 py-1 text-[10px] text-faint">
        {error ? (
          <span className="min-w-0 truncate text-danger">
            {t(`补全失败：${error}`, `Completion failed: ${error}`)}
          </span>
        ) : (
          <span className="min-w-0 truncate">
            {loading
              ? t("加载中…", "Loading…")
              : t("↑↓ 选择 · Tab 进入目录 · Enter 引用 · Esc 关闭", "↑↓ select · Tab opens a folder · Enter references · Esc closes")}
          </span>
        )}
      </div>
    </div>
  );
}
