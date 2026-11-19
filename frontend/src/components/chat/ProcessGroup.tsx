import { useState, type ReactNode } from "react";
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
import { useLocale } from "../../lib/i18n";
import { dominantCategory, groupTitle, type ToolCategory } from "../../lib/process";

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
 * 过程组：同一轮内连续出现的思考与工具调用折成一行（「简洁」档专用）。
 *
 * **这里只负责组级开合，不再管收起时机**：整轮过程什么时候收进轮首那一行，由
 * `MessageList` 的 `TurnCollapse` 按「收起时机」统一决定（见 `lib/viewMode` 的
 * `collapseTiming`）。两层折叠各管一件事，别再把它们搅在一起——
 * 以前组级也按 `live` 自动收起，结果一轮里几个组各自开合，正文被切得零零碎碎。
 *
 * 组默认收起，点一下看每一步。
 */
export function ProcessGroup({ items, children }: { items: Item[]; children: ReactNode }) {
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const title = groupTitle(items, "done", locale);
  const Icon = ICONS[dominantCategory(items)];

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[11.5px] text-muted hover:bg-panel-strong/60 hover:text-ink"
      >
        <IconChevronRight size={12} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
        <Icon size={12} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-ink-2">{title}</span>
      </button>
      {/* 横向一律不滚：行内文字必须自己省略，绝不能把整组撑出横向滚动条。
          用 overflow-x-clip 而不是 hidden：hidden 会把元素变成滚动容器（y 轴被算成 auto），
          手机上又多一层能拦截触摸的滚动区。 */}
      {open && (
        <div className="dsh-scroll overflow-x-clip px-1 pb-1 md:max-h-[min(400px,50vh)] md:overflow-y-auto">
          <div className="space-y-1">{children}</div>
        </div>
      )}
    </div>
  );
}
