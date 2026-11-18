import { describe, expect, it } from "vitest";
import {
  applyMention,
  formatMention,
  mentionAt,
  mentionCrumbs,
  mentionDir,
  mentionFragment,
} from "./mention";

describe("mentionAt", () => {
  it("识别行首与空白之后的 @", () => {
    expect(mentionAt("@", 1)).toEqual({ start: 0, end: 1, query: "", quoted: false });
    expect(mentionAt("hi @sr", 6)).toEqual({ start: 3, end: 6, query: "sr", quoted: false });
    expect(mentionAt("第一行\n@src/ma", 11)).toEqual({
      start: 4,
      end: 11,
      query: "src/ma",
      quoted: false,
    });
  });

  it("把光标当成 token 的结束位置", () => {
    expect(mentionAt("@abc def", 3)).toEqual({ start: 0, end: 3, query: "ab", quoted: false });
    expect(mentionAt("@abc", 0)).toBeUndefined();
  });

  it("不把邮箱/正文里的 @ 当触发符", () => {
    expect(mentionAt("user@example.com", 16)).toBeUndefined();
    expect(mentionAt("hi@", 3)).toBeUndefined();
    expect(mentionAt("a@b c", 5)).toBeUndefined();
  });

  it("空格结束普通 token", () => {
    expect(mentionAt("@a b", 4)).toBeUndefined();
  });

  it("引号写法里空格属于路径，闭合后菜单收起", () => {
    expect(mentionAt('@"my file', 9)).toEqual({ start: 0, end: 9, query: "my file", quoted: true });
    expect(mentionAt('open @"a b"', 11)).toBeUndefined();
  });
});

describe("formatMention", () => {
  it("普通路径不加引号，目录以 / 结尾", () => {
    expect(formatMention("src/a.ts", "file")).toBe("@src/a.ts");
    expect(formatMention("src", "dir")).toBe("@src/");
  });

  it("含空格的路径用引号，目录保持引号打开", () => {
    expect(formatMention("my dir/a.ts", "file")).toBe('@"my dir/a.ts"');
    expect(formatMention("my dir", "dir")).toBe('@"my dir/');
    expect(formatMention("src", "dir", true)).toBe('@"src/');
  });

  it("根目录是单独一个 @", () => {
    expect(formatMention("", "dir")).toBe("@");
    expect(formatMention("", "dir", true)).toBe('@"');
  });

  it("无法回读的路径拒绝插入", () => {
    expect(formatMention('a"b.ts', "file")).toBeUndefined();
    expect(formatMention("a\tb.ts", "file")).toBeUndefined();
  });
});

describe("applyMention", () => {
  it("只替换 token，光标停在插入值之后", () => {
    const text = "看看 @sr";
    const token = mentionAt(text, text.length);
    expect(token).toBeDefined();
    const next = applyMention(text, token!, "@src/a.ts ");
    expect(next.text).toBe("看看 @src/a.ts ");
    expect(next.caret).toBe(next.text.length);
  });
});

describe("目录拆分与面包屑", () => {
  it("拆出目录部分与过滤片段", () => {
    expect(mentionDir("src/nested/x")).toBe("src/nested/");
    expect(mentionFragment("src/nested/x")).toBe("x");
    expect(mentionDir("src")).toBe("");
    expect(mentionFragment("src")).toBe("src");
  });

  it("面包屑只给目录路径，逐层可回退", () => {
    expect(mentionCrumbs("src/nested/x")).toEqual([
      { label: "src", query: "src" },
      { label: "nested", query: "src/nested" },
    ]);
    expect(mentionCrumbs("src")).toEqual([]);
    expect(mentionCrumbs("")).toEqual([]);
  });
});
