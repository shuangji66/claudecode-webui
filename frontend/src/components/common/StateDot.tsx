// 对话状态标记（对齐 DSH 的 StateDot）。
//
// 四种状态：进行中（转圈）、需要审批（强调色点）、任务完成（绿点）、未运行（灰点）。
// 「活跃但空闲」不画任何东西——由调用方决定不渲染，别塞一个透明占位。
// 颜色与动画在 styles.css 的 .state-dot* 里，这里只管形状：圆点走 ::after，
// 进度环是 SVG（两个同心圆，一个淡色轨道 + 一段会呼吸的弧）。

/**
 * 圆点状态：
 *   - `ongoing` 进度环（唯一允许的循环动画）；
 *   - `approval` 主题色点（需要人工介入）；
 *   - `brand` 主题色点，但语义是「已结束、既不是完成也不是失败」（子代理被中断/停止）；
 *   - `done` 绿点、`off` 灰点。`fail` 红点（子代理失败）。
 *
 * `approval` 与 `brand` 画出来一样，分开只为让调用处的意图一眼看得出来。
 */
export type StateDotState = "ongoing" | "approval" | "brand" | "done" | "fail" | "off";

interface Props {
  state: StateDotState;
  /** 尺寸（px）。进度环默认 14，圆点默认 10（与 DSH 一致）。 */
  size?: number;
  className?: string;
}

export function StateDot({ state, size, className = "" }: Props) {
  if (state === "ongoing") {
    const n = size ?? 14;
    return (
      <svg
        className={`state-dot-spinner ${className}`}
        data-state="ongoing"
        width={n}
        height={n}
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <g className="state-dot-spin">
          <circle className="state-dot-track" cx="12" cy="12" r="9.5" />
          <circle className="state-dot-arc" cx="12" cy="12" r="9.5" />
        </g>
      </svg>
    );
  }
  const n = size ?? 10;
  return <span className={`state-dot state-dot-${state} ${className}`} data-state={state} style={{ width: n, height: n }} aria-hidden="true" />;
}
