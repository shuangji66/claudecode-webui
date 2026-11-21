import { Markdown } from "../common/Markdown";
import { CopyButton } from "./CopyButton";
import { useT } from "../../lib/i18n";
import { formatSpeed, formatTokens, turnThroughput } from "../../lib/usage";
import { formatDuration } from "../../lib/elapsed";
import type { TurnUsage } from "../../lib/model";

/**
 * 本回合的用量文案：「04:53 · 本轮 1.1M tok · 210 tok/s」。
 *
 * - 耗时是**时:分:秒**（到小时才带小时位），不是「293.1s」：一轮长任务跑几分钟，
 *   纯秒数得自己心算；
 * - 中间那个数是**这一轮一共吃掉的 token**（输入含缓存 + 输出），不是「输出 tok」：
 *   一轮几十次工具调用里，输入侧占了绝大多数，只报输出会让人以为几乎没花钱；
 * - tok/s 是**这一轮**的 Σ输出 ÷ Σ生成耗时（`turnThroughput`）：分母不含首字延迟，
 *   也不拿最后一次请求凑数——工具循环里最后一个请求往往只是个短回复。CLI 没给的数不编。
 */
function turnParts(turn: TurnUsage, t: (zh: string, en?: string) => string): string[] {
  const parts: string[] = [];
  if (turn.durationMs !== undefined) parts.push(formatDuration(turn.durationMs));
  const usage = turn.usage;
  const total = (usage?.turnInputTokens ?? 0) + (usage?.outputTokens ?? 0);
  if (total > 0) parts.push(`${t("本轮 ", "turn ")}${formatTokens(total)} tok`);
  const tps = turnThroughput(usage);
  if (tps !== undefined) parts.push(`${formatSpeed(tps)} tok/s`);
  return parts;
}

export function AssistantBubble({
  text,
  streaming,
  turn,
  showCopy = true,
  copyText,
}: {
  text: string;
  streaming: boolean;
  ts?: number;
  /** 回合结束时 normalize 回填的用量（只挂在该回合最后一条回答上）。 */
  turn?: TurnUsage;
  /**
   * 是否给复制入口。
   *
   * 一轮里模型会写好几段过渡正文（夹在思考与工具调用之间），它们各自挂一个复制按钮
   * 只是噪音：**只有这一轮的最终回答给**（`MessageList` 按「是不是本轮最后一条回答」
   * 判断）。复制的内容也不是这一条，见 `copyText`。
   */
  showCopy?: boolean;
  /**
   * 复制到剪贴板的文本，默认就是本条正文。
   *
   * 最终回答传的是**整轮的正文输出**（过渡正文 + 最终回答，按顺序拼接）：用户要的是
   * 「这一轮说了什么」，而不是最后那一段；而过渡正文在收起态下多半是看不见的，
   * 不带上就等于复制不到。思考过程（thinking）不进来——它是推理，不是输出。
   */
  copyText?: string;
}) {
  const t = useT();
  const parts = turn && !streaming ? turnParts(turn, t) : [];
  const canCopy = showCopy && text.trim() !== "";
  return (
    <div className="relative">
      <div className="text-ink">
        <Markdown text={text} />
        {streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 rounded-sm bg-brand opacity-80" />}
      </div>
      {/* 复制与本轮用量常驻可见，不再只靠 group-hover：触屏没有 hover，
          手机上等于没有入口。这行始终占高度，出现与否不会让消息上下跳。 */}
      {!streaming && (canCopy || parts.length > 0) && (
        <div className="mt-1 flex items-center gap-1 text-[10.5px] text-faint">
          {canCopy && <CopyButton text={copyText ?? text} label={t("复制回复", "Copy reply")} />}
          {parts.length > 0 && (
            <span
              className="ml-0.5 min-w-0 truncate tabular-nums"
              title={t("本轮耗时 · 输出 token · 生成速度", "Turn time · output tokens · throughput")}
            >
              {parts.join(" · ")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
