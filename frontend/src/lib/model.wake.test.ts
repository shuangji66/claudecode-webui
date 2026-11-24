import { describe, expect, it } from "vitest";
import { wakeKind, wakeLabel, type WakeItem } from "./model";

const wake = (over: Partial<WakeItem> = {}): WakeItem => ({
  id: "w1",
  seq: 0,
  ts: 0,
  kind: "wake",
  origin: "task",
  text: "",
  ...over,
});

describe("wakeKind（通知是谁发的）", () => {
  it("按 CLI 的 summary 模板分，不按里面有没有 Agent 三个字母", () => {
    expect(wakeKind(wake({ summary: 'Agent "审查代码" finished' }))).toBe("agent");
    expect(wakeKind(wake({ summary: 'Background command "npm test" completed (exit code 0)' }))).toBe("command");
    // 同一句里带 "Background shell command"（老模板）。
    expect(wakeKind(wake({ summary: "Background shell command didn't finish before the previous session ended" }))).toBe("command");
    expect(wakeKind(wake({ summary: 'Background agent "审查代码" didn\'t finish' }))).toBe("background-agent");
    expect(wakeKind(wake({ summary: 'Remote task "x" finished' }))).toBe("agent");
    // 认不出的不猜角色，只报状态。
    expect(wakeKind(wake({ summary: "something else" }))).toBe("other");
    expect(wakeKind(wake())).toBe("other");
  });
});

describe("wakeLabel", () => {
  it("后台命令不写成子代理", () => {
    expect(wakeLabel(wake({ summary: 'Background command "npm test" completed', status: "completed" }))).toBe(
      "后台命令「npm test」已完成",
    );
    expect(wakeLabel(wake({ summary: 'Agent "找新闻" finished', status: "completed" }))).toBe("子代理「找新闻」已完成");
  });

  it("摘不出名字时只说角色 + 状态，不把整句英文搁进去", () => {
    expect(wakeLabel(wake({ summary: "Background shell command didn't finish before the previous session ended", status: "stopped" }))).toBe(
      "后台命令已停止",
    );
    expect(wakeLabel(wake({ status: "completed" }))).toBe("已完成");
  });

  it("状态未知时说「已返回」，不猜成功", () => {
    expect(wakeLabel(wake({ summary: 'Agent "x" finished' }))).toBe("子代理「x」已返回");
  });

  it("英文界面同一套角色词", () => {
    expect(wakeLabel(wake({ summary: 'Background command "npm test" completed', status: "completed" }), "en")).toBe(
      'Background command "npm test" — finished',
    );
    expect(wakeLabel(wake({ status: "stopped" }), "en")).toBe("stopped");
  });
});
