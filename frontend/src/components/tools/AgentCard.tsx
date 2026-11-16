import { Button } from "../common/Button";
import { Collapsible } from "../common/Collapsible";
import { IconChat, IconSpark, IconStop } from "../common/Icons";
import type { SubagentInfo, ToolItem } from "../../lib/model";
import { formatTokens } from "../../lib/usage";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../store/useAppStore";
import { ToolImages } from "./ToolImages";

const tone: Record<SubagentInfo["status"], string> = {
  running: "bg-brand-soft text-brand",
  completed: "bg-panel-strong text-muted",
  failed: "bg-rose-50 text-danger dark:bg-rose-950/30",
  stopped: "bg-amber-50 text-warn dark:bg-amber-950/30",
};

/**
 * Agent（子代理）卡片。
 *
 * 数据来源有两套，必须都认：
 *   - 实时：system/task_started|task_updated|task_notification 折进 subagent；
 *   - 回放：主转录里没有 task_* 行，只能从 tool_result 的 agentId / <usage> 里补。
 */
export function AgentCard({ item }: { item: ToolItem }) {
  const t = useT();
  const showSubagent = useAppStore((s) => s.showSubagent);
  const stopTask = useAppStore((s) => s.stopTask);

  const input = (item.input ?? {}) as Record<string, unknown>;
  const sub = item.subagent;
  const description = sub?.description || text(input.description);
  const type = sub?.type || text(input.subagent_type);
  const prompt = sub?.prompt || text(input.prompt);
  const label = description || type || t("子代理", "Subagent");
  const status: SubagentInfo["status"] =
    sub?.status ?? (item.result === undefined ? "running" : item.isError ? "failed" : "completed");
  const usage = sub?.usage;

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
    <div className="overflow-hidden rounded-xl border border-line bg-canvas">
      <div className="flex items-center gap-2 border-b border-line bg-panel/60 px-3 py-2 text-[12px]">
        <IconSpark size={14} className="shrink-0 text-brand" />
        <span className="min-w-0 truncate font-medium text-ink">{label}</span>
        {type && <span className="shrink-0 rounded-full bg-panel-strong px-2 py-0.5 text-[10px] text-muted">{type}</span>}
        {sub?.background && (
          <span className="shrink-0 rounded-full bg-panel-strong px-2 py-0.5 text-[10px] text-muted">
            {t("后台", "Background")}
          </span>
        )}
        <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] ${tone[status]}`}>{statusLabel}</span>
      </div>

      {(usage || sub?.summary) && (
        <div className="space-y-1 px-3 py-2">
          {usage && (
            <div className="flex flex-wrap items-center gap-2 text-[10.5px] text-muted">
              <span>{formatTokens(usage.totalTokens)} tokens</span>
              <span>·</span>
              <span>{t(`${usage.toolUses} 次工具`, `${usage.toolUses} tool calls`)}</span>
              <span>·</span>
              <span>{(usage.durationMs / 1000).toFixed(1)}s</span>
            </div>
          )}
          {sub?.summary && <p className="line-clamp-3 text-[11.5px] leading-relaxed text-ink-2">{sub.summary}</p>}
        </div>
      )}

      {(sub?.agentId || (status === "running" && sub?.taskId)) && (
        <div className="flex flex-wrap gap-2 px-3 pb-2">
          {sub?.agentId && (
            <Button size="sm" variant="secondary" icon={<IconChat size={13} />} onClick={() => showSubagent(sub.agentId!, label)}>
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
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink-2">
              {prompt}
            </pre>
          </Collapsible>
        )}
        {item.result !== undefined && item.result !== "" && (
          <Collapsible title={t("结果", "Result")} summary={preview(item.result)}>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink-2">
              {item.result}
            </pre>
          </Collapsible>
        )}
        {item.images && item.images.length > 0 && <ToolImages item={item} />}
      </div>
    </div>
  );
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function preview(s: string): string {
  const first = s.split("\n").find((l) => l.trim()) ?? "";
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}
