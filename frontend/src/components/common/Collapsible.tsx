import { useState, type ReactNode } from "react";
import { IconChevronRight } from "./Icons";

interface Props {
  title: string;
  /** 默认是否展开。 */
  defaultOpen?: boolean;
  /** 折叠时显示的摘要（右侧小字）。 */
  summary?: string;
  children: ReactNode;
  tone?: "neutral" | "muted";
  /** 标题前的图标（紧凑模式下工具行与思考行共用同一套外观）。 */
  icon?: ReactNode;
  /** 紧凑模式：去掉边框、压成一行，展开后才显示内容。 */
  dense?: boolean;
}

/** 通用折叠块：工具结果、思考过程都用它，保证默认收起、只显示一行摘要。 */
export function Collapsible({ title, defaultOpen = false, summary, children, tone = "neutral", icon, dense = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  if (dense) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[11.5px] text-muted hover:bg-panel-strong/60 hover:text-ink"
          aria-expanded={open}
        >
          <IconChevronRight size={12} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
          {icon && <span className="shrink-0">{icon}</span>}
          <span className="shrink-0 truncate">{title}</span>
          {summary && (
            <span className="ml-auto min-w-0 truncate pl-2 text-[10.5px] font-normal text-faint">{summary}</span>
          )}
        </button>
        {open && <div className="px-2 pb-1.5 pt-1">{children}</div>}
      </div>
    );
  }

  return (
    <div className={`overflow-hidden rounded-xl border border-line ${tone === "muted" ? "bg-panel/60" : "bg-canvas"}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11.5px] font-medium text-muted hover:bg-panel-strong/60 hover:text-ink"
        aria-expanded={open}
      >
        <IconChevronRight size={13} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        {icon && <span className="shrink-0">{icon}</span>}
        <span className="shrink-0 truncate">{title}</span>
        {summary && <span className="ml-auto min-w-0 truncate text-[10px] font-normal text-faint">{summary}</span>}
      </button>
      {open && <div className="border-t border-line px-3 py-2.5">{children}</div>}
    </div>
  );
}
