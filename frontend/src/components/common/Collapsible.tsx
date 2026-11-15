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
}

/** 通用折叠块：工具结果、思考过程都用它，保证默认收起、只显示一行摘要。 */
export function Collapsible({ title, defaultOpen = false, summary, children, tone = "neutral" }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`overflow-hidden rounded-xl border border-line ${tone === "muted" ? "bg-panel/60" : "bg-canvas"}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11.5px] font-medium text-muted hover:bg-panel-strong/60 hover:text-ink"
        aria-expanded={open}
      >
        <IconChevronRight size={13} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="truncate">{title}</span>
        {summary && <span className="ml-auto truncate text-[10px] font-normal text-faint">{summary}</span>}
      </button>
      {open && <div className="border-t border-line px-3 py-2.5">{children}</div>}
    </div>
  );
}
