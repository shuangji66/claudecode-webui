// 已作答的模型提问：历史里的「问什么 / 我答了什么」渲染成用户气泡。
//
// 对齐 DSH 的 `question-reply`（`QuestionReplyView`）：答完之后不再铺整张选项卡片，
// 也不把它当「过程」收进「已完成」那一行——问答本身就是用户说的话，跟用户消息一样
// 用右侧气泡保留在正文里。选项清单、未选中的项都不再出现；要看原始结果时，
// 形状认不出答案的那次会**继续走工具卡片**（`isAnsweredAsk` 返回 false）。
import { useMemo } from "react";
import type { ToolItem } from "../../lib/model";
import { askReplies, type AskReply } from "../../lib/askQuestion";
import { useLocale, useT } from "../../lib/i18n";
import { clockTime } from "../../lib/labels";
import { CopyButton } from "../chat/CopyButton";

/** 一题的答案行：跳过的说「已跳过」，没记录的说「没有记录到答案」。 */
function answerLine(reply: AskReply, t: (zh: string, en?: string) => string): string {
  if (reply.skipped) return t("已跳过", "Skipped");
  const values = [...reply.chosen, ...(reply.custom ? [reply.custom] : [])];
  if (values.length > 0) return values.join("、");
  return reply.recorded ? t("（空）", "(empty)") : t("没有记录到答案", "No answer recorded");
}

/** 复制出去的文本：一题一段，问题带 header，答案只留用户给的那部分。 */
function copyText(replies: AskReply[], t: (zh: string, en?: string) => string): string {
  return replies
    .map((reply) => {
      const { header, question } = reply.question;
      const heading = header && header !== question ? `${header} — ${question}` : question;
      return `${heading}\n${t("答案：", "Answer: ")}${answerLine(reply, t)}`;
    })
    .join("\n\n");
}

export function AskReplyBubble({ item }: { item: ToolItem }) {
  const t = useT();
  const locale = useLocale();
  const replies = useMemo(() => askReplies(item.input, item.result), [item.input, item.result]);
  // 时间取「答案回来的那一刻」(`doneAt`)——气泡说的是用户答了什么，
  // 挂提问发出的时刻会早出几十秒。没有 doneAt（老数据）才退回 ts。
  const at = item.doneAt ?? item.ts;
  // 调用方用 `isAnsweredAsk` 筛过；解析结果为空只可能是数据在这两者之间变了。
  if (replies === null || replies.length === 0) return null;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="chat-text max-w-[86%] rounded-[18px] rounded-br-[6px] bg-bubble px-4 py-2.5 text-ink">
        <dl className="space-y-2">
          {/* 键里带下标：模型偶尔会问两道一字不差的题（answers 因此只剩后一条）。 */}
          {replies.map((reply, index) => (
            <div key={`${index}-${reply.question.question}`}>
              <dt className="text-[11.5px] leading-relaxed text-muted">
                {reply.question.header && reply.question.header !== reply.question.question && (
                  <span className="block text-[10.5px] text-faint">{reply.question.header}</span>
                )}
                {reply.question.question}
              </dt>
              <dd className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{answerLine(reply, t)}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="flex items-center gap-1.5 pr-1 text-[10.5px] text-faint">
        {at > 0 && <span className="tabular-nums">{clockTime(at, locale)}</span>}
        <CopyButton text={copyText(replies, t)} label={t("复制问答", "Copy Q&A")} />
      </div>
    </div>
  );
}
