// 需要鉴权的文件下载：浏览器里 <a download> 带不上 Authorization 头，
// 所以先 fetch 成 blob 再交给浏览器保存。token 走头而不是 URL，避免留在浏览历史里。

import { apiUrl, getToken } from "./runtime";

/** 下载一个需要鉴权的文件。失败抛错，由调用方给用户反馈。 */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const headers = new Headers();
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(apiUrl(path), { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让部分浏览器取消下载，挪到下一轮事件循环。
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 会话日志导出的文件名（与后端 Content-Disposition 保持一致）。 */
export function sessionLogName(id: string): string {
  return `claude-session-${id}.zip`;
}

/** 走 blob 下载的体积上限：再大就不能整份进内存（移动端会直接崩）。 */
export const MAX_BLOB_DOWNLOAD = 256 << 20;

/**
 * 下载一个已经带好鉴权参数的地址，文件名用于保存。
 *
 * 为什么先 fetch 成 blob 再点 `<a download>`，而不是直接让浏览器打开下载地址：
 * 后者（以及任何顶层导航）在飞牛 App 的 WebView / 宿主 iframe 里会被当成一次
 * 页面跳转——应用页面被换掉，WS 随之断开再重连（用户看到「下载时闪一下断线」）。
 * blob 地址不经过导航，页面与 WS 都留在原地（DSH 在同一个宿主里也是这个做法）。
 *
 * 文件超过 `MAX_BLOB_DOWNLOAD` 时退回隐藏 iframe：体积太大不能进内存，而 iframe
 * 的导航只发生在子框架里，同样不会碰应用页面。
 */
export async function downloadFromUrl(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BLOB_DOWNLOAD) {
    downloadInFrame(url);
    return;
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让部分浏览器取消下载，挪到下一轮事件循环。
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

/**
 * 用隐藏 iframe 触发浏览器原生下载（目录的 zip、超大文件）。
 *
 * 关键是**不碰应用文档**：顶层锚点导航会把页面换成下载响应 / 错误页，
 * 子框架导航不会。文件名由后端的 `Content-Disposition: attachment` 给。
 */
export function downloadInFrame(url: string): void {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.setAttribute("aria-hidden", "true");
  frame.src = url;
  document.body.appendChild(frame);
  // 下载在浏览器侧独立进行，框架本身可以收掉；留一段时间只是稳妥。
  window.setTimeout(() => frame.remove(), 120_000);
}
