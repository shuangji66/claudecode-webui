import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadFromUrl, downloadInFrame, MAX_BLOB_DOWNLOAD } from "./download";

/** 造一个 fetch 的假响应：只带下载路径用到的字段。 */
function response(init: { ok?: boolean; size?: number; length?: number | null }) {
  const blob = new Blob([new Uint8Array(init.size ?? 3)]);
  return {
    ok: init.ok ?? true,
    status: init.ok === false ? 403 : 200,
    headers: new Headers(init.length === null ? {} : { "content-length": String(init.length ?? init.size ?? 3) }),
    blob: async () => blob,
  } as unknown as Response;
}

let clicked: string[] = [];

beforeEach(() => {
  clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this.download);
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("downloadFromUrl", () => {
  it("拿 blob 后点 <a download>，不导航页面", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ size: 3 })));

    await downloadFromUrl("/api/fs/download?path=a.txt", "a.txt");

    expect(clicked).toEqual(["a.txt"]);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    // 下载不产生任何导航用的 iframe。
    expect(document.querySelector("iframe")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("超过体积上限时改走隐藏 iframe（不把大文件读进内存）", async () => {
    const fetchMock = vi.fn(async () => response({ size: 1, length: MAX_BLOB_DOWNLOAD + 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await downloadFromUrl("/api/fs/download?path=big.bin", "big.bin");

    expect(clicked).toEqual([]);
    const frame = document.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe("/api/fs/download?path=big.bin");
    vi.unstubAllGlobals();
  });

  it("HTTP 失败要报错，不给用户一个空文件", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ ok: false, size: 0 })));

    await expect(downloadFromUrl("/api/fs/download?path=x", "x")).rejects.toThrow("HTTP 403");
    vi.unstubAllGlobals();
  });
});

describe("downloadInFrame", () => {
  it("用隐藏 iframe 承载下载（导航不进应用文档）", () => {
    downloadInFrame("/api/fs/download?path=dir");
    const frame = document.querySelector("iframe");
    expect(frame?.hidden).toBe(true);
    expect(frame?.getAttribute("aria-hidden")).toBe("true");
    expect(frame?.getAttribute("src")).toBe("/api/fs/download?path=dir");
  });
});
