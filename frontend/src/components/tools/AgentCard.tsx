import { Button } from "../common/Button";
import { Collapsible } from "../common/Collapsible";
import { IconChat, IconSpark, IconStop } from "../common/Icons";
import type { SubagentInfo, ToolItem } from "../../lib/model";
import { formatTokens } from "../../lib/usage";
import { formatDuration } from "../../lib/elapsed";
import { endedElapsed, subagentProgressLine, subagentStatusOf, subagentTokensUsed } from "../../lib/subagents";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../store/useAppStore";
import { ToolImages } from "./ToolImages";
import { ToolShell, type ToolStatus } from "./ToolShell";

const tone: Record<SubagentInfo["status"], { className: string; tone: ToolStatus["tone"] }> = {
  running: { className: "bg-brand-soft text-brand", tone: "run" },
  completed: { className: "bg-panel-strong text-muted", tone: "ok" },
  failed: { className: "bg-rose-50 text-danger dark:bg-rose-950/30", tone: "fail" },
  stopped: { className: "bg-amber-50 text-warn dark:bg-amber-950/30", tone: "warn" },
};

/**
 * Agent（子代理）正文：用量、摘要、查看/停止、任务说明与结果。
 *
 * 数据来源有两套，必须都认：
 *   - 实时：system/task_started|task_updated|task_notification 折进 subagent；
 *   - 回放：主转录里没有 task_* 行，只能从 tool_result 的 agentId / <usage> 里补。
 */
export function AgentBody({ item }: { item: ToolItem }) {
  const t = useT();
  const showSubagent = useAppStore((s) => s.showSubagent);
  const stopTask = useAppStore((s) => s.stopTask);

  const input = (item.input ?? {}) as Record<string, unknown>;
  const sub = item.subagent;
  const prompt = sub?.prompt || text(input.prompt);
  // 状态只认 `subagent.status`，不看 `item.result`（后台子代理的 result 只是启动回执，
  // 见 `lib/subagents.subagentStatusOf`）。
  const status = subagentStatusOf(sub);
  const usage = sub?.usage;
  // 报**累计消耗**，不是 CLI 的 `totalTokens`（那是最后一次请求的窗口大小，见
  // `subagentTokensUsed`）。拿不到累计时才退回单次值。
  const consumed = subagentTokensUsed(usage);
  // 「此刻在做什么」：模型摘要优先，其次 CLI 的活动描述（见 `subagentProgressLine`）。
  const progress = subagentProgressLine(sub);
  // 重启后 CLI 的结束通知已经不在（只在 stdout 上），耗时只剩「转录里的收尾时刻 -
  // 启动时刻」。卡片和页头那个子代理列表用同一个口径（`endedElapsed`）。
  const elapsed = endedElapsed(usage, item.ts, sub?.endedAt);

  return (
    <>
      {((consumed !== undefined && consumed > 0) || progress) && (
        <div className="space-y-1 px-3 py-2">
          {consumed !== undefined && consumed > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-[10.5px] text-muted">
              <span>{t(`${formatTokens(consumed)} tokens 消耗`, `${formatTokens(consumed)} tokens used`)}</span>
              {/* 工具次数只有 CLI 的进度/结束通知才给：重启后从子代理转录恢复的那份用量
                  只有 token 数，这里不能拿 0 补齐（「0 次工具」是假数据）。耗时能用
                  `endedAt - ts` 复原，见上面的 `elapsed`。 */}
              {usage?.toolUses !== undefined && (
                <>
                  <span>·</span>
                  <span>{t(`${usage.toolUses} 次工具`, `${usage.toolUses} tool calls`)}</span>
                </>
              )}
              {elapsed !== undefined && (
                <>
                  <span>·</span>
                  <span>{formatDuration(elapsed)}</span>
                </>
              )}
            </div>
          )}
          {/* 跑完之后不再显示这一行：那时它是最后一次工具调用，不是「在做什么」。 */}
          {progress && status === "running" && (
            <p className="line-clamp-3 text-[11.5px] leading-relaxed text-ink-2">{progress}</p>
          )}
        </div>
      )}

      {(sub?.agentId || (status === "running" && sub?.taskId)) && (
        <div className="flex flex-wrap gap-2 px-3 pb-2">
          {sub?.agentId && (
            <Button size="sm" variant="secondary" icon={<IconChat size={13} />} onClick={() => showSubagent(sub.agentId!, agentLabel(item, t))}>
              {t("查看对话", "Open chat")}
            </Button>
          )}
          {status === "running" && sub?.taskId && (
            <Button size="sm" variant="ghost" icon={<IconStop size={13} />} onClick={() => void stopTask(sub.taskId)}>
              {t("停止", "Stop")}
            </Button>
          )}
        </div>
      )}

      <div className="space-y-2 px-3 pb-2.5">
        {prompt && (
          <Collapsible title={t("任务说明", "Task prompt")} summary={preview(prompt)}>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11.5px] leading-relaxed text-ink-2">
              {prompt}
            </pre>
          </Collapsible>
        )}
        {item.result !== undefined && item.result !== "" && (
          <Collapsible title={t("结果", "Result")} summary={preview(item.result)}>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11.5px] leading-relaxed text-ink-2">
              {item.result}
            </pre>
          </Collapsible>
        )}
        {item.images && item.images.length > 0 && <ToolImages item={item} />}
      </div>
    </>
  );
}

export function AgentCard({ item }: { item: ToolItem }) {
  const t = useT();
  const sub = item.subagent;
  const input = (item.input ?? {}) as Record<string, unknown>;
  const type = sub?.type || text(input.subagent_type);
  // 同 Body：状态只认 `subagent.status`（详见 `lib/subagents.subagentStatusOf`）。
  const status = subagentStatusOf(sub);

  const statusLabel =
    status === "running"
      ? typeof item.progress === "number"
        ? t(`运行中 ${item.progress}s`, `Running ${item.progress}s`)
        : t("运行中…", "Running…")
      : status === "completed"
        ? t("完成", "Done")
        : status === "failed"
          ? t("失败", "Failed")
          : t("已停止", "Stopped");

  return (
    <ToolShell
      item={item}
      icon={<IconSpark size={14} className="text-brand" />}
      title={agentLabel(item, t)}
      subtitle={[type, sub?.background ? t("后台", "Background") : ""].filter(Boolean).join(" · ")}
      status={{ label: statusLabel, className: tone[status].className, tone: tone[status].tone }}
    >
      <AgentBody item={item} />
    </ToolShell>
  );
}

/** 子代理的显示名：任务描述 > 类型 > 「子代理」。详细卡片与紧凑工具行共用。 */
export function agentLabel(item: ToolItem, t: (zh: string, en?: string) => string): string {
  const sub = item.subagent;
  const input = (item.input ?? {}) as Record<string, unknown>;
  return sub?.description || text(input.description) || sub?.type || text(input.subagent_type) || t("子代理", "Subagent");
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function preview(s: string): string {
  const first = s.split("\n").find((l) => l.trim()) ?? "";
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}
