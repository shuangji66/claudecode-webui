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

/** 拼 WebSocket 地址（浏览器无法给 WS 设置自定义头，鉴权只能走 query）。 */
export function wsUrl(sessionId: string, token: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${proto}//${window.location.host}${runtimeBase()}/ws?id=${encodeURIComponent(sessionId)}`;
  return token ? `${base}&token=${encodeURIComponent(token)}` : base;
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
