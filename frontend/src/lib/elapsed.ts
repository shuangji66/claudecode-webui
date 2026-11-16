// 「这一回合已经跑了多久」的短文案。
//
// 只做格式化，不读时钟：调用方传毫秒差，便于单测（不要依赖 Date.now 的精确值）。
// 形态对齐 DSH 底部的计时：1 分钟内给「12s」，1 小时内给「3:20」，
// 超过 1 小时给「1:02:03」——秒数补零，避免数字宽度在右对齐时抖动。
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  if (total < 60) return `${total}s`;
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
