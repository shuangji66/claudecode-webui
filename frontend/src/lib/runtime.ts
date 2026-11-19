// 运行时路径解析。
//
// 部署形态是「挂在网关某个 baseurl 前缀下」，而前缀在构建期未知：
// 后端在返回 index.html 时注入 <base href="…">，所以这里统一以 <base> 为准，
// 前端任何请求都不得硬编码路径。

const TOKEN_KEY = "ccweb-token";

/** 返回去掉尾斜杠的 baseurl 前缀（无前缀时返回空串）。 */
export function runtimeBase(): string {
  const el = document.querySelector("base");
  const href = el?.getAttribute("href") ?? "";
  if (href) {
    try {
      const u = new URL(href, window.location.href);
      return u.pathname.replace(/\/+$/, "");
    } catch {
      // 解析失败则退回按字符串处理
      return href.replace(/\/+$/, "");
    }
  }
  return "";
}

/** 拼一个同源 API 路径。 */
export function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${runtimeBase()}${p}`;
}

/** 拼 WebSocket 地址（浏览器无法给 WS 设置自定义头，鉴权只能走 query）。
 *  sessionId 为空串表示**系统通道**：只收应用级事件（claude 更新提示），
 *  与会话生命周期无关——没有打开任何对话时也要能连上。 */
export function wsUrl(sessionId: string, token: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = sessionId ? `?id=${encodeURIComponent(sessionId)}` : "";
  const base = `${proto}//${window.location.host}${runtimeBase()}/ws${query}`;
  if (!token) return base;
  return `${base}${query ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可（本次会话内仍可用内存值）
  }
}

/** 登录失败的分类错误：401=密码错，409=端口访问未开启，其余看后端原因。 */
export class AccessError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AccessError";
    this.status = status;
  }
}

/**
 * 用访问密码换登录会话令牌。
 *
 * 密码只在这一次请求里发送；之后所有请求带的是随机会话令牌（服务端只存摘要，
 * 内存里记会话）。这样 localStorage 里即使被读到，也拿不到密码本身。
 * 网络异常会抛出（不是 AccessError），由调用方区分「密码错」和「连不上」。
 */
export async function loginAccess(password: string): Promise<string> {
  const res = await fetch(apiUrl("/api/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    cache: "no-store",
  });
  const text = await res.text();
  let body: { token?: string; error?: string } | null = null;
  try {
    body = text ? (JSON.parse(text) as { token?: string; error?: string }) : null;
  } catch {
    body = null;
  }
  if (!res.ok) throw new AccessError(res.status, body?.error ?? `HTTP ${res.status}`);
  const token = body?.token ?? "";
  if (!token) throw new AccessError(res.status, "invalid login response");
  return token;
}

/** 带鉴权头的 fetch 封装。 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(apiUrl(path), { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as Record<string, unknown>).error)
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

/**
 * 带鉴权头的原始字节请求（Office 预览用）。
 *
 * 与 apiFetch 的区别只在响应体：那条一律按 JSON 解析，而这里要把 zip 字节原样
 * 交给解析器。错误仍是 JSON（后端 writeErr），所以失败时照样读一次 `error`。
 */
export async function apiFetchBytes(path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const token = getToken();
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(apiUrl(path), { headers, signal, cache: "no-store" });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (body && typeof body.error === "string" && body.error) message = body.error;
    } catch {
      // 不是 JSON 就用状态码。
    }
    throw new Error(message);
  }
  return res.arrayBuffer();
}

/** 内置终端的 WebSocket 地址（浏览器无法给 WS 设置自定义头，鉴权走 query）。 */
export function terminalWsUrl(cwd: string, cols: number, rows: number, token: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base =
    `${proto}//${window.location.host}${runtimeBase()}/ws/terminal` +
    `?cwd=${encodeURIComponent(cwd)}&cols=${Math.max(2, Math.round(cols))}&rows=${Math.max(1, Math.round(rows))}`;
  return token ? `${base}&token=${encodeURIComponent(token)}` : base;
}

/**
 * 工作区文件的下载地址（文件原样、目录打包成 zip）。
 *
 * 走浏览器原生下载而不是 fetch→blob：NAS 上的文件可能很大，blob 会整份进内存；
 * 而 `<a>` 带不上 Authorization 头，token 只能放 query（与 raw 预览同一条限制）。
 */
export function fsDownloadUrl(cwd: string, path: string): string {
  const token = getToken();
  const base = `${apiUrl("/api/fs/download")}?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`;
  return token ? `${base}&token=${encodeURIComponent(token)}` : base;
}

/** 图片 / PDF 的 inline 预览地址；token 只能放在 query 里。 */
export function rawFileUrl(cwd: string, path: string): string {
  const token = getToken();
  const base = `${apiUrl("/api/fs/raw")}?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`;
  return token ? `${base}&token=${encodeURIComponent(token)}` : base;
}
