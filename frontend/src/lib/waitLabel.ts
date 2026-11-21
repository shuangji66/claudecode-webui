// 计时行那句「少女祈祷中」的自定义文案（设置 → 通用最底部那一行）。
//
// 只存本机（和主题、过程展示同一类偏好）：它是一句界面文案，不参与任何会话行为，
// 也不经过后端，换台设备各看各的。
//
// 长度口径是**显示宽度 6–12**：汉字（及全角、假名、emoji 这类宽字符）算 2 个字符，
// 其余算 1 个。这样中英混写没有额外限制（早先「只许纯汉字或纯字母数字」的口径把
// 「等待中ab」判成非法，可那正是一句正常的文案），而中文仍然按两倍占位——六个汉字
// 与十二个字母在计时行里是差不多一样宽，也差不多一样不容易把秒数挤出屏幕。
// 空串合法：意思是「用内置文案」（中文「少女祈祷中」/ 英文「Waiting on Claude」）。
// 不合法的值**不保存**（输入框失焦后回退到上次生效的值），而不是存下来再在渲染时
// 过滤——那样计时行会毫无征兆地变回内置文案，看起来像设置丢了。
import { useSyncExternalStore } from "react";

const KEY = "ccweb-wait-label";

/** 宽度口径的上下限（含）：6–12 个字符，汉字算 2。 */
export const WAIT_LABEL_MIN = 6;
export const WAIT_LABEL_MAX = 12;

/**
 * 一个码位的显示宽度：汉字 / 全角 / 假名 / 韩文 / emoji 算 2，其余算 1。
 *
 * 零宽与组合字符按 0 计：ZWJ（U+200D）、变体选择符（U+FE0F/FE0E）是 `👩‍💻` 这类组合
 * emoji 的拼接符；零宽空格（U+200B）、ZWNJ（U+200C）、word joiner（U+2060）、
 * BOM（U+FEFF）与组合附加符号（U+0300–U+036F）在计时行里**看不见**。
 * 不给它们记 0 的话，`"\u200b".repeat(6)` 能凑够 6 个宽度通过校验，落盘后计时行
 * 就只剩一个秒数，看起来像文案丢了。
 */
function charWidth(cp: number): number {
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || cp === 0xfeff) return 0;
  if (cp === 0xfe0f || cp === 0xfe0e) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // 组合附加符号
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) || // 韩文字母
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首 / 假名 / 汉字 / 注音
    (cp >= 0xac00 && cp <= 0xd7a3) || // 韩文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容汉字
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角字符
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号
    (cp >= 0x1f000 && cp <= 0x1faff) || // emoji / 麻将 / 扑克等
    (cp >= 0x20000 && cp <= 0x3fffd); // CJK 扩展平面
  return wide ? 2 : 1;
}

/** 去掉首尾空白后的显示宽度（汉字算 2）；输入框旁边的计数器直接用它。 */
export function waitLabelWidth(raw: string): number {
  let width = 0;
  for (const ch of raw.trim()) width += charWidth(ch.codePointAt(0) ?? 0);
  return width;
}

/** 去掉首尾空白后是否可接受：空串（= 用内置文案）也接受。 */
export function isValidWaitLabel(raw: string): boolean {
  const value = raw.trim();
  if (value === "") return true;
  const width = waitLabelWidth(value);
  // 全是零宽字符时宽度是 0：既不该算「空串（用内置文案）」，也不该算合法——
  // 它落盘之后计时行会剩下一片空白。
  if (width === 0) return false;
  return width >= WAIT_LABEL_MIN && width <= WAIT_LABEL_MAX;
}

/**
 * 读写都过这一道：localStorage 是不可信输入（用户能手改、别的版本能写别的口径），
 * 不合法的一律折成空串，计时行退回内置文案。
 */
export function normalizeWaitLabel(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  return isValidWaitLabel(value) ? value : "";
}

let cached: string | null = null;
const listeners = new Set<() => void>();

export function waitLabel(): string {
  if (cached !== null) return cached;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null; // 隐私模式 / 配额异常：当没设置过
  }
  cached = normalizeWaitLabel(raw);
  return cached;
}

export function setWaitLabel(next: string): void {
  const raw = next.trim();
  // 不合法的值**什么都不动**（不是「清掉」）：调用方漏了校验时，旧设置还在，
  // 总比时钟行突然变回内置文案要好查。清空要传空串/纯空白。
  if (raw !== "" && !isValidWaitLabel(raw)) return;
  const value = raw;
  cached = value;
  try {
    // 空串直接删键：留一个 `""` 在盘上只是让人以为设置过什么。
    if (value) localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch {
    // 写不进去只影响「下次打开」，当前会话照常生效
  }
  for (const fn of listeners) fn();
}

export function subscribeWaitLabel(fn: () => void): () => void {
  listeners.add(fn);
  // 跨标签页同步：另一页改了文案，这一页的计时行也要跟着换（与
  // `lib/sidebarFeatures` 的偏好同一个做法）。只在有订阅者时挂监听。
  const onStorage = (event: StorageEvent) => {
    if (event.key !== KEY) return;
    cached = null; // 让下一次读取重新走 normalize
    fn();
  };
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

export function useWaitLabel(): string {
  return useSyncExternalStore(subscribeWaitLabel, waitLabel, waitLabel);
}

/** 仅测试用：清掉模块缓存。 */
export function resetWaitLabelCache(): void {
  cached = null;
}
