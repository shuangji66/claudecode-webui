import { describe, expect, it } from "vitest";
import {
  RULE_KINDS,
  defaultRule,
  ruleSummary,
  statusLabel,
  targetLabel,
  toLocalInput,
  toLocalInputValue,
  toRFC3339,
  weekdayLabel,
  weekdayOptions,
} from "./scheduleRule";
import type { ScheduleRule } from "../transport/types";

const t = (zh: string, en?: string) => zh || en || "";
const zh = "zh" as const;

describe("defaultRule", () => {
  it("每种规则都给得出可用的默认值", () => {
    for (const kind of RULE_KINDS) {
      const r = defaultRule(kind);
      expect(r.kind).toBe(kind);
      if (kind === "once") expect(r.at).toBeTruthy();
      if (kind === "minutes" || kind === "hours") expect(r.interval).toBeGreaterThan(0);
      if (["daily", "weekdays", "weekly", "monthly"].includes(kind)) expect(r.time).toMatch(/^\d{2}:\d{2}$/);
      if (kind === "weekly") expect(r.weekdays?.length).toBe(1);
      if (kind === "cron") expect(r.cron).toContain("*");
    }
  });

  it("默认带浏览器时区（拿不到时留空，由后端按服务器时区解释）", () => {
    expect(typeof defaultRule("daily").timezone).toBe("string");
  });
});

describe("ruleSummary", () => {
  const cases: [ScheduleRule, string][] = [
    [{ kind: "once", at: "2026-11-19T09:00:00+08:00" }, "仅一次"],
    [{ kind: "minutes", interval: 15 }, "每 15 分钟"],
    [{ kind: "hours", interval: 2 }, "每 2 小时"],
    [{ kind: "daily", time: "09:00" }, "每天 09:00"],
    [{ kind: "weekdays", time: "09:00" }, "周一至周五 09:00"],
    [{ kind: "weekly", time: "09:00", weekdays: [3, 1] }, "每周 周一、周三 09:00"],
    [{ kind: "monthly", day: 15, time: "09:00" }, "每月 15 日 09:00"],
    [{ kind: "cron", cron: "0 9 * * 1-5" }, "自定义 0 9 * * 1-5"],
  ];
  for (const [rule, want] of cases) {
    it(`${rule.kind} → ${want}`, () => {
      expect(ruleSummary(rule, t, zh)).toBe(want);
    });
  }
});

describe("本地时间换算", () => {
  it("datetime-local 与 RFC3339 往返一致", () => {
    const d = new Date(2026, 10, 19, 9, 30, 0, 0);
    const local = toLocalInput(d);
    expect(local).toBe("2026-11-19T09:30");
    const rfc = toRFC3339(local);
    expect(new Date(rfc).getTime()).toBe(d.getTime());
    expect(toLocalInputValue(rfc)).toBe(local);
  });

  it("解析不了的值不抛错，返回空串交给后端报错", () => {
    expect(toRFC3339("")).toBe("");
    expect(toRFC3339("不是时间")).toBe("");
    expect(toLocalInputValue("nope")).toBe("");
    expect(toLocalInputValue(undefined)).toBe("");
  });
});

describe("标签", () => {
  it("星期按周一开头排列", () => {
    expect(weekdayOptions()).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(weekdayLabel(1, "zh")).toBe("周一");
    expect(weekdayLabel(1, "en")).toBe("Mon");
  });

  it("状态与执行位置", () => {
    expect(statusLabel("active", t)).toBe("已开启");
    expect(statusLabel("paused", t)).toBe("已暂停");
    expect(statusLabel("ended", t)).toBe("已结束");
    expect(targetLabel("new-reuse", t)).toBe("新建对话并复用");
    expect(targetLabel("new-each", t)).toBe("每次新建对话");
  });
});
