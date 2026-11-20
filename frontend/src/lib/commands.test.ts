import { describe, expect, it } from "vitest";
import { commandQuery, matchCommands } from "./commands";
import type { CommandInfo } from "../transport/types";

const command = (name: string): CommandInfo => ({ name, description: `${name} 的说明` });

const LIST: CommandInfo[] = [
  command("compact"),
  command("cost-report"),
  command("model"),
  command("context"),
];

describe("commandQuery", () => {
  it("整条正文是 /名字 时返回查询串", () => {
    expect(commandQuery("/")).toBe("");
    expect(commandQuery("/co")).toBe("co");
  });

  it("敲出空格就不再是补全：那已经是在发指令了", () => {
    expect(commandQuery("/compact ")).toBeUndefined();
    expect(commandQuery("/compact 额外参数")).toBeUndefined();
  });

  it("不在行首的 / 与普通正文都不触发", () => {
    expect(commandQuery("看看 /compact")).toBeUndefined();
    expect(commandQuery("https://example.com")).toBeUndefined();
    expect(commandQuery("")).toBeUndefined();
  });
});

describe("matchCommands", () => {
  it("空查询给全部指令（与「+ → 指令」看到的是同一份）", () => {
    expect(matchCommands(LIST, "/")).toEqual(LIST);
  });

  it("前缀命中排在全量子串命中之前", () => {
    // `co` 想找的是 compact；cost-report / context 是子串命中，不能排在它前面。
    expect(matchCommands(LIST, "/co").map((c) => c.name)).toEqual(["compact", "cost-report", "context"]);
  });

  it("两组内部保持 CLI 给的顺序", () => {
    expect(matchCommands(LIST, "/con").map((c) => c.name)).toEqual(["context"]);
  });

  it("没有命中时给空数组", () => {
    expect(matchCommands(LIST, "/zzz")).toEqual([]);
  });

  it("不截断：指令再多也全给", () => {
    const many = Array.from({ length: 40 }, (_, i) => command(`cmd-${i}`));
    expect(matchCommands(many, "/")).toHaveLength(40);
    expect(matchCommands(many, "/cmd")).toHaveLength(40);
  });

  it("不是补全状态时给空数组", () => {
    expect(matchCommands(LIST, "/compact ")).toEqual([]);
    expect(matchCommands(LIST, "普通正文")).toEqual([]);
  });
});
