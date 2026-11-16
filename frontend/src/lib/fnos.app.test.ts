// 飞牛 App 内是顶层 WebView（没有 parent frame），宿主判定不能只看 iframe。
// 这里 mock 掉 SDK，验证「UA 带 App 标识 → 真的去调宿主桥接」。
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];

vi.mock("@trimjs/web-app", () => {
  class TrimApp {
    ready() {
      return Promise.resolve();
    }
    openFileManager(path: string) {
      calls.push(path);
      return Promise.resolve({ code: 0 });
    }
    pickUserFile() {
      return Promise.resolve({ code: 0, data: ["/vol1/1000/demo"] });
    }
    authorizeUserFile() {
      return Promise.resolve({ code: 0, data: true });
    }
    showFileDetails(paths: string[]) {
      calls.push(...paths);
      return Promise.resolve({ code: 0 });
    }
  }
  return { TrimApp, default: TrimApp };
});

import { openFnosFileManager, pickFnosDir, showFnosFileDetails } from "./fnos";

const APP_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) FNAppType/ios FNAppVer/1.38.0";

function setUA(value: string) {
  Object.defineProperty(navigator, "userAgent", { value, configurable: true });
}

describe("飞牛 App 内 WebView", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("UA 带 App 标识时走宿主桥接打开文件管理器", async () => {
    setUA(APP_UA);
    await expect(openFnosFileManager("/vol1/1000/demo")).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["/vol1/1000/demo"]);
  });

  it("App 里也能调目录选择器", async () => {
    setUA(APP_UA);
    await expect(pickFnosDir()).resolves.toEqual({ state: "ok", path: "/vol1/1000/demo" });
  });

  it("普通浏览器 UA 仍然直接跳过，不碰桥接", async () => {
    setUA("Mozilla/5.0 (Macintosh) Chrome/120");
    await expect(openFnosFileManager("/vol1/1000/demo")).resolves.toEqual({ ok: false, reason: "standalone" });
    expect(calls).toEqual([]);
  });
});

describe("只有原生桥、没有 UA 标识的 WebView", () => {
  it("注入了 flutter_inappwebview 也算在宿主里", async () => {
    calls.length = 0;
    setUA("Mozilla/5.0 (Linux; Android 14) Chrome/120");
    (window as unknown as { flutter_inappwebview?: unknown }).flutter_inappwebview = {};
    try {
      await expect(openFnosFileManager("/vol1/1000/demo")).resolves.toEqual({ ok: true });
      expect(calls).toEqual(["/vol1/1000/demo"]);
    } finally {
      delete (window as unknown as { flutter_inappwebview?: unknown }).flutter_inappwebview;
    }
  });
});

describe("文件详情", () => {
  it("App 里能把路径交给宿主显示详情", async () => {
    calls.length = 0;
    setUA(APP_UA);
    await expect(showFnosFileDetails(["/vol1/1000/demo/README.md"])).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["/vol1/1000/demo/README.md"]);
  });

  it("普通浏览器里直接跳过，不碰桥接", async () => {
    calls.length = 0;
    setUA("Mozilla/5.0 (Macintosh) Chrome/120");
    await expect(showFnosFileDetails(["/vol1/1000/demo/README.md"])).resolves.toEqual({
      ok: false,
      reason: "standalone",
    });
    expect(calls).toEqual([]);
  });
});
