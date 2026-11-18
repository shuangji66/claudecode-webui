import { Markdown } from "../common/Markdown";
import { CopyButton } from "./CopyButton";
import { useT } from "../../lib/i18n";
import { formatTokens, tokensPerSecond } from "../../lib/usage";
import type { TurnUsage } from "../../lib/model";

/**
 * 本回合的用量文案：「42.1s · 本轮 1.1M tok · 210 tok/s」。
 *
 * - 中间那个数是**这一轮一共吃掉的 token**（输入含缓存 + 输出），不是「输出 tok」：
 *   一轮几十次工具调用里，输入侧占了绝大多数，只报输出会让人以为几乎没花钱；
 * - tok/s 用最近一次请求的输出 ÷ 它自己的生成耗时，不用整轮平均（那会把每次请求的
 *   首字延迟都摊进去，长任务里能低到实际速度的三分之一）。CLI 没给的数不编。
 */
function turnParts(turn: TurnUsage, t: (zh: string, en?: string) => string): string[] {
  const parts: string[] = [];
  if (turn.durationMs !== undefined) parts.push(`${(turn.durationMs / 1000).toFixed(1)}s`);
  const usage = turn.usage;
  const total = (usage?.turnInputTokens ?? 0) + (usage?.outputTokens ?? 0);
  if (total > 0) parts.push(`${t("本轮 ", "turn ")}${formatTokens(total)} tok`);
  const tps = tokensPerSecond(usage?.genTokens ?? 0, usage?.genMs);
  if (tps !== undefined) parts.push(`${Math.round(tps)} tok/s`);
  return parts;
}

export function AssistantBubble({
  text,
  streaming,
  turn,
}: {
  text: string;
  streaming: boolean;
  ts?: number;
  /** 回合结束时 normalize 回填的用量（只挂在该回合最后一条回答上）。 */
  turn?: TurnUsage;
}) {
  const t = useT();
  const parts = turn && !streaming ? turnParts(turn, t) : [];
  return (
    <div className="relative">
      <div className="text-ink">
        <Markdown text={text} />
        {streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 rounded-sm bg-brand opacity-80" />}
      </div>
      {/* 复制与本轮用量常驻可见，不再只靠 group-hover：触屏没有 hover，
          手机上等于没有入口。这行始终占高度，出现与否不会让消息上下跳。 */}
      {!streaming && (text.trim() || parts.length > 0) && (
        <div className="mt-1 flex items-center gap-1 text-[10.5px] text-faint">
          {text.trim() && <CopyButton text={text} label={t("复制回复", "Copy reply")} />}
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
