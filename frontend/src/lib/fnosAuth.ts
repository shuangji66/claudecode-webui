// 飞牛「路由授权」回调页的纯逻辑（宿主外添加授权目录用）。
//
// 背景：页面跑在独立浏览器里（`sdk.isStandaloneWeb === true`）时，`pickUserFile`
// 这类需要宿主参与的能力调不到。飞牛的正规做法是把用户送到系统授权页：
//
//   openAppAuth("pickUserFile", { appName, directory: true, redirectUri, state })
//
// 用户确认后，系统把结果拼在 query 上跳回 `redirectUri`，形如
//
//   /app/ClaudeCode/callback?status=success&method=pickUserFile&path=["/vol1/home"]
//                              &appName=ClaudeCode&state=<我们生成的随机串>
//
// 回调页要做两件事：解析结果并**校验 state**（防止别的页面/重放的结果被当成这次授权），
// 然后 postMessage 通知原页面刷新（原页面可能已被浏览器放在另一个标签/窗口里）。
//
// 解析逻辑与 SDK 的 `parseAppAuthCallback` 同一份字段，但这里自己实现：
//   - 回调页只需要读一次 query，没必要为它把整个 SDK 加载进来；
//   - 参数形状是飞牛文档写死的，自己实现可以在单测里逐个字段钉住。

/** 回调页挂在应用前缀下的固定路径；`redirectUri` 用它。 */
export const AUTH_CALLBACK_PATH = "/callback";

/** 回调页 → 原页面的消息类型（只认自己发的那种）。 */
export const AUTH_MESSAGE = "ccweb:dir-auth";

/** 授权结果状态；`success` 才代表飞牛真的写了授权。 */
export type AuthStatus = "success" | "cancel" | "error";

export interface AuthResult {
  status?: AuthStatus;
  /** 飞牛给的错误码（例如 access_denied）。 */
  error?: string;
  /** 实际被授权/选择的方法，例如 pickUserFile。 */
  method?: string;
  appName?: string;
  /** 本次请求的业务随机串，必须与发起时一致。 */
  state?: string;
  /** 被授权的路径（目录授权是其中一个）。 */
  paths: string[];
}

/** 应用前缀下的回调地址（不含 origin）：`/app/ClaudeCode` + `/callback`。 */
export function authCallbackPath(base: string): string {
  const prefix = base.replace(/\/+$/, "");
  return `${prefix}${AUTH_CALLBACK_PATH}`;
}

/**
 * 当前 pathname 是不是回调页。
 *
 * 只认「前缀 + /callback」这一条：回调页要跳过整个应用壳层（令牌门、侧栏、WS），
 * 认错就会在授权回来时把用户丢进一个半初始化的应用里。
 */
export function isAuthCallbackPath(pathname: string, base: string): boolean {
  const want = authCallbackPath(base);
  const got = pathname.replace(/\/+$/, "");
  return got === want;
}

/** 生成业务随机串：回调页靠它确认结果来自本次请求。 */
export function newAuthState(): string {
  const cryptoObj = typeof crypto !== "undefined" ? crypto : undefined;
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    const buf = new Uint8Array(16);
    cryptoObj.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // 老 WebView 没有 crypto：退化成时间戳 + 随机数，够防止「结果张冠李戴」。
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function pickStatus(v: string | null): AuthStatus | undefined {
  return v === "success" || v === "cancel" || v === "error" ? v : undefined;
}

/** 把 `path` 参数（JSON 字符串数组）解析成路径列表；坏 JSON 当没有。 */
function parsePaths(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  } catch {
    return [];
  }
}

/** 解析授权回包（入参是 `location.search`、完整 URL 或已解析的 params）。 */
export function readAuthResult(input: string | URLSearchParams): AuthResult {
  let params: URLSearchParams;
  if (input instanceof URLSearchParams) {
    params = input;
  } else if (input.startsWith("?") || input.startsWith("&")) {
    params = new URLSearchParams(input);
  } else if (input.includes("?") || input.includes("://")) {
    try {
      params = new URL(input, "http://localhost").searchParams;
    } catch {
      params = new URLSearchParams(input);
    }
  } else {
    params = new URLSearchParams(input);
  }
  return {
    status: pickStatus(params.get("status")),
    error: params.get("error") ?? undefined,
    method: params.get("method") ?? undefined,
    appName: params.get("appName") ?? undefined,
    state: params.get("state") ?? undefined,
    paths: parsePaths(params.get("path")),
  };
}

/**
 * 只看状态给结论——回调页用。
 *
 * 回调页拿不到原页面生成的 state（那是发起方内存里的一次性随机串），只能转交；
 * **state 的比对必须由发起方自己做**（`authSucceeded`），否则任何页面编一条
 * `?status=success` 就能冒充一次授权。
 */
export function authStatusOutcome(result: AuthResult): "ok" | "cancel" | "error" {
  if (result.status === "success") return "ok";
  if (result.status === "cancel" || result.error === "access_denied") return "cancel";
  return "error";
}

/** 发起方用：这次回包是不是自己发起的（state 一致），且用户确实完成了授权。 */
export function authSucceeded(result: AuthResult, expectedState: string): boolean {
  if (!expectedState || result.state !== expectedState) return false;
  return result.status === "success";
}
