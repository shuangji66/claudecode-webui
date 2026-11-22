import { describe, expect, it } from "vitest";
import { proxyUrlIssue } from "./proxy";

describe("proxyUrlIssue", () => {
  it("空串表示直连，不算问题", () => {
    expect(proxyUrlIssue("")).toBeNull();
    expect(proxyUrlIssue("   ")).toBeNull();
  });

  it("http/https 通过", () => {
    expect(proxyUrlIssue("http://127.0.0.1:7890")).toBeNull();
    expect(proxyUrlIssue("https://proxy.example:443")).toBeNull();
    expect(proxyUrlIssue("http://user:pass@127.0.0.1:7890")).toBeNull();
  });

  // claude 是 Bun 打包的，收到 socks5:// 只会报 UnsupportedProxyProtocol。
  it("SOCKS 一律拒绝", () => {
    expect(proxyUrlIssue("socks5://127.0.0.1:1080")).toBe("scheme");
    expect(proxyUrlIssue("socks5h://proxy.example:1080")).toBe("scheme");
    expect(proxyUrlIssue("socks4://x:1")).toBe("scheme");
  });

  it("其它协议与缺主机都拒绝", () => {
    expect(proxyUrlIssue("ftp://x:1")).toBe("scheme");
    expect(proxyUrlIssue("127.0.0.1:7890")).toBe("host");
    expect(proxyUrlIssue("http://")).toBe("host");
  });
});
