import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { OoxmlTooLargeError, normalizePartPath, unzipParts } from "./ooxml";

function zipOf(entries: Record<string, Uint8Array>): Uint8Array {
  return zipSync(entries);
}

describe("unzipParts", () => {
  it("只保留 keep 认可的部件，路径归一化", () => {
    const parts = unzipParts(
      zipOf({ "/xl/workbook.xml": new Uint8Array([1, 2]), "xl/media/b.png": new Uint8Array([3]) }),
      (name) => name.endsWith("workbook.xml"),
    );
    expect(Object.keys(parts)).toEqual(["xl/workbook.xml"]);
    expect(Array.from(parts["xl/workbook.xml"])).toEqual([1, 2]);
  });

  it("单条解压后超过 entryBytes 时整包报错，且不再继续解压", () => {
    // 全 0 的 2000 字节压缩后只有几十字节，正是 zip bomb 的形状。
    const data = zipOf({ "big.xml": new Uint8Array(2000), "small.xml": new Uint8Array(10) });
    expect(() => unzipParts(data, () => true, { totalBytes: 1 << 20, entryBytes: 1000 })).toThrow(
      OoxmlTooLargeError,
    );
  });

  it("总量超过 totalBytes 时整包报错", () => {
    const data = zipOf({ "a.xml": new Uint8Array(800), "b.xml": new Uint8Array(800) });
    expect(() => unzipParts(data, () => true, { totalBytes: 1000, entryBytes: 900 })).toThrow(OoxmlTooLargeError);
  });

  it("被 keep 拒绝的条目不计入预算", () => {
    const data = zipOf({ "keep.xml": new Uint8Array(100), "huge.bin": new Uint8Array(5000) });
    const parts = unzipParts(data, (name) => name === "keep.xml", { totalBytes: 200, entryBytes: 200 });
    expect(Object.keys(parts)).toEqual(["keep.xml"]);
  });

  it("报错里带触发上限的部件路径，便于用户判断是哪个嵌入对象太大", () => {
    const data = zipOf({ "ppt/media/movie.mp4": new Uint8Array(4096) });
    try {
      unzipParts(data, () => true, { totalBytes: 1 << 20, entryBytes: 1024 });
      throw new Error("应当抛错");
    } catch (e) {
      expect(e).toBeInstanceOf(OoxmlTooLargeError);
      expect((e as OoxmlTooLargeError).part).toBe("ppt/media/movie.mp4");
      expect((e as OoxmlTooLargeError).message).toContain("ppt/media/movie.mp4");
    }
  });
});

describe("normalizePartPath", () => {
  it("折叠 .. 与前导斜杠", () => {
    expect(normalizePartPath("/xl/worksheets/sheet1.xml")).toBe("xl/worksheets/sheet1.xml");
    expect(normalizePartPath("ppt/slides/../media/a.png")).toBe("ppt/media/a.png");
    expect(normalizePartPath("./a//b")).toBe("a/b");
  });
});
