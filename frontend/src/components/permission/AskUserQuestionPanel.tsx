// 模型的提问卡片（claude 的 `AskUserQuestion`，走 can_use_tool 到达这里）。
//
// 与审批面板的区别（别混用）：
//   - 官方工具表里 AskUserQuestion 的 Permission required 是 **No**：它不是审批，
//     而是模型在任务中途问人。所以标题不写「需要授权」，也不给「始终允许 / 切到某模式」
//     ——那两颗按钮对提问没有语义。
//   - 回包仍然是 allow，但答案要放在 `updatedInput` 里：`{questions, answers}`。
//     只点「允许」不带 updatedInput，模型拿不到任何选择（等于没答）。
//
// 交互约定（对齐 DSH，但「跳过」是逐题的）：
//   - 每题一份草稿，翻页不丢；下一页 / 上一页随时可翻，只有「提交」做完整性自检。
//   - 每道题都能单独「不答」：claude 的 answers 是 map，没有空值语义，所以用一句占位文本
//     回给模型（`ASK_SKIP_*`）。**不做整批 `allow:false`**——整批放弃是输入框「停止」的事。
//   - 推荐项只显示徽章、**不预选**：CLI 的 idle 超时不会采用我们本地的预选，预选只会让
//     人以为「已经答了」。
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { PermissionPayload } from "../../transport/types";
import {
  ASK_SKIP_EN,
  ASK_SKIP_ZH,
  askUpdatedInput,
  duplicateQuestionIndexes,
  emptyAskDrafts,
  firstUnanswered,
  isDraftAnswered,
  parseAskQuestions,
  type AskDraft,
  type AskQuestion,
} from "../../lib/askQuestion";
import { loadAskProgress, saveAskProgress } from "../../lib/askDrafts";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../store/useAppStore";
import { Button } from "../common/Button";
import { IconAlert, IconChat, IconCheck, IconChevronLeft, IconChevronRight } from "../common/Icons";
import { Markdown } from "../common/Markdown";
import { PermissionPanel, type PermissionReply } from "./PermissionPanel";

interface Props {
  perm: PermissionPayload;
  onReply: (opts: PermissionReply) => void;
}

/**
 * 提问卡片入口。
 *
 * `input` 结构解析不出来（老版本 CLI、被改坏的载荷）就回落到通用的 JSON 审批面板：
 * 那里至少还能「拒绝」，比一张渲染不出来的卡片强。
 */
export function AskUserQuestionPanel({ perm, onReply }: Props) {
  const questions = useMemo(() => parseAskQuestions(perm.input), [perm.input]);
  if (questions.length === 0) return <PermissionPanel perm={perm} onReply={onReply} />;
  return <AskCard perm={perm} questions={questions} onReply={onReply} />;
}

interface CardProps extends Props {
  questions: AskQuestion[];
}

function AskCard({ perm, questions, onReply }: CardProps) {
  const t = useT();
  // claude 的 idle 超时（用户级 settings 的 askUserQuestionTimeout）：配了之后问题会自己
  // 收尾。我们不改用户设置，只在卡片上说清楚，免得它无声无息地消失。
  const askTimeout = useAppStore((s) => s.info?.ask_question_timeout);
  const [progress, setProgress] = useState(() => {
    const saved = loadAskProgress(perm.request_id, questions.length);
    return saved ?? { index: 0, drafts: emptyAskDrafts(questions) };
  });
  const [error, setError] = useState<string | null>(null);
  const { index, drafts } = progress;
  const question = questions[index]!;
  const draft: AskDraft = drafts[index] ?? { selected: [], custom: "", refused: false };
  const last = questions.length - 1;
  const duplicates = useMemo(() => duplicateQuestionIndexes(questions), [questions]);
  const answered = drafts.filter(isDraftAnswered).length;

  // 每次改动立刻落盘（localStorage 同步写）：切对话 / 刷新 / webview 被回收都不丢。
  useEffect(() => {
    saveAskProgress(perm.request_id, index, drafts);
  }, [perm.request_id, index, drafts]);

  const go = (next: number) => {
    setError(null);
    setProgress((p) => ({ ...p, index: Math.min(Math.max(0, next), questions.length - 1) }));
  };

  const patch = (update: (current: AskDraft) => AskDraft, nextIndex = index) => {
    setError(null);
    setProgress((p) => ({
      index: nextIndex,
      drafts: p.drafts.map((item, i) => (i === index ? update(item) : item)),
    }));
  };

  const choose = (label: string) => {
    if (question.multiSelect) {
      patch((current) => ({
        ...current,
        refused: false,
        selected: current.selected.includes(label)
          ? current.selected.filter((item) => item !== label)
          : [...current.selected, label],
      }));
      return;
    }
    // 单选：选中即答完，顺手翻到下一题（最后一题停在原地，由「提交」收尾）。
    patch(() => ({ selected: [label], custom: "", refused: false }), index < last ? index + 1 : index);
  };

  const writeCustom = (value: string) => {
    // 单选的自定义回答与选项互斥；多选允许「选了 A 又补充一句」。
    patch((current) => ({ selected: question.multiSelect ? current.selected : [], custom: value, refused: false }));
  };

  const submit = () => {
    const missing = firstUnanswered(drafts);
    if (missing >= 0) {
      setProgress((p) => ({ ...p, index: missing }));
      setError(t(`第 ${missing + 1} 题还没有回答`, `Question ${missing + 1} is not answered yet`));
      return;
    }
    onReply({
      allow: true,
      // 逐题「不答」用一句自解释的话回给模型：claude 的 answers 没有空答案这种合法值。
      updatedInput: askUpdatedInput(perm.input, questions, drafts, t(ASK_SKIP_ZH, ASK_SKIP_EN)),
    });
  };

  const continueFlow = () => {
    if (index < last) go(index + 1);
    else submit();
  };

  const onCustomKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME 组合期按 Enter 是在确认候选，不能当成「下一题」。
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    continueFlow();
  };

  // 逐题拒绝：**只影响这一题**。整批放弃走输入框里的「停止」（中断整轮），
  // 不在这里再给一个「全部拒绝」的按钮——那会让人以为只跳过了当前这题。
  const toggleRefuse = () => {
    if (draft.refused) {
      patch((current) => ({ ...current, refused: false }));
      return;
    }
    patch(() => ({ selected: [], custom: "", refused: true }), index < last ? index + 1 : index);
  };

  return (
    <div
      role="dialog"
      aria-label={t("模型提问", "Claude asks")}
      className="flex max-h-[60dvh] flex-col overflow-hidden rounded-2xl border border-brand/30 bg-panel shadow-soft"
    >
      <div className="flex shrink-0 items-center gap-2 px-3.5 pt-3 text-[13px] font-semibold text-ink">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
          <IconChat size={15} />
        </span>
        <span className="shrink-0">{t("模型提问", "Claude asks")}</span>
        {question.header && (
          <span className="min-w-0 truncate rounded-full bg-panel-strong px-2 py-0.5 text-[10px] font-normal text-muted">
            {question.header}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[11px] font-normal text-muted">
          {index + 1} / {questions.length}
        </span>
      </div>

      {/* 题干、选项、输入框共用一个内部滚动区；头部（含 1/4 进度）与底栏固定。
          卡片的 max-h 比外层浮层的 max-h（64dvh）小一点，单张卡片永远不会顶到
          浮层的滚动条——边框一旦跟着滚，上下边就会被裁掉（踩过）。 */}
      <div className="dsh-scroll min-h-0 flex-1 overflow-y-auto pb-2">
        {askTimeout && askTimeout !== "never" && (
          <p className="px-3.5 pt-1 text-[10.5px] leading-relaxed text-warn">
            {t(
              `CLI 设置了提问超时（${askTimeout}）：不回答的话它会在超时后自己收尾`,
              `The CLI has a question timeout (${askTimeout}): unanswered questions close on their own`,
            )}
          </p>
        )}

        <div className="px-3.5 pt-2 text-[12.5px] leading-relaxed text-ink">
          <Markdown text={question.question} />
        </div>

        <div className="px-3.5 pt-2">
          {question.options.length > 0 ? (
            <div
              role={question.multiSelect ? "group" : "radiogroup"}
              aria-label={question.question}
              className="space-y-1.5"
            >
              {question.options.map((option, optionIndex) => {
                const checked = draft.selected.includes(option.label);
                return (
                  <button
                    key={`${optionIndex}-${option.label}`}
                    type="button"
                    role={question.multiSelect ? "checkbox" : "radio"}
                    aria-checked={checked}
                    onClick={() => choose(option.label)}
                    className={`flex w-full items-start gap-2 rounded-xl border px-2.5 py-2 text-left transition ${
                      checked
                        ? "border-brand bg-brand-soft"
                        : "border-line hover:bg-panel-strong/60"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border text-white ${
                        question.multiSelect ? "rounded-[4px]" : "rounded-full"
                      } ${checked ? "border-brand bg-brand" : "border-line-strong bg-canvas"}`}
                    >
                      {checked && <IconCheck size={11} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5 text-[12px] font-medium text-ink">
                        <span className="break-words">{option.display}</span>
                        {option.recommended && (
                          <span className="rounded-full bg-brand-soft px-1.5 py-0.5 text-[9.5px] font-normal text-brand">
                            {t("推荐", "Recommended")}
                          </span>
                        )}
                      </span>
                      {option.description && (
                        <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">{option.description}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            // 没有选项的题：只能自由作答，输入框自动聚焦（对齐 DSH 的 block 变体）。
            <p className="text-[11.5px] text-muted">{t("这题没有给出选项，直接写下你的回答。", "No options for this one; type your answer.")}</p>
          )}

          <label className="mt-2 block">
            <span className="sr-only">{t("自定义回答", "Custom answer")}</span>
            <textarea
              value={draft.custom}
              onChange={(e) => writeCustom(e.target.value)}
              onKeyDown={onCustomKeyDown}
              autoFocus={question.options.length === 0}
              rows={2}
              placeholder={
                question.multiSelect
                  ? t("也可以补充一句（可多选 + 补充）", "Add a note if you like (multi-select allowed)")
                  : t("或者自己写一个回答…", "Or type your own answer…")
              }
              className="w-full resize-y rounded-xl border border-line bg-canvas px-2.5 py-2 text-[12px] leading-relaxed text-ink outline-none placeholder:text-faint focus:border-brand/60"
            />
          </label>
          {draft.refused && (
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-warn">
              {t(
                "已跳过这题：模型会收到一句「用户跳过此题」，按它自己的判断继续。",
                "Skipped: Claude is told you skipped this question and will use its own judgment.",
              )}
            </p>
          )}
          <p className="pb-1 pt-1 text-[10px] text-faint">
            {t("Enter 下一题 / 提交，Shift+Enter 换行", "Enter for next / submit, Shift+Enter for a newline")}
          </p>
          {duplicates.length > 0 && (
            <p className="pb-1 text-[10px] text-warn">
              {t(
                "有两道题的文字完全相同，模型只会收到后一道的答案",
                "Two questions share the same text; Claude will only receive the later answer",
              )}
            </p>
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-panel px-3.5 py-3">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={t("上一页", "Previous page")}
            disabled={index === 0}
            onClick={() => go(index - 1)}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-panel-strong disabled:opacity-30"
          >
            <IconChevronLeft size={15} />
          </button>
          <button
            type="button"
            aria-label={t("下一页", "Next page")}
            disabled={index === last}
            onClick={() => go(index + 1)}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-panel-strong disabled:opacity-30"
          >
            <IconChevronRight size={15} />
          </button>
          <span className="ml-1 text-[10.5px] text-faint">
            {t(`${answered}/${questions.length} 已答`, `${answered}/${questions.length} answered`)}
          </span>
        </div>

        {error && (
          <span role="status" className="flex min-w-0 items-center gap-1 text-[11px] text-danger">
            <IconAlert size={12} className="shrink-0" />
            <span className="truncate">{error}</span>
          </span>
        )}

        <Button
          size="sm"
          variant={draft.refused ? "secondary" : "ghost"}
          className="ml-auto"
          aria-pressed={draft.refused}
          title={t(
            "只跳过这一题：模型会收到「用户跳过此题」，按它自己的判断继续",
            "Skip only this question; Claude is told you skipped it and proceeds on its own",
          )}
          onClick={toggleRefuse}
        >
          {draft.refused ? t("已跳过这题", "Skipped") : t("这题不答", "Skip this one")}
        </Button>
        <Button size="sm" variant="primary" onClick={continueFlow}>
          {index === last ? t("提交回答", "Submit") : t("下一题", "Next")}
        </Button>
      </div>
    </div>
  );
}
