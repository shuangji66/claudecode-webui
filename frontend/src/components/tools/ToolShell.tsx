import { useState, type ReactNode } from "react";
import { IconChevronRight } from "../common/Icons";
import type { ToolItem } from "../../lib/model";
import { useT } from "../../lib/i18n";

export interface ToolStatus {
  label: string;
  /** 详细模式（胶囊）的 class。 */
  className: string;
  tone: "run" | "ok" | "fail" | "warn";
}

/** 运行中 / 失败 / 完成：三张卡片与兜底卡片共用同一套措辞。 */
export function toolStatus(item: ToolItem, t: (zh: string, en?: string) => string): ToolStatus {
  /**
   * 子代理不看 `item.result`。
   *
   * 后台子代理（`run_in_background`）的 `tool_result` **只是一条启动回执**
   * （`Async agent launched successfully.` + `agentId:`，没有 `<usage>`），所以
   * `result !== undefined` 在这里只说明「它已经起来了」，完全不代表跑完了。按
   * `result` 判就会在卡片刚出现的那一刻写上「完成」，而它其实正在跑（截图复现过）。
   *
   * 子代理的结论有且只有两条来源：实时的 `system/task_*` 折进 `subagent.status`，
   * 回放靠 `<task-notification>` 与 `settleSubagents`（见 `lib/normalize`）。
   * 所以这里只认 `subagent.status`，没有就往「运行中」算——「还不知道」不能写成
   * 「完成了」（这与 `lib/subagents.settleSubagents` 只把 running 收成 stopped 是
   * 同一条口径：拿不到结论时宁可留着进行中，也不给一个骗人的绿点）。
   */
  if (item.subagent) {
    const status = item.subagent.status;
    if (status === "running") {
      return {
        label:
          typeof item.progress === "number"
            ? t(`运行中 ${item.progress}s`, `Running ${item.progress}s`)
            : t("运行中…", "Running…"),
        className: "bg-brand-soft text-brand",
        tone: "run",
      };
    }
    if (status === "failed") {
      return { label: t("失败", "Failed"), className: "bg-rose-50 text-danger dark:bg-rose-950/30", tone: "fail" };
    }
    if (status === "stopped") {
      return { label: t("已停止", "Stopped"), className: "bg-amber-50 text-warn dark:bg-amber-950/30", tone: "warn" };
    }
    return { label: t("完成", "Done"), className: "bg-panel-strong text-muted", tone: "ok" };
  }
  if (item.result === undefined) {
    return {
      label:
        typeof item.progress === "number"
          ? t(`运行中 ${item.progress}s`, `Running ${item.progress}s`)
          : t("运行中…", "Running…"),
      className: "bg-brand-soft text-brand",
      tone: "run",
    };
  }
  if (item.isError) {
    return { label: t("失败", "Failed"), className: "bg-rose-50 text-danger dark:bg-rose-950/30", tone: "fail" };
  }
  return { label: t("完成", "Done"), className: "bg-panel-strong text-muted", tone: "ok" };
}


const denseTone: Record<ToolStatus["tone"], string> = {
  run: "text-brand",
  fail: "text-danger",
  warn: "text-warn",
  ok: "text-faint",
};

interface Props {
  item: ToolItem;
  icon: ReactNode;
  title: string;
  /** 标题旁的常显补充：详细模式是描述/diff 摘要，紧凑模式是这一行的一行摘要。 */
  subtitle?: string;
  /** 覆盖默认状态（子代理有自己的 stopped）。 */
  status?: ToolStatus;
  /** 紧凑模式：整张卡片压成一行，点开才看正文。 */
  dense?: boolean;
  children: ReactNode;
}

/**
 * 工具卡片外壳：详细模式与紧凑模式共用。
 *
 * 卡片的具体内容（命令 / diff / 结果）由各自的 Body 提供，外壳只管标题行与状态；
 * 这样紧凑行展开时不会出现「行里一个标题、卡片里又一个标题」。
 */
export function ToolShell({ item, icon, title, subtitle, status, dense = false, children }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const badge = status ?? toolStatus(item, t);

  if (dense) {
    return (
      <div className={`overflow-hidden rounded-lg ${item.isError ? "bg-rose-50/50 dark:bg-rose-950/20" : ""}`}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left hover:bg-panel-strong/60"
        >
          <IconChevronRight
            size={12}
            className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`}
          />
          <span className={`shrink-0 ${item.isError ? "text-danger" : "text-muted"}`}>{icon}</span>
          <span
            className={`max-w-[45%] shrink-0 truncate text-[11.5px] font-medium ${
              item.isError ? "text-danger" : "text-ink-2"
            }`}
          >
            {title}
          </span>
          {subtitle && (
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">{subtitle}</span>
          )}
          {item.progressNote && item.result === undefined && (
            <span className="shrink-0 text-[10.5px] text-warn">{item.progressNote}</span>
          )}
          <span className={`ml-auto shrink-0 text-[10.5px] ${denseTone[badge.tone]}`}>{badge.label}</span>
        </button>
        {open && <div className="border-t border-line/70 pt-1.5 pb-1">{children}</div>}
      </div>
    );
  }

  return (
    <div
      className={`overflow-hidden rounded-xl border bg-canvas ${
        item.isError ? "border-rose-300 dark:border-rose-900" : "border-line"
      }`}
    >
      <div className="flex items-center gap-2 border-b border-line bg-panel/60 px-3 py-2 text-[12px]">
        <span className="shrink-0 text-muted">{icon}</span>
        <span className="min-w-0 shrink-0 max-w-[50%] truncate font-medium text-ink">{title}</span>
        {subtitle && <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">{subtitle}</span>}
        {item.progressNote && item.result === undefined && (
          <span className="min-w-0 shrink-0 truncate text-[10.5px] text-warn">{item.progressNote}</span>
        )}
        <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] ${badge.className}`}>
          {badge.label}
        </span>
      </div>
      {children}
    </div>
  );
}
