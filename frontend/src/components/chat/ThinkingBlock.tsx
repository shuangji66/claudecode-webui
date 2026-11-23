import { Collapsible } from "../common/Collapsible";
import { IconSpark } from "../common/Icons";
import { useT } from "../../lib/i18n";

/**
 * 流式摘要取「**最后一个已完成段落的首行**」（对齐 DSH `ReasoningRow` 的
 * `latestCompletedParagraphFirstLine`）。
 *
 * 以前取的是「最后一行的末尾 200 字」：那一行永远在变（模型正在写它），而且常常
 * 截在词/句中间，读起来是半截话；更糟的是它每帧都改文本，界面上跟着抖。
 * 段落是模型自己划定的语义单元——空行分段落，一个段落的首行是**稳定**的标题，
 * 写完就不再动。流式期间还没写完第一段时退回已收到的首行，不至于一片空白。
 */
function latestParagraphFirstLine(text: string): string {
  let summary = "";
  let paragraphStart = 0;
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g;
  while (true) {
    const nextParagraph = separator.exec(text);
    const paragraphEnd =
      nextParagraph === null ? text.length : nextParagraph.index + nextParagraph[0].indexOf("\n");
    const newline = text.indexOf("\n", paragraphStart);
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim();
      if (candidate !== "") summary = candidate;
    }
    if (nextParagraph === null) return summary;
    paragraphStart = nextParagraph.index + nextParagraph[0].length;
  }
}

/**
 * 思考块：一行摘要（思考首行）＋ 点开看全文，默认收起。
 *
 * **它自己不管收起时机**：整轮过程什么时候收进轮首那一行，是 `TurnCollapse` 的事。
 * 以前这里还有个 `live` 参数，回答一出现就把块重挂回收起态；改成轮级收起之后，
 * 那属于重复折叠，已经删掉。
 *
 * 摘要是**最后一段的首行正文**，正文全是空白时才退回字数。`normalize` 已经把纯空白的
 * thinking 挡在外面（上游会在工具调用之间发一个 `" "`），这里再兜一层：摘要退回字数时
 * 点开只会看到一个空格，那种行不该长得像「有内容」。
 *
 * **流式期间摘要跟着最后一个已完成段落走**（`summaryStreaming`）：单行 nowrap，
 * 溢出的处理全交给 CSS（见 `Collapsible` 的 `SummaryTail`），**不写 `scrollLeft`**
 * ——那会每帧读一次几何，拖累滚动。已结束的块退回**首行**：那是这一段思考的标题，
 * 读它的开头（与 DSH 的 `running ? 最后段落首行 : 首行` 同一口径）。
 * **不加闪烁/呼吸动画**（前端规范只允许 StateDot 的进度环是循环动画）。
 */
export function ThinkingBlock({
  text,
  dense = false,
  streaming = false,
}: {
  text: string;
  dense?: boolean;
  streaming?: boolean;
}) {
  const t = useT();
  // 正文全空白就不画这一行：`normalize` 已经挡掉纯空白的 thinking 块（上游在工具调用
  // 之间会发 `" "`），这里再兜一层是为了「摘要退回字数」那条分支——它能显示出
  // 「思考过程 · 0 字」这种既没信息又点不动的行（截图复现过）。宁可少一行，也不要
  // 留一个空壳。
  if (!text.trim()) return null;
  const lines = text.split("\n");
  const firstLine = lines.find((line) => line.trim())?.trim() ?? "";
  const chars = t(`${text.trim().length} 字`, `${text.trim().length} chars`);
  /**
   * 流式取「最后一个已完成段落的首行」——显示的是**进展**；
   * 结束态取**首行**——那是这段思考的标题，读它的开头（与 DSH 的
   * `running ? latestCompletedParagraphFirstLine(text) : firstLine(text)` 同一口径）。
   *
   * 两者都可能在思考刚开头时为空（还没写完第一行 / 还没出现空行），退回另一个，
   * 最后才退到字数。
   */
  const summary =
    (streaming ? latestParagraphFirstLine(text) : firstLine) || firstLine || chars;
  const title = streaming ? t("正在思考", "Thinking") : t("思考过程", "Reasoning");

  return (
    <Collapsible
      title={title}
      summary={summary}
      summaryTail
      summaryStreaming={streaming}
      tone="muted"
      dense={dense}
      icon={dense ? <IconSpark size={12} /> : undefined}
    >
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-[12px] italic leading-relaxed text-muted">
        {text}
        {streaming && <span className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 rounded-sm bg-brand opacity-80" />}
      </p>
    </Collapsible>
  );
}
