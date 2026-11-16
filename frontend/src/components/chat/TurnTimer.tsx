// 回合进行中的计时行（对齐 DSH 底部那句「少女祈祷中 + 已进行时间」）。
//
// 只在 busy 时出现，位置在输入框正上方：用户盯着「到底跑了多久」的时候，
// 眼睛本来就在输入区附近。计时文字不做呼吸/闪烁（前端规范只允许 StateDot 的
// 进度环是循环动画），只按整秒跳动。
import { useEffect, useState } from "react";
import { StateDot } from "../common/StateDot";
import { formatElapsed } from "../../lib/elapsed";
import { useT } from "../../lib/i18n";

interface Props {
  /** 本回合开始时间（毫秒时间戳）；0 表示不知道起点，不渲染。 */
  startedAt: number;
  className?: string;
}

export function TurnTimer({ startedAt, className = "" }: Props) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // 先对齐一次再开定时器：从「暂停在别的对话」切回来时不会先显示旧秒数。
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (!startedAt) return null;
  return (
    <div className={`flex items-center gap-1.5 text-[11px] text-muted ${className}`}>
      <StateDot state="ongoing" size={11} />
      <span className="min-w-0 truncate">{t("少女祈祷中", "Waiting on Claude")}</span>
      <span className="font-mono tabular-nums text-faint">{formatElapsed(now - startedAt)}</span>
    </div>
  );
}
