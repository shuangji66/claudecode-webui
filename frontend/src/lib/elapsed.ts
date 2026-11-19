// 「跑了多久」的文案格式化。
//
// 只做格式化，不读时钟：调用方传毫秒差，便于单测（不要依赖 Date.now 的精确值）。
// 两种形态：
//   - `formatElapsed`：进行中的计时（对话里的「少女祈祷中」）。1 分钟内给「12s」，
//     1 小时内给「3:20」，超过 1 小时给「1:02:03」——秒数补零，宽度不抖。
//   - `formatDuration`：**已经结束的耗时**（回合耗时、子代理用量）。分:秒固定两位
//     「04:53」，到 1 小时才加小时位「1:02:03」——回答下面那行小字里，单看
//     「293.1s」得自己心算成 4 分 53 秒，长任务尤其难读。
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  if (total < 60) return `${total}s`;
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * 已结束耗时 → 「mm:ss」，到 1 小时才带小时位（「h:mm:ss」）。
 *
 * 毫秒四舍五入到秒：既不像截断那样把 4 分 53.8 秒读成 4 分 53 秒（少一截），
 * 也不像向上取整那样把 42.1 秒报成 43 秒。
 */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * 已结束耗时 → 中文口语的「3 分 15 秒」（DSH 收起行那种写法）。
 *
 * 与 `formatDuration` 的区别只是可读性：`03:15` 要先在心里换算才知道是三分十五秒，
 * 而收起行是一整轮的总括，读它的时候不想做算术。0 的位省掉（「45 秒」「2 分」），
 * 一小时以上带小时位（「1 小时 2 分」）。
 *
 * 英文沿用 `formatDuration` 的 mm:ss：`3 min 15 sec` 在那一行会明显更长。
 */
export function formatDurationWords(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分`);
  // 有小时或分钟时不再报 0 秒（「3 分 0 秒」是噪音）；整段为 0 时给「0 秒」。
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} 秒`);
  return parts.join(" ");
}
