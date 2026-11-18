// 计划模式最后提交的那份计划（ExitPlanMode）。
//
// 入参就是 `{plan: "<整份 Markdown>"}`（CLI 的 schema：`plan` 必填，另有已废弃的
// `allowedPrompts`），所以直接按 Markdown 渲染——兜底卡片会把它摊成一块带 `\n` 的 JSON，
// 几百行的计划根本没法读。批准/驳回本身走审批面板（ExitPlanMode 会触发 can_use_tool），
// 这里只说明结果：没回结果＝还在等用户，is_error＝没通过。
import type { ToolItem } from "../../lib/model";
import { useT } from "../../lib/i18n";
import { Markdown } from "../common/Markdown";
import { IconFileText } from "../common/Icons";
import { ToolShell, type ToolStatus } from "./ToolShell";

interface Props {
  item: ToolItem;
}

function planText(item: ToolItem): string {
  const input = (item.input ?? {}) as Record<string, unknown>;
  return typeof input.plan === "string" ? input.plan.trim() : "";
}

function firstLine(s: string): string {
  const line = s.split("\n").find((l) => l.trim() && !l.trim().startsWith("#")) ?? "";
  return line.trim().slice(0, 80);
}

/** 计划的状态：等待批准 / 已通过 / 未通过（只有 CLI 回了 tool_result 才知道结果）。 */
export function planStatus(item: ToolItem, t: (zh: string, en?: string) => string): ToolStatus {
  if (item.result === undefined) {
    return {
      label: t("等待批准", "Awaiting approval"),
      className: "bg-amber-50 text-warn dark:bg-amber-950/30",
      tone: "warn",
    };
  }
  if (item.isError) {
    return {
      label: t("未通过", "Not approved"),
      className: "bg-rose-50 text-danger dark:bg-rose-950/30",
      tone: "fail",
    };
  }
  return {
    label: t("已通过", "Approved"),
    className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300",
    tone: "ok",
  };
}

/** 计划正文：整份 Markdown，限高滚动（计划常常几十上百行）。 */
export function PlanBody({ item }: Props) {
  const t = useT();
  const plan = planText(item);

  if (!plan) {
    return (
      <p className="px-3 py-2.5 text-[11.5px] text-muted">
        {t("这次没有提交计划正文。", "No plan text was submitted.")}
      </p>
    );
  }

  return (
    <div className="px-3 py-2.5">
      <div className="dsh-scroll max-h-[420px] overflow-y-auto pr-1">
        <Markdown text={plan} />
      </div>
      {/* 驳回时 CLI 把用户的话放在 tool_result 里：那是「为什么不通过」，必须显示。 */}
      {item.result !== undefined && item.isError && item.result.trim() !== "" && (
        <p className="mt-2 border-t border-line pt-2 text-[11.5px] leading-relaxed text-danger">{item.result}</p>
      )}
    </div>
  );
}

export function PlanCard({ item }: Props) {
  const t = useT();
  return (
    <ToolShell
      item={item}
      icon={<IconFileText size={14} />}
      title={t("计划", "Plan")}
      subtitle={firstLine(planText(item))}
      status={planStatus(item, t)}
    >
      <PlanBody item={item} />
    </ToolShell>
  );
}
