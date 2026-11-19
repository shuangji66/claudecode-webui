// fnos.ts —— 飞牛（fnOS）目录授权。
//
// 为什么需要它：本应用以独立应用用户（ClaudeCode）运行，用户能在自己的目录里
// 浏览，但 claude 子进程要真正读写真目录，还得系统把该目录的 ACL 授予应用用户。
// 飞牛只提供「需要用户参与」的授权入口：宿主桥接的 authorizeUserFile(path) 会弹出
// 飞牛自己的确认页，用户确认后 trim_acl 才会写入。后端 API（trim.file.*）只能查/删
// 授权，不能授权，所以这一步只能在前端做。
//
// 两条宿主通路都要认：飞牛桌面把微应用放在 iframe 里（postMessage 桥接），
// 飞牛 App 里则是顶层 WebView（没有 parent），SDK 用 UA 判断后走
// flutter_inappwebview 的 callHandler。只看 iframe 会让 App 内被误判成「不在宿主」。
// 不做版本分流：dsh 的 utils/fnosApp.ts 按 App 版本分流（1.38.0 之前原生
// pickUserFile 会把个人目录按共享授权处理），本应用一律直调。
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

/** 页面是否在 iframe 里（飞牛桌面微应用）。 */
function inHostFrame(): boolean {
  return typeof window !== "undefined" && window.parent !== window;
}

/**
 * UA 里是否带飞牛 App 标识（`FNOS/1.2.3`、`FNAppType/xxx`、`FNAppVer/1.2.3`）。
 *
 * 判据与 `@trimjs/web-app` 同一组 token：SDK 就是靠它们决定走移动端
 * （flutter_inappwebview.callHandler）还是 iframe 桥接。App 内是顶层页面、
 * 没有 parent frame，只判断 iframe 会漏掉它。
 */
export function isFnosApp(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return /FNOS\/\d|FNAppType\/|FNAppVer\//.test(userAgent);
}

/** 原生 WebView 桥是否已注入（Android 直接挂 window，iOS 在 platformReady 之后才有）。 */
function hasFlutterBridge(): boolean {
  return typeof window !== "undefined" && Boolean((window as unknown as { flutter_inappwebview?: unknown }).flutter_inappwebview);
}

/** 页面是否可能拿到飞牛宿主桥接：桌面 iframe，或飞牛 App 内 WebView。 */
function inHost(): boolean {
  return inHostFrame() || hasFlutterBridge() || isFnosApp();
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
  if (!inHost()) return;
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
  /**
   * 只允许选择的扩展名（以 `.` 开头，如 `['.md']`）。宿主的文件选择器据此灰掉/隐藏其它类型。
   *
   * 只是**选择器的门帘**：拿到的路径仍然要在调用方与后端各校验一次——
   * 不同宿主版本的过滤能力不一致，不能把它当唯一防线。
   */
  accept?: string[];
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
  const paths = pickedPaths(res);
  if (paths.length > 0) return { state: "ok", path: paths[0] };
  return classifyDenial(res);
}

/** 回包里的全部路径（选择器支持多选，取消时是空数组）。 */
function pickedPaths(res: AuthorizeResponseLike | null | undefined): string[] {
  const data = Array.isArray(res?.data) ? res.data : [];
  return data.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

/** 没有路径时的失败语义：空回包或「操作失败」= 用户取消，其余带原文报错。 */
function classifyDenial(
  res: AuthorizeResponseLike | null | undefined,
): { state: "denied"; reason: "cancel" } | { state: "denied"; reason: "message"; message: string } {
  const msg = String(res?.msg ?? "").trim();
  if (!msg) return { state: "denied", reason: "cancel" };
  const lower = msg.toLowerCase();
  if (CANCEL_TEXTS.some((text) => lower === text || lower.includes(text))) return { state: "denied", reason: "cancel" };
  return { state: "denied", reason: "message", message: msg };
}

/** 多选文件的结果：ok 时带全部路径。 */
export type FnosFilesOutcome =
  | { state: "ok"; paths: string[] }
  | { state: "denied"; reason: "cancel" }
  | { state: "denied"; reason: "message"; message: string }
  | { state: "skipped"; reason: FnosAuthSkipReason };

/** 把选择器回包折成「全部路径」——多选时不能只取第一个。 */
export function classifyPickPaths(res: AuthorizeResponseLike | null | undefined): FnosFilesOutcome {
  const paths = pickedPaths(res);
  if (paths.length > 0) return { state: "ok", paths };
  return classifyDenial(res);
}

/**
 * 打开飞牛的**文件**选择器（不是目录），挑完即授权给本应用。
 *
 * 返回的是 NAS 上的绝对路径：图片/PDF 由后端读成附件，其余类型作为路径引用写进
 * 消息，让 claude 自己用 Read 工具读——不做任意宿主文件读取。
 */
export async function pickFnosFiles(params: FnosPickParams = {}): Promise<FnosFilesOutcome> {
  if (!inHost()) return { state: "skipped", reason: "standalone" };
  const sdk = await trimReady();
  if (!sdk) return { state: "skipped", reason: "bridge" };
  try {
    const res = await sdk.pickUserFile({
      directory: false,
      multiple: true,
      title: params.title,
      okText: params.okText,
      // accept 是宿主选择器的过滤条件；老宿主可能忽略它，所以调用方
      // 仍要按扩展名自己再筛一遍（见 SkillImportDialog 的 isSkillFile）。
      ...(params.accept && params.accept.length > 0 ? { accept: params.accept } : {}),
      sidebarGroup: ["myFiles", "external", "favorites", "team"],
    });
    return classifyPickPaths(res);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { state: "denied", reason: "message", message };
  }
}

/** 跳过授权的原因：不在宿主里（独立浏览器）/ 宿主桥接不可用。 */
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
  if (!inHost()) return { state: "skipped", reason: "standalone" };
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
 * 挑选即授权。返回后调用方把选择器落到该目录上（`WorkspaceDialog` 里是进目录浏览），
 * 真正登记工作区由用户自己点「添加」——那时 `POST /api/fs/access` 探测已经通过，
 * 不会再弹第二次确认框。
 */
export async function pickFnosDir(params: FnosPickParams = {}): Promise<FnosPickOutcome> {
  if (!inHost()) return { state: "skipped", reason: "standalone" };
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

/** `openFnosFile` 的结果：fallback 表示宿主不支持直接打开，已改为在文件夹里显示。 */
export interface FnosOpenFileOutcome extends FnosOpenOutcome {
  fallback?: boolean;
}

/**
 * 当前页面能不能调宿主能力（桌面 iframe / App WebView）。
 *
 * 右侧栏文件面板据此决定菜单里给不给「在文件夹显示 / 文件详情」——
 * 不在宿主里只留「复制路径」，不要摆一堆点了就报错的项。
 */
export function fnosHostAvailable(): boolean {
  return inHost();
}

/**
 * 飞牛选择器入口要不要出现 —— 纯函数（`@` 菜单里的「从飞牛选择」用它）。
 *
 * 两条缺一不可：
 *   - 页面确实在宿主里（桌面 iframe / App WebView），否则桥接根本不存在；
 *   - 当前不是 TCP 直连端口通道：那条路上页面开在普通浏览器里，本来就没有宿主，
 *     而 `fnosHostAvailable` 只回答「页面结构像不像宿主」，端口访问必须单独挡一次。
 *
 * 摆一个点了就报「当前不在飞牛宿主中」的入口，比不摆更糟：用户会以为功能坏了。
 */
export function canPickFnos(opts: { channel?: string | null; inHost: boolean }): boolean {
  return opts.inHost && opts.channel !== "tcp";
}

/**
 * 顶部「在飞牛打开工作区」按钮要不要出现 —— 纯函数。
 *
 * 在 `canPickFnos` 的基础上再加一条：必须有工作区路径（新对话页可能还没选目录）。
 */
export function canRevealInFnos(opts: { path: string; channel?: string | null; inHost: boolean }): boolean {
  return canPickFnos(opts) && opts.path.trim() !== "";
}

/** 在飞牛里看文件/文件夹详情（宿主能力，App 需要 appApi >= v1.0）。 */
export async function showFnosFileDetails(paths: string[]): Promise<FnosOpenOutcome> {
  if (!inHost()) return { ok: false, reason: "standalone" };
  const sdk = await trimReady();
  if (!sdk) return { ok: false, reason: "bridge" };
  try {
    await sdk.showFileDetails(paths);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 文件所在目录（`/a/b.txt` → `/a`，根目录下的文件 → `/`）。
 *
 * 回退到文件管理器时只能定位目录：把文件路径原样递过去会落在错误的位置。
 */
export function folderOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : "/";
}

/**
 * 用飞牛宿主登记的默认应用打开文件（等同文件管理器里的「打开方式」）。
 *
 * 与 `openFnosFileManager` 的分工：那个只认**目录**，所以这里无法直接打开时退回
 * 文件所在目录——用户会落在文件夹里而不是文档里，但这比报错强：老宿主没有
 * `openFile`、App 端没实现该方法时都会走到这条路，静默降级与 dsh 的插件一致。
 * 调用方不需要为 `fallback` 再弹一次提示。
 */
export async function openFnosFile(path: string): Promise<FnosOpenFileOutcome> {
  if (!inHost()) return { ok: false, reason: "standalone" };
  const sdk = await trimReady();
  if (!sdk) return { ok: false, reason: "bridge" };
  try {
    const result = await sdk.openFile(path);
    // 宿主明确回 false 才表示不支持；undefined / null 是「收下了但没回包」。
    if (result === false) throw new Error("宿主不支持直接打开文件");
    return { ok: true };
  } catch {
    try {
      await sdk.openFileManager(folderOf(path));
      return { ok: true, fallback: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** 在飞牛文件管理器里显示某个目录（「在文件夹显示」）。 */
export async function openFnosFileManager(path: string): Promise<FnosOpenOutcome> {
  if (!inHost()) return { ok: false, reason: "standalone" };
  const sdk = await trimReady();
  if (!sdk) return { ok: false, reason: "bridge" };
  try {
    await sdk.openFileManager(path);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 目录授权的入口选择结果。 */
export type FnosDirAuthOutcome =
  | { state: "ok"; path: string }
  /** 宿主外：已在新窗口打开飞牛授权页，结果靠回调页 postMessage 回来。 */
  | { state: "opened" }
  | { state: "denied"; reason: "cancel" }
  | { state: "denied"; reason: "message"; message: string }
  | { state: "skipped"; reason: FnosAuthSkipReason };

/** 与飞牛选择器一致的分组（不列「他人共享」，避免误授权）。 */
const DIR_SIDEBAR_GROUPS = ["myFiles", "external", "favorites", "team"] as const;

/**
 * 取 SDK 实例但不等宿主握手。
 *
 * 独立浏览器里没有宿主可握手，`trimReady()` 会白等 10 秒才超时——而宿主外的授权
 * （openAppAuth）根本不需要宿主，只需要一个 TrimApp 实例来拼 URL。
 */
async function sdkInstance(): Promise<TrimApp | null> {
  try {
    const mod = await loadSdk();
    instance ??= new mod.TrimApp();
    return instance;
  } catch (e) {
    console.warn("[fnos] SDK 加载失败", e);
    return null;
  }
}

/**
 * 「设置 → 目录」的添加动作：让当前用户授权一个目录给本应用。
 *
 * 两条通路，**不分飞牛 App 版本**（版本分流是 dsh 的事，本应用一律直调）：
 *   - 宿主内（桌面微应用 iframe / App WebView）：`pickUserFile({directory:true})`，
 *     用户选完即授权，直接拿到路径；
 *   - 独立浏览器：`openAppAuth("pickUserFile", …)` 打开飞牛授权页，用户确认后系统跳回
 *     `redirectUri`（我们的回调页），由它 postMessage 通知这边刷新。
 *
 * 判断走哪条只用宿主探测（`inHost()`），不用 `sdk.isStandaloneWeb`：后者要等初始化
 * 结束才可信，而独立浏览器里那次初始化会白等 10 秒超时。
 *
 * 注意 openAppAuth 必须由用户点击触发（浏览器会拦截非手势窗口），所以这里不开定时器。
 */
export async function addFnosDirAuth(opts: {
  appName: string;
  state: string;
  redirectUri: string;
  /** 选择器文案（lib 不碰 i18n，由调用方给）。 */
  title?: string;
  okText?: string;
}): Promise<FnosDirAuthOutcome> {
  if (!inHost()) {
    const sdk = await sdkInstance();
    if (!sdk) return { state: "skipped", reason: "bridge" };
    try {
      await sdk.openAppAuth(
        "pickUserFile",
        {
          appName: opts.appName,
          directory: true,
          sidebarGroup: [...DIR_SIDEBAR_GROUPS],
          redirectUri: opts.redirectUri,
          state: opts.state,
        },
        { target: "_blank", features: "width=750,height=630" },
      );
      return { state: "opened" };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { state: "denied", reason: "message", message };
    }
  }
  const sdk = await trimReady();
  if (!sdk) return { state: "skipped", reason: "bridge" };
  try {
    const res = await sdk.pickUserFile({
      directory: true,
      title: opts.title,
      okText: opts.okText,
      sidebarGroup: [...DIR_SIDEBAR_GROUPS],
    });
    return classifyPickResult(res);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { state: "denied", reason: "message", message };
  }
}
