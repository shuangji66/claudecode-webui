// 自动化任务的时间规则：界面上的默认值、摘要文案与「本地时间 ↔ RFC3339」换算。
//
// 纯函数（除了取浏览器时区），便于单测；组件只负责控件的排布。
// 与后端 internal/schedule/rule.go 同一套 kind，字段名一一对应。
import type { ScheduleRule, ScheduleTarget, ScheduleTask } from "../transport/types";

export type RuleKind = ScheduleRule["kind"];

/** 引导式规则（自定义 cron 单独一项，避免和它们混在一起）。 */
export const RULE_KINDS: RuleKind[] = ["once", "minutes", "hours", "daily", "weekdays", "weekly", "monthly", "cron"];

type T = (zh: string, en?: string) => string;

/** 浏览器时区（IANA）。拿不到就返回空串，由后端按服务器时区解释。 */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

/** 某种规则在界面上的默认值（新建任务时用）。 */
export function defaultRule(kind: RuleKind = "daily"): ScheduleRule {
  const tz = browserTimeZone();
  switch (kind) {
    case "once":
      return { kind, at: inOneHour(), timezone: tz };
    case "minutes":
      return { kind, interval: 30, timezone: tz };
    case "hours":
      return { kind, interval: 2, timezone: tz };
    case "daily":
      return { kind, time: "09:00", timezone: tz };
    case "weekdays":
      return { kind, time: "09:00", timezone: tz };
    case "weekly":
      return { kind, time: "09:00", weekdays: [1], timezone: tz };
    case "monthly":
      return { kind, day: 1, time: "09:00", timezone: tz };
    case "cron":
      return { kind, cron: "0 9 * * 1-5", timezone: tz };
  }
  return { kind, time: "09:00", timezone: tz };
}

/** 一小时后（本地时间）的 RFC3339，作为「仅一次」的默认值。 */
function inOneHour(): string {
  const d = new Date(Date.now() + 3600_000);
  d.setSeconds(0, 0);
  return toRFC3339(toLocalInput(d));
}

/** Date → `YYYY-MM-DDTHH:MM`（datetime-local 的 value）。 */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** RFC3339 → `YYYY-MM-DDTHH:MM`，用于回填输入框；解析失败返回空串。 */
export function toLocalInputValue(rfc: string | undefined): string {
  if (!rfc) return "";
  const d = new Date(rfc);
  if (Number.isNaN(d.getTime())) return "";
  return toLocalInput(d);
}

/** `YYYY-MM-DDTHH:MM` → RFC3339（浏览器本地时区）；解析失败返回空串（由后端报错）。 */
export function toRFC3339(local: string): string {
  if (!local) return "";
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // 周一开头，周日放最后（中文习惯）

/** 星期几的单字标签。 */
export function weekdayLabel(day: number, locale: "zh" | "en"): string {
  const zh = ["日", "一", "二", "三", "四", "五", "六"];
  const en = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return locale === "zh" ? `周${zh[day] ?? "?"}` : (en[day] ?? "?");
}

/** 供多选控件遍历的星期顺序。 */
export function weekdayOptions(): number[] {
  return WEEKDAY_ORDER;
}

/** 规则的一句话摘要（列表行、详情页都用它）。 */
export function ruleSummary(rule: ScheduleRule, t: T, locale: "zh" | "en"): string {
  switch (rule.kind) {
    case "once":
      return t("仅一次", "Once");
    case "minutes":
      return t(`每 ${rule.interval ?? 1} 分钟`, `Every ${rule.interval ?? 1} min`);
    case "hours":
      return t(`每 ${rule.interval ?? 1} 小时`, `Every ${rule.interval ?? 1} h`);
    case "daily":
      return t(`每天 ${rule.time ?? ""}`, `Daily at ${rule.time ?? ""}`);
    case "weekdays":
      return t(`周一至周五 ${rule.time ?? ""}`, `Weekdays at ${rule.time ?? ""}`);
    case "weekly": {
      const days = (rule.weekdays ?? []).slice().sort((a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b));
      // 一天都没选：后端会以「每周任务要选至少一天」拒绝保存，摘要这里给一句人话，
      // 不要拼出「每周  09:00」这种两个空格的残句。
      if (days.length === 0) return t(`每周（未选星期）${rule.time ?? ""}`, `Weekly (no day picked) ${rule.time ?? ""}`);
      const label = days.map((d) => weekdayLabel(d, locale)).join(locale === "zh" ? "、" : ", ");
      return t(`每周 ${label} ${rule.time ?? ""}`, `Weekly on ${label} at ${rule.time ?? ""}`);
    }
    case "monthly":
      return t(`每月 ${rule.day ?? 1} 日 ${rule.time ?? ""}`, `Monthly on day ${rule.day ?? 1} at ${rule.time ?? ""}`);
    case "cron":
      return t(`自定义 ${rule.cron ?? ""}`, `Cron ${rule.cron ?? ""}`);
  }
}

/** 任务状态的中文/英文文案。 */
export function statusLabel(status: ScheduleTask["status"], t: T): string {
  switch (status) {
    case "active":
      return t("已开启", "Active");
    case "paused":
      return t("已暂停", "Paused");
    case "ended":
      return t("已结束", "Ended");
  }
}

/** 投递目标的文案。 */
export function targetLabel(kind: ScheduleTarget["kind"], t: T): string {
  switch (kind) {
    case "conversation":
      return t("指定对话", "Existing chat");
    case "new-reuse":
      return t("新建对话并复用", "New chat, reused");
    case "new-each":
      return t("每次新建对话", "New chat each run");
  }
}
