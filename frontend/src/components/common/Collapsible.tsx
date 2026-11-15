import { useState, type ReactNode } from "react";

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
    <div className={tone === "muted" ? "rounded-lg border border-slate-200 dark:border-slate-700" : "rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"
        aria-expanded={open}
      >
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
        <span className="truncate">{title}</span>
        {summary && <span className="ml-auto truncate text-[11px] text-slate-400">{summary}</span>}
      </button>
      {open && <div className="border-t border-slate-200 px-3 py-2 dark:border-slate-700">{children}</div>}
    </div>
  );
}
