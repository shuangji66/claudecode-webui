// 「自动化任务」面板：列表 + 编辑 + 运行记录。
//
// 参考 DSH 的自动化任务页，但按本项目的约定收敛：一个模态两态（列表 / 编辑），
// 数据在 useScheduleStore，规则文案在 lib/scheduleRule，组件只管排布与本地草稿。
// 时间规则走引导式控件 + 自定义 cron；时区固定用浏览器时区（后端按 IANA 解释）。
import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import { useScheduleStore } from "../../store/useScheduleStore";
import { useLocale, useT } from "../../lib/i18n";
import {
  RULE_KINDS,
  defaultRule,
  ruleSummary,
  statusLabel,
  targetLabel,
  toLocalInputValue,
  toRFC3339,
  weekdayLabel,
  weekdayOptions,
  type RuleKind,
} from "../../lib/scheduleRule";
import type { ScheduleDelivery, ScheduleRule, ScheduleTask, ScheduleTarget } from "../../transport/types";
import { Dialog } from "../common/Dialog";
import { Button } from "../common/Button";
import { Select } from "../common/Select";
import { askConfirm } from "../common/SystemDialogs";
import { IconClock, IconPlus, IconChevronLeft, IconTrash } from "../common/Icons";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Draft {
  id?: string;
  name: string;
  prompt: string;
  workspace: string;
  targetKind: ScheduleTarget["kind"];
  conversationId: string;
  rule: ScheduleRule;
  /** 编辑时后端那一版的时间戳（乐观并发）。 */
  expected?: string;
}

function draftOf(task: ScheduleTask): Draft {
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    workspace: task.workspace,
    targetKind: task.target.kind,
    conversationId: task.target.conversation_id ?? "",
    rule: task.rule,
    expected: task.updated_at,
  };
}

function emptyDraft(workspace: string): Draft {
  return {
    name: "",
    prompt: "",
    workspace,
    targetKind: "new-reuse",
    conversationId: "",
    rule: defaultRule("daily"),
  };
}

export function ScheduleDialog({ open, onClose }: Props) {
  const t = useT();
  const locale = useLocale();
  const workspaces = useAppStore((s) => s.workspaces);
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const openConversation = useAppStore((s) => s.openConversation);

  const tasks = useScheduleStore((s) => s.tasks);
  const error = useScheduleStore((s) => s.error);
  const saving = useScheduleStore((s) => s.saving);
  const load = useScheduleStore((s) => s.load);
  const save = useScheduleStore((s) => s.save);
  const action = useScheduleStore((s) => s.action);
  const remove = useScheduleStore((s) => s.remove);
  const setError = useScheduleStore((s) => s.setError);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [deliveries, setDeliveries] = useState<ScheduleDelivery[]>([]);
  const fetchDeliveries = useScheduleStore((s) => s.deliveries);

  useEffect(() => {
    if (!open) return;
    setDraft(null);
    setDeliveries([]);
    setError(null);
    void load();
  }, [open, load, setError]);

  // 打开一条已有任务时把它的投递记录也取回来（分页在接口里，这里只取最近一批）。
  useEffect(() => {
    if (!draft?.id) {
      setDeliveries([]);
      return;
    }
    let alive = true;
    void fetchDeliveries(draft.id).then((list) => {
      if (alive) setDeliveries(list);
    });
    return () => {
      alive = false;
    };
  }, [draft?.id, fetchDeliveries]);

  const workspaceOptions = useMemo(() => {
    const list = Array.isArray(workspaces) ? workspaces : [];
    if (list.length === 0) return [{ value: currentWorkspace, label: currentWorkspace }];
    return list.map((w) => ({ value: w.path, label: w.name || w.path }));
  }, [workspaces, currentWorkspace]);

  if (!open) return null;

  const startNew = () => {
    const ws = workspaceOptions[0]?.value ?? currentWorkspace;
    setDraft(emptyDraft(ws));
    setError(null);
  };

  const submit = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.prompt.trim()) {
      setError(t("任务名称和内容都不能为空。", "Name and instruction are required."));
      return;
    }
    const saved = await save({
      id: draft.id,
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      workspace: draft.workspace,
      target: { kind: draft.targetKind, conversation_id: draft.conversationId || undefined },
      rule: draft.rule,
      expected_updated_at: draft.expected,
    });
    if (saved) setDraft(draftOf(saved));
  };

  const runNow = async () => {
    if (!draft?.id) return;
    await action(draft.id, "run");
  };

  const togglePause = async () => {
    if (!draft?.id) return;
    const cur = tasks.find((x) => x.id === draft.id);
    if (!cur) return;
    const ok = await action(draft.id, cur.status === "active" ? "pause" : "resume");
    if (ok) {
      const next = useScheduleStore.getState().tasks.find((x) => x.id === draft.id);
      if (next) setDraft(draftOf(next));
    }
  };

  const removeTask = async () => {
    if (!draft?.id) return;
    const ok = await askConfirm({
      title: t("删除自动化任务", "Delete automation"),
      message: t("删除后不再投递，运行记录也一并移除；已经投进对话的消息不受影响。", "It stops running and its delivery records are removed; messages already sent stay in their chats."),
      danger: true,
      confirmText: t("删除", "Delete"),
    });
    if (!ok) return;
    if (await remove(draft.id)) setDraft(null);
  };

  const title = draft
    ? draft.id
      ? t("编辑自动化任务", "Edit automation")
      : t("新建自动化任务", "New automation")
    : t("自动化任务", "Automations");

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label={t("自动化任务", "Automations")}
      title={title}
      icon={<IconClock size={16} />}
      // 与设置弹窗同一套几何：移动端整屏、桌面 900×82vh 居中。
      // 高度固定后列表才有稳定的滚动区域，不会随条数忽高忽低。
      size="xl"
      fullScreen
      panelClassName="h-[100dvh] max-h-[100dvh] rounded-none md:h-[82vh] md:max-h-[84vh] md:rounded-2xl md:max-w-[900px]"
      // 内容自己带内边距：Dialog 的 body 默认没有 padding，列表卡片/输入框的边框
      // 会正好压在弹窗边框上（滚动区贴到页脚线，看起来像被页脚盖住）。
      bodyClassName="px-4 pb-4 pt-4 md:px-8 md:pb-6 md:pt-5"
      footer={
        draft ? (
          <button type="button" onClick={() => setDraft(null)} className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] text-muted hover:bg-canvas hover:text-ink">
            <IconChevronLeft size={13} />
            {t("返回列表", "Back")}
          </button>
        ) : (
          <Button onClick={startNew} className="flex items-center gap-1.5">
            <IconPlus size={14} />
            {t("新建", "New")}
          </Button>
        )
      }
    >
      {error && (
        <p className="mb-2 rounded-lg bg-rose-50 px-3 py-2 text-[11.5px] text-danger dark:bg-rose-950/30">{error}</p>
      )}

      {draft ? (
        <Editor
          draft={draft}
          onChange={setDraft}
          workspaceOptions={workspaceOptions}
          deliveries={deliveries}
          saving={saving}
          onSave={submit}
          onRunNow={runNow}
          onTogglePause={togglePause}
          onDelete={removeTask}
          status={tasks.find((x) => x.id === draft.id)?.status}
          onOpenConversation={(id) => void openConversation(id)}
        />
      ) : (
        <TaskList
          tasks={tasks}
          emptyText={t("还没有自动化任务。点右上角「新建」，或直接让 Claude 帮你建一条。", "No automations yet. Create one, or ask Claude to do it.")}
          onPick={(task) => {
            setDraft(draftOf(task));
            setError(null);
          }}
          nextRunText={(task) => nextRunText(task, locale, t)}
        />
      )}
    </Dialog>
  );
}

function nextRunText(task: ScheduleTask, locale: "zh" | "en", t: (zh: string, en?: string) => string): string {
  if (task.status === "ended") return statusLabel("ended", t);
  if (task.status === "paused") return statusLabel("paused", t);
  if (!task.next_run) return "";
  const d = new Date(task.next_run);
  if (Number.isNaN(d.getTime())) return "";
  return t(`下次 ${d.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { hour12: false })}`, `Next ${d.toLocaleString("en-US", { hour12: false })}`);
}

interface ListProps {
  tasks: ScheduleTask[];
  emptyText: string;
  onPick: (task: ScheduleTask) => void;
  nextRunText: (task: ScheduleTask) => string;
}

function TaskList({ tasks, emptyText, onPick, nextRunText }: ListProps) {
  const t = useT();
  const locale = useLocale() === "en" ? "en" : "zh";
  if (tasks.length === 0) {
    return <p className="px-1 py-8 text-center text-[12px] text-muted">{emptyText}</p>;
  }
  return (
    <ul className="space-y-1.5">
      {tasks.map((task) => (
        <li key={task.id}>
          <button
            type="button"
            onClick={() => onPick(task)}
            className="flex w-full flex-col gap-1 rounded-xl border border-line bg-canvas px-3 py-2.5 text-left hover:border-line-strong hover:bg-panel-strong/60"
          >
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{task.name}</span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${statusClass(task.status)}`}>
                {statusLabel(task.status, t)}
              </span>
            </span>
            <span className="flex items-center gap-2 text-[11px] text-muted">
              <span className="shrink-0">{ruleSummary(task.rule, t, locale)}</span>
              <span className="min-w-0 truncate text-faint">{nextRunText(task)}</span>
              <span className="ml-auto shrink-0 text-faint">{targetLabel(task.target.kind, t)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function statusClass(status: ScheduleTask["status"]): string {
  switch (status) {
    case "active":
      return "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300";
    case "paused":
      return "bg-amber-50 text-warn dark:bg-amber-950/30";
    case "ended":
      return "bg-panel-strong text-muted";
  }
}

interface EditorProps {
  draft: Draft;
  onChange: (d: Draft) => void;
  workspaceOptions: { value: string; label: string }[];
  deliveries: ScheduleDelivery[];
  saving: boolean;
  status?: ScheduleTask["status"];
  onSave: () => void;
  onRunNow: () => void;
  onTogglePause: () => void;
  onDelete: () => void;
  onOpenConversation: (id: string) => void;
}

function Editor({
  draft,
  onChange,
  workspaceOptions,
  deliveries,
  saving,
  status,
  onSave,
  onRunNow,
  onTogglePause,
  onDelete,
  onOpenConversation,
}: EditorProps) {
  const t = useT();
  const locale = useLocale() === "en" ? "en" : "zh";
  const patch = (p: Partial<Draft>) => onChange({ ...draft, ...p });
  const patchRule = (p: Partial<ScheduleRule>) => onChange({ ...draft, rule: { ...draft.rule, ...p } });

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-[11px] text-muted">{t("任务名称", "Name")}</span>
        <input
          value={draft.name}
          onChange={(e) => patch({ name: e.target.value })}
          className="w-full rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[13px] text-ink outline-none"
          placeholder={t("例如：每日巡检", "e.g. Daily check")}
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-[11px] text-muted">{t("任务内容", "Instruction")}</span>
        <textarea
          value={draft.prompt}
          onChange={(e) => patch({ prompt: e.target.value })}
          rows={3}
          className="w-full resize-y rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[12.5px] leading-relaxed text-ink outline-none"
          placeholder={t("到点后发给 Claude 的那句话", "What Claude should do when it fires")}
        />
      </label>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[11px] text-muted">{t("执行位置", "Runs in")}</span>
          <Select
            value={draft.targetKind}
            onChange={(v) => patch({ targetKind: v as ScheduleTarget["kind"] })}
            ariaLabel={t("执行位置", "Runs in")}
            options={[
              { value: "new-reuse", label: targetLabel("new-reuse", t) },
              { value: "new-each", label: targetLabel("new-each", t) },
            ]}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-muted">{t("关联工作区", "Workspace")}</span>
          <Select
            value={draft.workspace}
            onChange={(v) => patch({ workspace: v })}
            ariaLabel={t("关联工作区", "Workspace")}
            options={workspaceOptions}
          />
        </label>
      </div>

      <div>
        <span className="mb-1 block text-[11px] text-muted">{t("运行时间", "Schedule")}</span>
        <div className="space-y-2 rounded-xl border border-line bg-panel/50 p-2.5">
          <Select
            value={draft.rule.kind}
            onChange={(v) => patch({ rule: defaultRule(v as RuleKind) })}
            ariaLabel={t("运行时间", "Schedule")}
            options={RULE_KINDS.map((k) => ({ value: k, label: ruleKindLabel(k, t) }))}
          />
          {draft.rule.kind === "once" && (
            <input
              type="datetime-local"
              value={toLocalInputValue(draft.rule.at)}
              onChange={(e) => patchRule({ at: toRFC3339(e.target.value) })}
              className="w-full rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[12.5px] text-ink outline-none"
            />
          )}
          {(draft.rule.kind === "minutes" || draft.rule.kind === "hours") && (
            <label className="flex items-center gap-2 text-[12px] text-ink-2">
              {t("间隔", "Every")}
              <input
                type="number"
                min={1}
                value={draft.rule.interval ?? 1}
                onChange={(e) => patchRule({ interval: Math.max(1, Number(e.target.value) || 1) })}
                className="w-20 rounded-lg border border-line bg-canvas px-2 py-1 text-[12px] text-ink outline-none"
              />
              {draft.rule.kind === "minutes" ? t("分钟", "minutes") : t("小时", "hours")}
            </label>
          )}
          {draft.rule.kind === "weekly" && (
            <div className="flex flex-wrap gap-1">
              {weekdayOptions().map((d) => {
                const on = (draft.rule.weekdays ?? []).includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => {
                      const cur = new Set(draft.rule.weekdays ?? []);
                      if (cur.has(d)) cur.delete(d);
                      else cur.add(d);
                      patchRule({ weekdays: [...cur].sort() });
                    }}
                    className={`rounded-full border px-2.5 py-1 text-[11px] ${
                      on ? "border-brand bg-brand-soft text-brand" : "border-line text-muted hover:text-ink"
                    }`}
                  >
                    {weekdayLabel(d, locale)}
                  </button>
                );
              })}
            </div>
          )}
          {draft.rule.kind === "monthly" && (
            <label className="flex items-center gap-2 text-[12px] text-ink-2">
              {t("每月", "Day")}
              <input
                type="number"
                min={1}
                max={31}
                value={draft.rule.day ?? 1}
                onChange={(e) => patchRule({ day: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })}
                className="w-20 rounded-lg border border-line bg-canvas px-2 py-1 text-[12px] text-ink outline-none"
              />
              {t("日", "of month")}
            </label>
          )}
          {draft.rule.kind === "cron" && (
            <input
              value={draft.rule.cron ?? ""}
              onChange={(e) => patchRule({ cron: e.target.value })}
              placeholder="0 9 * * 1-5"
              className="w-full rounded-lg border border-line bg-canvas px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none"
            />
          )}
          {["daily", "weekdays", "weekly", "monthly"].includes(draft.rule.kind) && (
            <label className="flex items-center gap-2 text-[12px] text-ink-2">
              {t("时间", "Time")}
              <input
                type="time"
                value={draft.rule.time ?? "09:00"}
                onChange={(e) => patchRule({ time: e.target.value })}
                className="rounded-lg border border-line bg-canvas px-2 py-1 text-[12px] text-ink outline-none"
              />
              <span className="text-[10.5px] text-faint">{draft.rule.timezone || t("服务器时区", "Server timezone")}</span>
            </label>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button onClick={onSave} disabled={saving}>
          {saving ? t("保存中…", "Saving…") : draft.id ? t("保存修改", "Save changes") : t("创建", "Create")}
        </Button>
        {draft.id && (
          <>
            <Button variant="ghost" onClick={onRunNow}>
              {t("立即执行", "Run now")}
            </Button>
            <Button variant="ghost" onClick={onTogglePause}>
              {status === "active" ? t("暂停", "Pause") : t("恢复", "Resume")}
            </Button>
            <button
              type="button"
              onClick={onDelete}
              className="ml-auto flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] text-danger hover:bg-rose-50 dark:hover:bg-rose-950/30"
            >
              <IconTrash size={13} />
              {t("删除", "Delete")}
            </button>
          </>
        )}
      </div>

      {draft.id && (
        <div>
          <p className="mb-1 text-[11px] text-muted">{t("运行记录", "Recent runs")}</p>
          {deliveries.length === 0 ? (
            <p className="text-[11px] text-faint">{t("还没有投递记录。", "No runs yet.")}</p>
          ) : (
            <ul className="max-h-40 space-y-1 overflow-y-auto dsh-scroll">
              {deliveries.map((d, i) => (
                <li key={`${d.at}-${i}`} className="flex items-start gap-2 rounded-lg bg-panel/60 px-2 py-1.5 text-[11px]">
                  <span className="shrink-0 text-faint">{new Date(d.at).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { hour12: false })}</span>
                  {d.error ? (
                    <span className="min-w-0 flex-1 text-danger">{d.error}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => d.conversation_id && onOpenConversation(d.conversation_id)}
                      className="min-w-0 flex-1 truncate text-left text-muted hover:text-ink"
                      title={t("打开这次投递的对话", "Open the chat this ran in")}
                    >
                      {d.conversation_id || t("已投递", "Delivered")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {draft.id && deliveries.some((d) => d.error) && (
        <p className="text-[10.5px] leading-relaxed text-faint">
          {t("投递记录只确认消息进了对话，不代表 Claude 已经做完。", "Delivery records only confirm the message reached a chat, not that Claude finished the work.")}
        </p>
      )}
    </div>
  );
}

function ruleKindLabel(kind: RuleKind, t: (zh: string, en?: string) => string): string {
  switch (kind) {
    case "once":
      return t("仅一次", "Once");
    case "minutes":
      return t("每隔几分钟", "Every N minutes");
    case "hours":
      return t("每隔几小时", "Every N hours");
    case "daily":
      return t("每天", "Daily");
    case "weekdays":
      return t("周一至周五", "Weekdays");
    case "weekly":
      return t("每周", "Weekly");
    case "monthly":
      return t("每月", "Monthly");
    case "cron":
      return t("自定义规则（cron）", "Custom (cron)");
  }
}
