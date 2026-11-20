// 「上游多久没出声」的判定（纯函数，便于单测）。
//
// 为什么需要它：CLI 只在**失败/准备重试**时才发 `system/api_retry`，而一个字节都不回
// 的那段时间里它什么都不发（`keep_alive` 又被后端丢掉了，见 AGENTS 4.2.3）。
// 于是界面上只剩计时器在走，用户看到的就是「卡死了还是慢？」。
//
// 阈值 15 秒是体感值：正常首包很少超过它，超过之后那句提示只是说明「还在等上游」，
// 不代表失败——真正的失败由后端注入的 60 秒字节流空闲阈值判（见 settings.Env）。

/** 沉默多久开始提示（毫秒）。 */
export const SILENT_WARN_MS = 15_000;

/**
 * 从 `lastFrameAt` 到 `now` 沉默了多少毫秒。
 *
 * 没有记录过任何帧（刚发出 prompt）时用 `since` 兜底：那段等待同样算沉默——
 * 「发出去 20 秒什么也没有」正是最该提示的情形。
 * 结果不早于 0：帧时间戳偶尔会比调用方的 now 更新（同一毫秒内的竞态），不要因此报负数。
 */
export function silentFor(now: number, lastFrameAt: number | undefined, since: number): number {
  const base = Math.max(since, lastFrameAt ?? since);
  if (!Number.isFinite(base) || !Number.isFinite(now)) return 0;
  return Math.max(0, now - base);
}

/** 沉默时间是否已经越过提示阈值。 */
export function isSilentLongEnough(silentMs: number, thresholdMs: number = SILENT_WARN_MS): boolean {
  return silentMs >= thresholdMs;
}

/** 提示文案里的秒数：向下取整到秒，不四舍五入（15.9 秒说「15 秒」不夸大）。 */
export function silentSeconds(silentMs: number): number {
  return Math.max(0, Math.floor(silentMs / 1000));
}
