import { IconChevronDown } from "../common/Icons";
import { useLocale, useT } from "../../lib/i18n";
import { formatDuration, formatDurationWords } from "../../lib/elapsed";

/**
 * 一轮的过程收起来之后，轮首那一行（对齐 DSH 的「已完成，用时 2 分 37 秒 ⌄」）。
 *
 * **收起是轮级的**：整轮的思考与工具调用一起消失，只留正文输出；点这一行才把过程
 * 按当前档位还原回原来的位置。它取代了以前「每个过程组各挂一个组头」的做法——
 * 那样一轮会挂七八行组头，正文被切得零零碎碎。
 *
 * 只有**已经结束**的轮才挂这一行：正在跑的轮必须看得见步骤，收起入口在那里只是干扰。
 * 文案因此只有两种：
 *   - 拿得到时长：`已完成，用时 3 分 15 秒`（中文用口语写法，英文沿用 mm:ss）；
 *   - 拿不到（转录回放没有 result 行）：`已完成`。
 *
 * 下面那条分隔线是这一行与正文之间的那道界（DSH 同款）：收起行是「过程的总括」，
 * 正文是这一轮的结果，两者需要一条视觉边界，否则标题与正文糊成一团。
 */
export function TurnCollapse({
  durationMs,
  open,
  onToggle,
}: {
  /** 本轮耗时（result.duration_ms）；历史回放拿不到时为空。 */
  durationMs?: number;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const elapsed =
    durationMs === undefined
      ? ""
      : locale === "en"
        ? formatDuration(durationMs)
        : formatDurationWords(durationMs);
  const label = elapsed ? t(`已完成，用时 ${elapsed}`, `Finished in ${elapsed}`) : t("已完成", "Finished");

  return (
    <div className="border-b border-line/70">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 py-1.5 text-left text-[12px] text-muted hover:text-ink"
      >
        <span className="shrink-0">{label}</span>
        <IconChevronDown
          size={13}
          className={`ml-auto shrink-0 text-faint transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
    </div>
  );
}
