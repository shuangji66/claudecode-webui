// fnos.ts —— 飞牛（fnOS）目录授权。
//
// 为什么需要它：本应用以独立应用用户（ClaudeCode）运行，用户能在自己的目录里
// 浏览，但 claude 子进程要真正读写真目录，还得系统把该目录的 ACL 授予应用用户。
// 飞牛只提供「需要用户参与」的授权入口：宿主桥接的 authorizeUserFile(path) 会弹出
// 飞牛自己的确认页，用户确认后 trim_acl 才会写入。后端 API（trim.file.*）只能查/删
// 授权，不能授权，所以这一步只能在前端做。
//
// 不做版本分流：dsh 的 utils/fnosApp.ts 按飞牛 App 版本分流（1.38.0 之前原生
// pickUserFile 会把个人目录按共享授权处理），本应用只作为微应用跑在飞牛桌面 iframe
// 里，走的是桌面宿主桥接，不存在那条 App 内 WebView 通路，因此一律直调。
//
// 拿不到宿主（直接开浏览器访问端口、本地 make dev）时不阻塞添加目录：返回 skipped，
// 调用方按旧行为继续。理由是本项目也支持脱离飞牛网关直连，硬失败会让那种部署完全
// 加不了工作区；真实缺 ACL 时的报错仍会在 claude 侧暴露。

import type { TrimApp } from "@trimjs/web-app";

type TrimAppModule = typeof import("@trimjs/web-app");

/**
 * 等宿主桥接的上限。宿主无应答时 SDK 会先跑 1.5s（宿主探测）+ 5s（扩展宿主探测），
 * 再退化到一条永不 settle 的连接；10 秒足够覆盖这一段，也远大于正常握手耗时。
 */
const READY_TIMEOUT_MS = 10_000;

let instance: TrimApp | null = null;
let modulePromise: Promise<TrimAppModule> | null = null;

/** 页面是否可能拿到飞牛宿主桥接：桌面把应用放在 iframe 里，桥接基于 postMessage。 */
function inHostFrame(): boolean {
  return typeof window !== "undefined" && window.parent !== window;
}

function loadSdk(): Promise<TrimAppModule> {
  // 模块只加载一次；失败不缓存 rejection（下次调用可重试）。
  modulePromise ??= import("@trimjs/web-app").catch((e) => {
    modulePromise = null;
    throw e;
  });
  return modulePromise;
}

/**
 * 页面加载时调用：宿主只在 iframe 挂载后的 60 秒内应答握手，
 * 拖到用户点「添加授权目录」才 new 会静默握手失败，按钮点了没反应。
 */
export function primeFnosSdk(): void {
  if (!inHostFrame()) return;
  void loadSdk()
    .then((mod) => {
      instance ??= new mod.TrimApp();
    })
    .catch((e) => console.warn("[fnos] SDK 加载失败", e));
}

/** 等宿主桥接就绪；超时/加载失败返回 null，由调用方降级。 */
async function trimReady(timeoutMs = READY_TIMEOUT_MS): Promise<TrimApp | null> {
  let mod: TrimAppModule;
  try {
    mod = await loadSdk();
  } catch (e) {
    console.warn("[fnos] SDK 加载失败", e);
    return null;
  }
  instance ??= new mod.TrimApp();
  const sdk = instance;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn("[fnos] 宿主桥接未在", timeoutMs, "ms 内就绪");
      resolve(null);
    }, timeoutMs);
  });
  const ready = sdk.ready().then(
    () => sdk,
    (e: unknown) => {
      console.warn("[fnos] 宿主桥接握手失败", e);
      return null;
    },
  );
  try {
    return await Promise.race([ready, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 宿主授权回包里本模块关心的字段（`@trimjs/web-app` 的 AppBridgeResponse 子集）。 */
export interface AuthorizeResponseLike {
  code?: number;
  msg?: string;
  data?: unknown;
}

/** 授权结果：ok = ACL 已写入；cancel = 用户放弃；error = 宿主明确报错。 */
export type AuthorizeVerdict =
  | { state: "ok" }
  | { state: "denied"; reason: "cancel" }
  | { state: "denied"; reason: "message"; message: string };

/** 宿主表示「用户关掉了确认框」的文案（中英文都见过）。 */
const CANCEL_TEXTS = ["operation failed", "操作失败", "cancel", "canceled", "cancelled", "取消", "已取消", "用户取消"];

/**
 * 把宿主回包折成 ok / cancel / error —— 纯函数，便于单测。
 *
 * 飞牛的返回形状不稳定：成功是 `{ code: 0, data: true }`，取消可能是
 * `{ code: 1, msg: "Operation failed" }`（历史 `pickUserFile` 的形状）也可能
 * 直接 resolve undefined。取消不能当失败报红，真实错误也不能被吞成「已取消」。
 */
export function classifyAuthorizeResult(res: AuthorizeResponseLike | null | undefined): AuthorizeVerdict {
  if (!res) return { state: "denied", reason: "cancel" };
  // data 显式 false：宿主明确表示这次没有授权成功。
  if (res.code === 0 && res.data !== false) return { state: "ok" };
  const msg = String(res.msg ?? "").trim();
  if (!msg) return { state: "denied", reason: "cancel" };
  const lower = msg.toLowerCase();
  if (CANCEL_TEXTS.some((text) => lower === text || lower.includes(text))) return { state: "denied", reason: "cancel" };
  return { state: "denied", reason: "message", message: msg };
}

/** 目录选择器参数的展示文案由调用方给（lib 不碰 i18n）。 */
export interface FnosPickParams {
  title?: string;
  okText?: string;
}

/** 选择器结果：ok 时带选中的目录；取消/失败与授权同一套语义。 */
export type FnosPickOutcome =
  | { state: "ok"; path: string }
  | { state: "denied"; reason: "cancel" }
  | { state: "denied"; reason: "message"; message: string }
  | { state: "skipped"; reason: FnosAuthSkipReason };

/**
 * 把选择器回包折成 ok / cancel / error —— 纯函数，便于单测。
 *
 * 与 authorizeUserFile 的区别：选择器的成功标志是 **data 里有路径**，
 * `{ code: 0, data: [] }` 表示「用户什么都没选」，不能当成成功。
 */
export function classifyPickResult(res: AuthorizeResponseLike | null | undefined): FnosPickOutcome {
  const data = Array.isArray(res?.data) ? res.data : [];
  const path = data.find((item): item is string => typeof item === "string" && item.trim() !== "");
  if (path) return { state: "ok", path };
  const msg = String(res?.msg ?? "").trim();
  if (!msg) return { state: "denied", reason: "cancel" };
  const lower = msg.toLowerCase();
  if (CANCEL_TEXTS.some((text) => lower === text || lower.includes(text))) return { state: "denied", reason: "cancel" };
  return { state: "denied", reason: "message", message: msg };
}

/** 跳过授权的原因：非 iframe（独立浏览器）/ 宿主桥接不可用。 */
export type FnosAuthSkipReason = "standalone" | "bridge";

export type FnosAuthOutcome =
  | AuthorizeVerdict
  | { state: "skipped"; reason: FnosAuthSkipReason };

/**
 * 请飞牛把 path 的 ACL 授予本应用用户。
 *
 * 返回 skipped 表示当前页面没有宿主桥接（不是飞牛桌面/App 内），调用方按旧行为
 * 继续登记目录即可；返回 denied 表示用户取消或宿主报错，必须停下来。
 */
export async function authorizeFnosDir(path: string): Promise<FnosAuthOutcome> {
  if (!inHostFrame()) return { state: "skipped", reason: "standalone" };
  const sdk = await trimReady();
  if (!sdk) return { state: "skipped", reason: "bridge" };
  try {
    return classifyAuthorizeResult(await sdk.authorizeUserFile(path));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { state: "denied", reason: "message", message };
  }
}

/**
 * 打开飞牛的目录选择器并让用户当场授权（pickUserFile + directory）。
 *
 * 与「在输入框里手输路径 + 授权确认」相比，这条路是用户自己挑的目录，
 * 挑选即授权，返回后可以直接登记为工作区（不必再弹一次确认框）。
 */
export async function pickFnosDir(params: FnosPickParams = {}): Promise<FnosPickOutcome> {
  if (!inHostFrame()) return { state: "skipped", reason: "standalone" };
  const sdk = await trimReady();
  if (!sdk) return { state: "skipped", reason: "bridge" };
  try {
    const res = await sdk.pickUserFile({
      directory: true,
      title: params.title,
      okText: params.okText,
      // 与飞牛桌面目录选择器一致的分组（不列「他人共享」，避免误授权）。
      sidebarGroup: ["myFiles", "external", "favorites", "team"],
    });
    return classifyPickResult(res);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { state: "denied", reason: "message", message };
  }
}

export interface FnosOpenOutcome {
  ok: boolean;
  reason?: "standalone" | "bridge" | string;
}

/** 在飞牛文件管理器里显示某个目录（「在文件夹显示」）。 */
export async function openFnosFileManager(path: string): Promise<FnosOpenOutcome> {
  if (!inHostFrame()) return { ok: false, reason: "standalone" };
  const sdk = await trimReady();
  if (!sdk) return { ok: false, reason: "bridge" };
  try {
    await sdk.openFileManager(path);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
