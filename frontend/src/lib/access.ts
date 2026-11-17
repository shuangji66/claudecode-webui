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
