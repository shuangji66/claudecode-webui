// 历史里的提问卡片（`AskUserQuestion`）。
//
// 实时提问由 `components/permission/AskUserQuestionPanel` 接管；这里只负责回放：
// 把模型问过的问题、当时给出的选项、以及用户的选择读出来。
//
// 答案来自 `tool_result`：CLI 的结果形状没有文档，`lib/askQuestion.answersFromResult`
// 只认「JSON 里带 answers」这一种，认不出就把原文本折叠显示——不猜、不吞。
import type { ToolItem } from "../../lib/model";
import { answersOfQuestions, isSkipAnswer, parseAskQuestions, type AskQuestion } from "../../lib/askQuestion";
import { useT } from "../../lib/i18n";
import { IconChat, IconCheck } from "../common/Icons";
import { Collapsible } from "../common/Collapsible";
import { GenericBody, GenericCard } from "./GenericCard";
import { ToolShell, type ToolStatus } from "./ToolShell";

/** 等待回答 / 已回答 / 没答成（被拒绝、工具报错）。 */
export function askStatus(item: ToolItem, t: (zh: string, en?: string) => string): ToolStatus {
  if (item.result === undefined) {
    return { label: t("等待回答", "Awaiting answer"), className: "bg-amber-50 text-warn dark:bg-amber-950/30", tone: "warn" };
  }
  if (item.isError) {
    return { label: t("未回答", "Not answered"), className: "bg-rose-50 text-danger dark:bg-rose-950/30", tone: "fail" };
  }
  return {
    label: t("已回答", "Answered"),
    className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300",
    tone: "ok",
  };
}

function isChosen(answer: string | string[] | undefined, label: string): boolean {
  if (answer === undefined) return false;
  return Array.isArray(answer) ? answer.includes(label) : answer === label;
}

/** 答案里不属于任何选项的部分 = 用户自己写的回答（多选时可能和选项并存）。 */
function customText(question: AskQuestion, answer: string | string[] | undefined): string {
  if (answer === undefined) return "";
  const labels = new Set(question.options.map((o) => o.label));
  const parts = Array.isArray(answer) ? answer : [answer];
  return parts
    .filter((p) => p.trim() !== "" && !labels.has(p))
    .join("、");
}

function QuestionView({ question, answer }: { question: AskQuestion; answer: string | string[] | undefined }) {
  const t = useT();
  const skipped = isSkipAnswer(answer);
  const custom = customText(question, answer);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {question.header && (
          <span className="rounded-full bg-panel-strong px-2 py-0.5 text-[10px] text-muted">{question.header}</span>
        )}
        <p className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-[12px] font-medium text-ink">{question.question}</p>
      </div>
      {question.options.length > 0 && (
        <ul className="space-y-1">
          {question.options.map((option) => {
            const chosen = isChosen(answer, option.label);
            return (
              <li key={option.label} className="flex items-start gap-1.5">
                <span className={`mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
                  chosen ? "border-brand bg-brand text-white" : "border-line-strong bg-canvas"
                }`} aria-hidden="true">
                  {chosen && <IconCheck size={9} />}
                </span>
                <span className="min-w-0">
                  <span className={`text-[11.5px] ${chosen ? "font-medium text-ink" : "text-muted"}`}>{option.display}</span>
                  {option.description && (
                    <span className="ml-1 text-[10.5px] text-faint">{option.description}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {skipped ? (
        <p className="text-[11.5px] text-warn">{t("已跳过这题", "Skipped")}</p>
      ) : (
        custom && (
          <p className="text-[11.5px] text-ink-2">
            {t("自定义回答：", "Custom answer: ")}
            {custom}
          </p>
        )
      )}
      {!custom && question.options.length === 0 && answer === undefined && (
        <p className="text-[11px] text-faint">{t("没有记录到答案", "No answer recorded")}</p>
      )}
    </div>
  );
}

/** 详细模式与紧凑模式共用的正文。 */
export function AskQuestionBody({ item }: { item: ToolItem }) {
  const t = useT();
  const questions = parseAskQuestions(item.input);
  // 带上题目再解析：人话结果按 `"<题目原文>"=` 锚定切，题干里带引号也不会切歪。
  const answers = answersOfQuestions(questions, item.result);

  // 结构解析不出来（旧版本 CLI / 载荷被改坏）：交回兜底卡片，至少能看到原始 JSON。
  if (questions.length === 0) return <GenericBody item={item} />;

  return (
    <div className="space-y-2.5 px-3 py-2.5">
      {/* 键里带下标：模型偶尔会问两道一字不差的题（answers 因此只剩后一条），
          用 question 文本当 key 会撞键、React 复用错行。 */}
      {questions.map((question, i) => (
        <QuestionView key={`${i}-${question.question}`} question={question} answer={answers?.[question.question]} />
      ))}
      {item.result !== undefined && !answers && (
        <Collapsible
          title={t("原始结果", "Raw result")}
          summary={(item.result.split("\n").find((line) => line.trim()) ?? "").slice(0, 60)}
        >
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] leading-relaxed text-ink-2">
            {item.result}
          </pre>
        </Collapsible>
      )}
    </div>
  );
}

export function AskQuestionCard({ item }: { item: ToolItem }) {
  const t = useT();
  const questions = parseAskQuestions(item.input);
  if (questions.length === 0) return <GenericCard item={item} />;
  return (
    <ToolShell item={item} icon={<IconChat size={14} />} title={t("提问", "Question")} status={askStatus(item, t)}>
      <AskQuestionBody item={item} />
    </ToolShell>
  );
}
