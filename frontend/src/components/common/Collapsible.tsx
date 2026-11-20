import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { IconChevronRight } from "./Icons";

interface Props {
  title: string;
  /** 默认是否展开。 */
  defaultOpen?: boolean;
  /** 折叠时显示的摘要（右侧小字）。 */
  summary?: string;
  /**
   * 摘要跟着最新内容走（流式思考用）：超出部分溢到**左侧**并被裁掉，
   * 最新的一段始终贴着右边缘可见。
   */
  summaryTail?: boolean;
  children: ReactNode;
  tone?: "neutral" | "muted";
  /** 标题前的图标（紧凑模式下工具行与思考行共用同一套外观）。 */
  icon?: ReactNode;
  /**
   * 标题行右侧的动作（启停开关这类）。
   *
   * 它在**折叠按钮之外**：嵌进按钮里就是按钮套按钮（点一下既切换折叠又按到动作，
   * 键盘上也无法分别聚焦）。所以标题行的结构是「折叠按钮占满剩余宽度 + 动作」。
   */
  actions?: ReactNode;
  /** 紧凑模式：去掉边框、压成一行，展开后才显示内容。 */
  dense?: boolean;
}

/**
 * 流式摘要：内容贴右，超出宽度的那一段从**左侧**裁掉。
 *
 * 只靠 `justify-end` 不够——flex 的溢出方向是主轴的**末端**，在 LTR 下会从右边溢出去，
 * 结果正好把最新的那几个字裁掉。所以在这里把 `scrollLeft` 钉到最右：内容一长过容器，
 * 视口就停在末尾，最新的一段永远看得见，而且不需要任何动画（前端规范只允许 StateDot
 * 的进度环循环动）。
 */
function SummaryTail({ text, font }: { text: string; font: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  /** 内容是不是已经长过这一格了——只有溢出时左缘才该渐隐，否则首字被吃掉。 */
  const [clipped, setClipped] = useState(false);
  const pin = () => {
    const el = ref.current;
    if (!el) return;
    // `overflow-hidden` 的元素一样是滚动容器，写 scrollLeft 是合法的（不出现滚动条）。
    el.scrollLeft = el.scrollWidth;
    setClipped(el.scrollWidth - el.clientWidth > 1);
  };
  // 布局阶段就贴到末尾，避免流式增量时闪一帧「开头那段」。
  useLayoutEffect(pin, [text]);
  // 字体/侧栏宽度变化会改溢出量，尺寸变了要重新贴一次。
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ob = new ResizeObserver(pin);
    ob.observe(el);
    return () => ob.disconnect();
  }, []);
  return (
    <span
      ref={ref}
      className={`${clipped ? "summary-tail " : ""}ml-auto min-w-0 overflow-hidden whitespace-nowrap pl-3 font-normal text-faint ${font}`}
    >
      {text}
    </span>
  );
}

/** 通用折叠块：工具结果、思考过程都用它，保证默认收起、只显示一行摘要。 */
export function Collapsible({
  title,
  defaultOpen = false,
  summary,
  summaryTail = false,
  children,
  tone = "neutral",
  icon,
  actions,
  dense = false,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  /**
   * 摘要那一格。
   *
   * 普通摘要按「从头显示、右侧省略」走（`truncate`）：那是这一块的**标签**，读它的开头。
   * `summaryTail` 是流式内容的另一套语义——内容还在往后长，只有末尾是新的，
   * 所以贴到末尾、把开头溢出裁掉。
   */
  const summaryCell = (font: string) => {
    if (!summary) return null;
    return summaryTail ? (
      <SummaryTail text={summary} font={font} />
    ) : (
      <span className={`ml-auto min-w-0 truncate pl-2 font-normal text-faint ${font}`}>{summary}</span>
    );
  };

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
          {summaryCell("text-[10.5px]")}
        </button>
        {open && <div className="px-2 pb-1.5 pt-1">{children}</div>}
      </div>
    );
  }

  return (
    <div className={`overflow-hidden rounded-xl border border-line ${tone === "muted" ? "bg-panel/60" : "bg-canvas"}`}>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-[11.5px] font-medium text-muted hover:bg-panel-strong/60 hover:text-ink"
          aria-expanded={open}
        >
          <IconChevronRight size={13} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
          {icon && <span className="shrink-0">{icon}</span>}
          <span className="shrink-0 truncate">{title}</span>
          {summaryCell("text-[10px]")}
        </button>
        {/*
          右内边距只跟着动作走：没有 actions 时（工具卡片、思考块这些）按钮自己带
          `px-3`，整行悬停高亮才铺满到右边缘；无条件加 `pr-3` 会让那一整批折叠块
          右侧凭空多出 12px，悬停色也提前断在离边 12px 的地方。
        */}
        {actions && <span className="shrink-0 pr-3">{actions}</span>}
      </div>
      {open && <div className="border-t border-line px-3 py-2.5">{children}</div>}
    </div>
  );
}
