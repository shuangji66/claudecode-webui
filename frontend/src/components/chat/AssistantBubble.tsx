import { Markdown } from "../common/Markdown";
import { CopyButton } from "./CopyButton";
import { useT } from "../../lib/i18n";
import { formatTokens, tokensPerSecond } from "../../lib/usage";
import type { TurnUsage } from "../../lib/model";

/** 本回合的用量文案：「42.1s · 3.1K tok 输出 · 74 tok/s」，CLI 没给的数不编。 */
function turnParts(turn: TurnUsage, t: (zh: string, en?: string) => string): string[] {
  const parts: string[] = [];
  if (turn.durationMs !== undefined) parts.push(`${(turn.durationMs / 1000).toFixed(1)}s`);
  const output = turn.usage?.outputTokens;
  if (output) parts.push(`${formatTokens(output)} ${t("tok 输出", "tok out")}`);
  const tps = tokensPerSecond(output ?? 0, turn.usage?.apiMs);
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
