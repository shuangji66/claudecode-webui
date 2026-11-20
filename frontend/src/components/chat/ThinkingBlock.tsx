import { Collapsible } from "../common/Collapsible";
import { IconSpark } from "../common/Icons";
import { useT } from "../../lib/i18n";

/**
 * 流式摘要最多保留尾部这么多字符：一行摘要铺满屏幕也就一百多个字符，
 * 多留的都是被 `overflow-hidden` 裁掉的宽度。
 */
const SUMMARY_TAIL_CHARS = 200;

/**
 * 思考块：一行摘要（思考首行）＋ 点开看全文，默认收起。
 *
 * **它自己不管收起时机**：整轮过程什么时候收进轮首那一行，是 `TurnCollapse` 的事。
 * 以前这里还有个 `live` 参数，回答一出现就把块重挂回收起态；改成轮级收起之后，
 * 那属于重复折叠，已经删掉。
 *
 * 摘要是**首行正文**，正文全是空白时才退回字数。`normalize` 已经把纯空白的 thinking
 * 挡在外面（上游会在工具调用之间发一个 `" "`），这里再兜一层：摘要退回字数时点开
 * 只会看到一个空格，那种行不该长得像「有内容」。
 *
 * **还在想的时候摘要跟着最新的字走**（`streaming`）：取最后一行，由 `Collapsible` 的
 * `summaryTail` 贴到末尾（开头溢出被裁掉）。首行是开头，模型一旦写完第一句它就不动了——
 * 流式期间那一行停在原地，看起来像「滚到左边尽头就卡住」，后面想了什么都不显示。
 * 已结束的块仍取首行（那是这一段思考的标题，读它的开头）。**不加闪烁/呼吸动画**
 * （前端规范只允许 StateDot 的进度环是循环动画）。
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
  const lines = text.split("\n").filter((line) => line.trim());
  const firstLine = lines[0]?.trim() ?? "";
  const chars = t(`${text.trim().length} 字`, `${text.trim().length} chars`);
  // 流式取末尾：思考常常是一整段没有换行的长文，只留尾部这么多字符就够铺满一行。
  // 不切成尾部的话，那个 `whitespace-nowrap` 的 span 会跟着思考一起长到几万像素宽，
  // 每个增量都要重新布局一次。
  const tail = (lines[lines.length - 1]?.trim() ?? "").slice(-SUMMARY_TAIL_CHARS);
  const summary = (streaming ? tail : firstLine) || chars;
  const title = streaming ? t("正在思考", "Thinking") : t("思考过程", "Reasoning");

  return (
    <Collapsible
      title={title}
      summary={summary}
      summaryTail={streaming}
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
