import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  IconChevronRight,
  IconFile,
  IconFolder,
  IconGlobe,
  IconSearch,
  IconSliders,
  IconSpark,
  IconTerminal,
  IconWrench,
} from "../common/Icons";
import type { Item } from "../../lib/model";
import { useLocale, useT } from "../../lib/i18n";
import { dominantCategory, groupTitle, liveDetail, reasoningPreview, type ProcessMode, type ToolCategory } from "../../lib/process";

const ICONS: Record<ToolCategory, (props: { size?: number; className?: string }) => ReactNode> = {
  read: IconFile,
  search: IconSearch,
  write: IconFolder,
  edit: IconWrench,
  commands: IconTerminal,
  webSearch: IconGlobe,
  webFetch: IconGlobe,
  subagents: IconSpark,
  plan: IconSliders,
  tools: IconWrench,
  analysis: IconSpark,
};

/**
 * 过程组：同一轮内连续出现的思考与工具调用折成一块（口径对齐 DSH）。
 *
 * 三档只影响显示多少：
 *   - 简洁：只显示一行组头（人话摘要），不显示推理预览；
 *   - 标准：组头追加「正在做什么」或思考首行；
 *   - 详细：运行中不显示组头，直接把每一步铺开（卡片），回答一出现就收起。
 *
 * 收起时机是「完成时收起」：这一组后面一出现内容（回答、下一次调用、result），
 * 立刻折回组头。用户手动展开的组在关闭那一刻同样折回——这正是「回答结束时
 * 自动折叠思维过程」；但已经收起的历史组再点开就保持打开，不会被重渲染合上。
 */
export function ProcessGroup({
  items,
  live,
  view,
  children,
}: {
  items: Item[];
  live: boolean;
  view: ProcessMode;
  children: ReactNode;
}) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(view === "detailed" && live);
  const touched = useRef(false);

  useEffect(() => {
    if (!live) {
      setOpen(false);
      return;
    }
    if (view === "detailed" && !touched.current) setOpen(true);
  }, [live, view]);

  const phase = live ? "running" : "done";
  const title = groupTitle(items, phase, locale);
  const detail = view === "concise" ? "" : live ? liveDetail(items) : reasoningPreview(items);
  const Icon = ICONS[dominantCategory(items)];
  // 详细模式运行中不设组级限高：卡片本来就要完整铺开；其余情况限高，避免一屏只有过程。
  const capped = !(view === "detailed" && live);

  if (view === "detailed" && live) {
    return <div className="space-y-2">{children}</div>;
  }

  return (
    <div className="rounded-lg border border-line/70 bg-panel/25">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          touched.current = true;
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[11.5px] text-muted hover:bg-panel-strong/60 hover:text-ink"
      >
        <IconChevronRight size={12} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
        <Icon size={12} className="shrink-0" />
        <span className="shrink-0 font-medium text-ink-2">{title}</span>
        {detail && <span className="min-w-0 flex-1 truncate text-[10.5px] text-faint">{detail}</span>}
        {!detail && <span className="flex-1" />}
        {live && <span className="shrink-0 text-[10px] text-brand">{t("进行中", "Running")}</span>}
      </button>
      {open && (
        <div
          className={`px-1 pb-1 ${capped ? "max-h-[min(400px,50vh)] overflow-y-auto dsh-scroll" : ""} ${
            view === "detailed" ? "space-y-2" : "space-y-1"
          }`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
