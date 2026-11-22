// 代理地址的协议判定：与后端 settings.NormalizeProxyURL 同一条规则。
//
// 为什么只收 http/https：claude 二进制是 Bun 打包的，它的 fetch 只支持 HTTP 代理。
// 填 `socks5://` 时既不握手也不直连，而是把每个请求判成
// `API Error: Unable to connect to API (UnsupportedProxyProtocol)`——会话一个字都跑不出来。
// 想走 SOCKS 只能让代理客户端（Clash / sing-box 之类）开一个 HTTP 端口，填那个。

/** 代理地址不满足规则的原因；null 表示合规。 */
export type ProxyIssue = "scheme" | "host" | null;

export function proxyUrlIssue(raw: string): ProxyIssue {
  const url = raw.trim();
  if (url === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "host";
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") return "scheme";
  if (!parsed.hostname) return "host";
  return null;
}
