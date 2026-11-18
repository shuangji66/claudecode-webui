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

/**
 * 用已经拼好鉴权参数的地址触发一次下载（大文件不经过 blob 内存）。
 *
 * 文件名由后端 `Content-Disposition: attachment` 给（目录是 `<目录名>.zip`），
 * 这里不需要也不该再传 `download` 属性——同源时它会被响应头覆盖。
 */
export function startDownload(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
