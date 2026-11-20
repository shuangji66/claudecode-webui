import { Collapsible } from "../common/Collapsible";
import { IconSpark } from "../common/Icons";
import { useT } from "../../lib/i18n";

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
 * `streaming` 只影响标题旁的那句话与最后一段的透明度：正文边到边长，摘要跟着变，
 * 这本身就是「还在想」的信号。**不加闪烁/呼吸动画**（前端规范只允许 StateDot 的
 * 进度环是循环动画）。
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
  const firstLine = text.split("\n").find((line) => line.trim())?.trim() ?? "";
  const chars = t(`${text.trim().length} 字`, `${text.trim().length} chars`);
  const summary = firstLine || chars;
  const title = streaming ? t("正在思考", "Thinking") : t("思考过程", "Reasoning");

  return (
    <Collapsible title={title} summary={summary} tone="muted" dense={dense} icon={dense ? <IconSpark size={12} /> : undefined}>
      <p className="whitespace-pre-wrap break-words text-[12px] italic leading-relaxed text-muted">
        {text}
        {streaming && <span className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 rounded-sm bg-brand opacity-80" />}
      </p>
    </Collapsible>
  );
}
