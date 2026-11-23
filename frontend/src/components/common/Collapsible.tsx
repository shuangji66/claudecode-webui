import { useState, type ReactNode } from "react";
import { IconChevronRight } from "./Icons";

interface Props {
  title: string;
  /** 默认是否展开。 */
  defaultOpen?: boolean;
  /** 折叠时显示的摘要（右侧小字）。 */
  summary?: string;
  /**
   * 摘要跟着最新内容走（流式思考用）。
   *
   * 摘要是单行 `nowrap`，溢出**纯靠 CSS** 处理，不写 `scrollLeft`：
   * - 非流式：`text-overflow: ellipsis`（末尾省略号，表示「这里还有」）；
   * - 流式（`summaryStreaming`）：`clip` + 右侧 `mask-image` 渐隐——文字还在长，
   *   末尾一直在变，画省略号会跟着跳。
   *
   * 不再每帧读 `scrollWidth`：那是强制同步布局，会把触摸滚动的帧挤掉（见 `SummaryTail`）。
   */
  summaryTail?: boolean;
  /** 摘要还在流式增长（决定用渐隐还是省略号），只在 `summaryTail` 下有意义。 */
  summaryStreaming?: boolean;
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
 * 流式摘要：溢出**纯靠 CSS** 裁掉。
 *
 * 以前这里每帧读 `scrollWidth` 再写 `scrollLeft`（`useLayoutEffect(pin, [text])`），
 * 那是每次流式增量各一次**强制同步布局**——整棵树要为读几何先算一遍布局，而它恰好
 * 发生在触摸滚动过程中，把 compositor 的滚动帧挤掉，手感发涩、还和贴底跟随抢
 * `scrollTop`。DSH 的做法是纯 CSS（`ReasoningRow.module.css` 的 `.summary`），我们照它：
 *
 *   - 非流式：`text-overflow: ellipsis`，末尾省略号表示「这里还有」；
 *   - 流式：`text-overflow: clip` + 右侧 `mask-image` 渐隐——文字还在长，末尾一直在变，
 *     画省略号会跟着跳；渐隐表达的是「还在继续」，不指某个具体位置。
 *
 * 两种状态都**不读任何几何、不写 `scrollLeft`**，样式在 `styles.css` 的 `.summary-tail` 里。
 *
 * **渐隐要按「可能溢出」才开**：`mask-image` 是固定 48px 的，摘要很短时它会把末尾几个
 * 字也啃掉（截图确认过：只写「短摘要」四个字，最后的「要」是半透明的，看着像渲染坏了）。
 * `text-overflow` 能自己判断溢出，`mask` 不能，而用 `scrollWidth` 判断又是我们要去掉的
 * 那件事。所以退一步用**字符数**近似：一行摘要装得下二十来个汉字，超过就按溢出处理。
 * 阈值给宽一点（宁可早开渐隐，也别让长文本硬切），代价只是短文本多显示一点渐隐。
 */
const SUMMARY_MAY_OVERFLOW_CHARS = 16;

function SummaryTail({ text, font, streaming = false }: { text: string; font: string; streaming?: boolean }) {
  // 按字符数近似「会不会溢出」，不读几何。CJK 按 1 个字算，ASCII 两个算一个宽单位：
  // 英文摘要一行能装四五十个字母，按汉字数一刀切会让英文一直提前渐隐。
  let width = 0;
  for (const ch of text) width += ch.codePointAt(0)! > 0x2e80 ? 1 : 0.5;
  const mask = streaming && width > SUMMARY_MAY_OVERFLOW_CHARS;
  return (
    <span
      data-streaming={mask || undefined}
      className={`summary-tail ml-auto min-w-0 overflow-hidden whitespace-nowrap pl-3 font-normal text-faint ${font}`}
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
  summaryStreaming = false,
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
   * `summaryTail` 是流式内容的另一套语义——内容还在往后长，末尾一直在变；
   * 流式时右侧渐隐、结束后退回省略号（见 `SummaryTail`）。
   */
  const summaryCell = (font: string) => {
    if (!summary) return null;
    return summaryTail ? (
      <SummaryTail text={summary} font={font} streaming={summaryStreaming} />
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
