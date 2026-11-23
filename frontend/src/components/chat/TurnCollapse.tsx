import { IconChevronDown } from "../common/Icons";
import { useLocale, useT } from "../../lib/i18n";
import { formatDuration, formatDurationWords } from "../../lib/elapsed";
import type { TurnOutcome } from "../../lib/process";

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
 *   - 拿不到（老转录里连时间戳都没有）：`已完成`。
 *
 * 箭头**紧跟在文字右边**，不推到行尾：它是这句话的一部分（「点这里展开」），
 * 甩到整行最右侧就变成两颗互不相干的东西；而且行尾那个位置在宽屏上离文字太远，
 * 鼠标要横跨半个屏幕才点到。收回时箭头朝右（还是「点开」的语义），展开后朝下。
 *
 * 下面那条分隔线是这一行与正文之间的那道界（DSH 同款，用主题色）：收起行是
 * 「过程的总括」，正文是这一轮的结果，两者需要一条视觉边界，否则糊成一团。
 *
 * **「结束」不等于「做完了」**（`outcome`）：用户按停止、上游报错、进程被结束都会让
 * 这一轮收尾，把它们一律写成「已完成，用时 19 分 52 秒」等于告诉用户「这活干完了」，
 * 而实际上模型是被打断的。所以按结局给三种文案，且**中断/失败时不报用时**——那个数
 * 只说明「跑了多久然后被打断」，挂在「已完成」后面读起来就是完成耗时（DSH 的
 * `message.stopped` / `message.turnProcess.failed` 也是这么分的）。
 */
export function TurnCollapse({
  durationMs,
  outcome = "ok",
  open,
  onToggle,
}: {
  /** 本轮耗时（实时来自 `result.duration_ms`，回放的轮按转录时间戳推）。 */
  durationMs?: number;
  /** 这一轮怎么结束的（见 `TurnSpan.outcome`）。被中断 / 出错时不显示用时。 */
  outcome?: TurnOutcome;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const elapsed =
    durationMs === undefined || outcome !== "ok"
      ? ""
      : locale === "en"
        ? formatDuration(durationMs)
        : formatDurationWords(durationMs);
  const label =
    outcome === "stopped"
      ? t("已停止", "Stopped")
      : outcome === "failed"
        ? t("本轮失败", "Turn failed")
        : elapsed
          ? t(`已完成，用时 ${elapsed}`, `Finished in ${elapsed}`)
          : t("已完成", "Finished");

  return (
    <div className="border-b border-brand/60">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-1 py-1.5 text-left text-[12px] text-muted hover:text-ink"
      >
        <span className="shrink-0">{label}</span>
        {/* 收起＝朝右（「这一点还有东西」），展开＝朝下：`IconChevronDown` 转 -90°。 */}
        <IconChevronDown
          size={13}
          className={`shrink-0 text-faint transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>
    </div>
  );
}
