import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadFile, sessionLogName } from "./download";
import { setToken } from "./runtime";

describe("downloadFile", () => {
  const createObjectURL = vi.fn(() => "blob:mock");
  const revokeObjectURL = vi.fn();
  let clicks: string[] = [];

  beforeEach(() => {
    clicks = [];
    setToken("tok-1");
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("带 Bearer 请求，成功后触发浏览器下载", async () => {
    const fetchMock = vi.fn(async () => new Response(new Blob(["zip"]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await downloadFile("/api/history/export?id=abc", sessionLogName("abc"));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/history/export?id=abc");
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer tok-1");
    expect(createObjectURL).toHaveBeenCalled();
    expect(clicks).toEqual(["claude-session-abc.zip"]);
  });

  it("非 2xx 抛错，不触发下载", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    await expect(downloadFile("/api/history/export?id=x", "x.zip")).rejects.toThrow("HTTP 404");
    expect(clicks).toEqual([]);
  });
});
