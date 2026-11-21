// 端口访问的端口范围：与后端 settings.MinTCPPort / MaxTCPPort 保持一致。
//
// 下限 1025：1024 及以下是特权端口，普通应用用户绑不上，前端先挡住，
// 不用等后端返回 permission denied。

export const TCP_PORT_MIN = 1025;
export const TCP_PORT_MAX = 65535;

/** 端口输入是否合法（整数，且在 1025–65535 之间）。 */
export function validTCPPort(value: string | number): boolean {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= TCP_PORT_MIN && n <= TCP_PORT_MAX;
}

// 登录会话有效期（小时）：与后端 settings.Default/Min/Max/StepLoginTTLHours 一致。
//
// 12–72、步进 12（12/24/36/48/60/72）。会话表在服务端落盘，重启进程不再失效，
// 所以这个值就是登录态唯一的过期边界。
export const LOGIN_TTL_MIN = 12;
export const LOGIN_TTL_MAX = 72;
export const LOGIN_TTL_STEP = 12;
export const LOGIN_TTL_DEFAULT = 24;

/**
 * 把任意值归到最近的合法档位（12/24/…/72），越界夹到两端。
 *
 * 手改过配置文件、或者旧前端写进一个不在档位上的值（比如 30）时，界面按最近
 * 档位显示；按一次「−」要落到 12 而不是 18，所以档位必须是算出来的。
 */
export function clampLoginTTL(hours: number): number {
  if (!Number.isFinite(hours)) return LOGIN_TTL_DEFAULT;
  const stepped = Math.round(hours / LOGIN_TTL_STEP) * LOGIN_TTL_STEP;
  return Math.min(LOGIN_TTL_MAX, Math.max(LOGIN_TTL_MIN, stepped));
}
