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
  /** 正文还能往哪个方向滚：只有真能滚的方向才给渐隐，否则一屏放得下也会糊一条边。 */
  const body = useRef<HTMLDivElement | null>(null);
  const [fade, setFade] = useState({ top: false, bottom: false });
  // 详细模式运行中不设组级限高：卡片本来就要完整铺开；其余情况限高，避免一屏只有过程。
  const capped = !(view === "detailed" && live);

  useEffect(() => {
    if (!live) {
      setOpen(false);
      return;
    }
    if (view === "detailed" && !touched.current) setOpen(true);
  }, [live, view]);

  useEffect(() => {
    const el = body.current;
    if (!el || !open) return;
    const update = () => {
      const top = el.scrollTop > 4;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 4;
      setFade((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, [open, capped]);

  const phase = live ? "running" : "done";
  const title = groupTitle(items, phase, locale);
  const detail = view === "concise" ? "" : live ? liveDetail(items) : reasoningPreview(items);
  const Icon = ICONS[dominantCategory(items)];

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
      {/* 横向一律不滚：行内文字必须自己省略，绝不能把整组撑出横向滚动条。
          用 overflow-x-clip 而不是 hidden：hidden 会把元素变成滚动容器（y 轴被算成 auto），
          手机上又多一层能拦截触摸的滚动区。限高只在 md 以上生效，手机上展开的组
          跟页面一起滚，只有一个滚动上下文。 */}
      {open && (
        <div
          ref={body}
          className={`dsh-scroll overflow-x-clip px-1 pb-1 ${
            capped ? "md:max-h-[min(400px,50vh)] md:overflow-y-auto" : ""
          } ${view === "detailed" ? "space-y-2" : "space-y-1"} ${
            fade.top && fade.bottom ? "process-fade-both" : fade.bottom ? "process-fade-bottom" : fade.top ? "process-fade-top" : ""
          }`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
