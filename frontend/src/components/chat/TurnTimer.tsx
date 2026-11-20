// 回合进行中的计时行（对齐 DSH 底部那句「少女祈祷中 + 已进行时间」）。
//
// 只在 busy 时出现，位置在输入框正上方：用户盯着「到底跑了多久」的时候，
// 眼睛本来就在输入区附近。计时文字不做呼吸/闪烁（前端规范只允许 StateDot 的
// 进度环是循环动画），只按整秒跳动。
//
// 沉默提示：超过 SILENT_WARN_MS 没收到任何 CLI 帧（正文/思考/工具/结果/审批都没有），
// 在计时后面补一句「上游 32s 没有响应」。CLI 在一个字节都不回的那段时间里什么都不发，
// 没有这句话时「模型在长考」与「上游已经不回了」在界面上一模一样，用户只能干等到
// 后端注入的 60 秒字节流空闲阈值判死（见 lib/silence 与 settings.Env）。
import { useEffect, useState } from "react";
import { StateDot } from "../common/StateDot";
import { formatElapsed } from "../../lib/elapsed";
import { isSilentLongEnough, silentFor, silentSeconds } from "../../lib/silence";
import { lastSound } from "../../store/useAppStore";
import { useT } from "../../lib/i18n";

interface Props {
  /** 本回合开始时间（毫秒时间戳）；0 表示不知道起点，不渲染。 */
  startedAt: number;
  /** 当前会话 id：用它读「最近一次有声」的时间。 */
  sessionId?: string | null;
  /**
   * 此刻是否在等上游（没有工具在跑）。
   *
   * 本地命令、子代理、MCP 调用都在自己这边耗时间，CLI 那时本来就不会产生上游帧——
   * 只看「最后一条帧」的话，一个跑满 3 分钟的 bash 会被误报成「上游 180s 没有响应」。
   */
  watchSilence?: boolean;
  className?: string;
}

export function TurnTimer({ startedAt, sessionId = null, watchSilence = true, className = "" }: Props) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // 空闲时（startedAt=0）组件不渲染，也不该留一个每秒 setNow 的定时器：
    // 那会让打开着的对话页在什么都没发生时每秒重渲染一次。
    if (!startedAt) return;
    // 先对齐一次再开定时器：从「暂停在别的对话」切回来时不会先显示旧秒数。
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (!startedAt) return null;
  // 沉默时长从「本回合起点」与「最后一次有声」里取更晚的那个：刚发出 prompt 时
  // 还没有帧，沉默就该从发出那一刻开始算，而不是沿用上一轮的旧时间。
  const silent = silentFor(now, lastSound(sessionId), startedAt);
  const warn = watchSilence && isSilentLongEnough(silent);
  return (
    <div className={`flex items-center gap-1.5 text-[11px] text-muted ${className}`}>
      <StateDot state="ongoing" size={11} />
      <span className="min-w-0 truncate">{t("少女祈祷中", "Waiting on Claude")}</span>
      <span className="font-mono tabular-nums text-faint">{formatElapsed(now - startedAt)}</span>
      {warn && (
        <span className="shrink-0 truncate text-faint">
          · {t(`上游 ${silentSeconds(silent)}s 没有响应`, `no response from upstream for ${silentSeconds(silent)}s`)}
        </span>
      )}
    </div>
  );
}
