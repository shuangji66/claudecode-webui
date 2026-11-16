import { describe, expect, it } from "vitest";
import { formatArgs, formatPairs, parseArgs, parsePairs, summarize, validateDraft } from "./mcpForm";
import type { McpServer } from "../transport/types";

describe("parseArgs / formatArgs", () => {
  it("一行一个参数，空行忽略，顺序不变", () => {
    expect(parseArgs("-y\n@playwright/mcp\n\n--headless")).toEqual(["-y", "@playwright/mcp", "--headless"]);
    expect(parseArgs("   \n\n")).toEqual([]);
  });

  it("带空格的参数不会被拆开（这就是不用空格分隔的原因）", () => {
    expect(parseArgs("--config\n/path with space/x.json")).toEqual(["--config", "/path with space/x.json"]);
  });

  it("回填与解析互逆", () => {
    const args = ["-y", "server", "--flag"];
    expect(parseArgs(formatArgs(args))).toEqual(args);
    expect(formatArgs(undefined)).toBe("");
  });
});

describe("parsePairs", () => {
  it("解析 KEY=VALUE，值里的等号保留", () => {
    const { pairs, invalid } = parsePairs("TOKEN=abc==\nDEBUG=1\n");
    expect(pairs).toEqual({ TOKEN: "abc==", DEBUG: "1" });
    expect(invalid).toEqual([]);
  });

  it("缺等号或键名非法的行单独报出来，不吞掉整段", () => {
    const { pairs, invalid } = parsePairs("GOOD=1\nbad line\n3X=2\n=空键");
    expect(pairs).toEqual({ GOOD: "1" });
    expect(invalid).toEqual(["bad line", "3X=2", "=空键"]);
  });

  it("回填按键名排序，便于对比", () => {
    expect(formatPairs({ B: "2", A: "1" })).toBe("A=1\nB=2");
    expect(formatPairs(undefined)).toBe("");
  });
});

describe("summarize", () => {
  const base: McpServer = { name: "x", scope: "user", type: "stdio", disabled: false, config_path: "" };

  it("stdio 拼命令与参数", () => {
    expect(summarize({ ...base, command: "npx", args: ["-y", "mcp"] })).toBe("npx -y mcp");
  });

  it("远程只给地址", () => {
    expect(summarize({ ...base, type: "http", url: "https://x/mcp" })).toBe("https://x/mcp");
  });
});

describe("validateDraft", () => {
  it("名字必须符合 mcp__<name>__<tool> 的可用字符", () => {
    expect(validateDraft({ name: "github", type: "stdio", command: "npx", url: "" })).toBe("");
    expect(validateDraft({ name: "", type: "stdio", command: "npx", url: "" })).toBe("name");
    expect(validateDraft({ name: "a b", type: "stdio", command: "npx", url: "" })).toBe("name");
  });

  it("stdio 必须给命令，远程必须是 http(s)", () => {
    expect(validateDraft({ name: "x", type: "stdio", command: " ", url: "" })).toBe("command");
    expect(validateDraft({ name: "x", type: "http", command: "", url: "" })).toBe("url");
    expect(validateDraft({ name: "x", type: "sse", command: "", url: "ftp://x" })).toBe("url");
    expect(validateDraft({ name: "x", type: "sse", command: "", url: "https://x" })).toBe("");
  });
});
