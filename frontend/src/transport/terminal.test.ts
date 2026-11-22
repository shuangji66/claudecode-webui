import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalConnection, type TerminalStatusDetail } from "./terminal";

/** 记录所有 onStatus 回调，供断言。 */
function recorder() {
  const seen: TerminalStatusDetail[] = [];
  return {
    seen,
    onStatus: (d: TerminalStatusDetail) => {
      seen.push(d);
    },
    onOutput: () => {},
  };
}

describe("TerminalConnection 建连前的名额检查", () => {
  const opened: string[] = [];

  beforeEach(() => {
    opened.length = 0;
    // WebSocket 桩：只记下被请求的 URL，不做任何事。
    class FakeWS {
      binaryType = "";
      onopen: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      readyState = 0;
      constructor(public url: string) {
        opened.push(url);
      }
      send() {}
      close() {}
    }
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("名额已满时不开 WebSocket，直接给出可读原因", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ used: 32, limit: 32, full: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const rec = recorder();
    const conn = new TerminalConnection("/w", 80, 24, "t", rec);
    conn.connect();
    await vi.waitFor(() => expect(rec.seen.some((d) => d.phase === "error")).toBe(true));

    const err = rec.seen.find((d) => d.phase === "error");
    // 文案要说清「上限多少」，不能只留一句通用的「终端错误」。
    expect(err?.message).toContain("32");
    // 关键：那条注定被 429 的连接根本不该发起。
    expect(opened).toHaveLength(0);
  });

  it("还有名额时照常建连", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ used: 3, limit: 32, full: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const rec = recorder();
    const conn = new TerminalConnection("/w", 80, 24, "t", rec);
    conn.connect();
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(rec.seen.some((d) => d.phase === "error")).toBe(false);
  });

  it("名额接口不可用（老后端 / 网络抖动）时放行，交给 WS 自己报错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const rec = recorder();
    const conn = new TerminalConnection("/w", 80, 24, "t", rec);
    conn.connect();
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(rec.seen.some((d) => d.phase === "error")).toBe(false);
  });
});
