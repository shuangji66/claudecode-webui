// claude 的 AskUserQuestion（模型在任务中间向用户提问）的协议解析与答案编码。
//
// 协议事实（Agent SDK 文档 + 官方 tools-reference）：
//   - 提问走的是 `can_use_tool` 这条审批通道，工具名 `AskUserQuestion`，
//     `input.questions` 是 1–4 道题，每题 2–4 个选项：
//     `{ question, header?, multiSelect?, options: [{ label, description? }] }`；
//   - 答案必须随 allow 回包以 **`updatedInput`** 形式回传：
//     `{ questions: <原样透传>, answers: { [question 文本]: label | label[] }, response? }`；
//   - `response` 是「整张卡片级」的自由回复，一旦带上，CLI 会把 per-question 的
//     answers 整份替换掉——所以逐题作答时不要用它。
//
// 与 DSH 的 ask_user_question 的差别（别照搬）：DSH 有自己的答案协议，能用空
// `selected: []` 表达「跳过」；claude 的答案是 map，没有「无答案」这种合法值。
// 本实现因此不提供跳过：每题必须有选择或自定义文本，提交前自检。

import type { Item, ToolItem } from "./model";

/** 一个选项。 */
export interface AskQuestionOption {
  /**
   * 原始 label：回给模型时必须与它给出的选项一字不差。
   * 「(Recommended)」后缀也算在原始 label 里——模型是按整串给的。
   */
  label: string;
  /** 展示用 label：去掉末尾的推荐标记，避免徽章旁还挂着半截英文。 */
  display: string;
  description: string;
  /** 末尾带 `(Recommended)` / `（推荐）`：只做徽章，**不预选**（见文件头）。 */
  recommended: boolean;
}

/** 一道题。 */
export interface AskQuestion {
  /** 题目正文，同时是 answers 的键。 */
  question: string;
  /** 短标题（≤12 字符），可能为空。 */
  header: string;
  /** 选项；可能为空——那就是只能自由作答的题。 */
  options: AskQuestionOption[];
  multiSelect: boolean;
}

/** 一道题的作答草稿。 */
export interface AskDraft {
  /** 已选中的**原始** label（多选可多个；单选最多一个）。 */
  selected: string[];
  /** 自定义回答；非空时单选会忽略 selected（两者互斥）。 */
  custom: string;
  /**
   * 这一题明确「不回答」。
   *
   * claude 的 answers 里没有「空答案」这种合法值（它是 `{问题原文: label|label[]}` 的 map），
   * 所以逐题拒绝只能以**一句占位文本**回给模型（见 `ASK_SKIP_*`）：告诉它「这题用户跳过，
   * 按你的最佳判断继续」。整批拒绝（`allow:false`）留给中断，不要混进逐题作答。
   */
  refused: boolean;
}

/**
 * 逐题拒绝时回给模型的占位文本。
 *
 * 为什么不用空数组/空串：那是「缺答」，CLI 会不会报错没有文档；而一句自解释的话模型读得懂，
 * 也不需要我们改系统提示词去解释「空值是什么意思」。
 */
export const ASK_SKIP_ZH = "（用户跳过此题，按你的最佳判断继续）";
export const ASK_SKIP_EN = "(The user skipped this question; proceed with your best judgment)";

/**
 * CLI 自己给的「这题没有选择」占位答案。
 *
 * 用户只写了备注、一个选项都没勾时，`tool_result` 里那道题写成
 * `"<问题原文>"=(no option selected)`（claude 2.1.325 的
 * `mapToolResultToToolResultBlockParam`）。它和「跳过」是同一类展示：**没有选任何选项**，
 * 不能当自定义回答渲染出来。
 */
export const ASK_NO_SELECTION = "(no option selected)";

/** 这条答案是不是「跳过」占位（历史回放用它显示「已跳过」而不是「自定义回答」）。 */
export function isSkipAnswer(answer: string | string[] | undefined): boolean {
  if (typeof answer !== "string") return false;
  return answer === ASK_SKIP_ZH || answer === ASK_SKIP_EN || answer === ASK_NO_SELECTION;
}

/** 推荐的两种写法（claude 自己的 TUI 用英文，DSH 两种都认）：只认行尾。 */
const RECOMMENDED_RE = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i;

/** 拆出 label 末尾的推荐标记。返回值里的 label 是去掉标记后的展示文本。 */
export function splitRecommended(label: string): { label: string; recommended: boolean } {
  const trimmed = label.trim();
  if (!RECOMMENDED_RE.test(trimmed)) return { label: trimmed, recommended: false };
  return { label: trimmed.replace(RECOMMENDED_RE, "").trim(), recommended: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析 `permission.input` 里的 questions。
 *
 * 任何一处结构不对就整体返回空数组：调用方据此回落到通用的 JSON 审批面板，
 * 而不是渲染一张半截卡片（半截卡片一提交就会给模型一份缺题的 answers）。
 * 选项层的容错则相反——单个坏选项只跳过它自己，不废掉整题。
 */
export function parseAskQuestions(input: unknown): AskQuestion[] {
  if (!isRecord(input)) return [];
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out: AskQuestion[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return [];
    // 问题原文**原样保留**（不 trim）：它是 `answers` 的键，必须与模型给的一字不差
    // ——官方示例就是 `answers[q["question"]] = …`，多一个空格就配不上。
    const question = typeof item.question === "string" ? item.question : "";
    if (!question.trim()) return [];
    const options: AskQuestionOption[] = [];
    if (Array.isArray(item.options)) {
      for (const opt of item.options) {
        if (!isRecord(opt)) continue;
        // label 同理：答案回传的是原始 label（含「(Recommended)」后缀与可能的空白），
        // 只有 `display` 是裁剪过的展示文本。
        const label = typeof opt.label === "string" ? opt.label : "";
        if (!label.trim()) continue;
        const split = splitRecommended(label);
        options.push({
          label,
          display: split.label,
          description: typeof opt.description === "string" ? opt.description.trim() : "",
          recommended: split.recommended,
        });
      }
    }
    out.push({
      question,
      header: typeof item.header === "string" ? item.header.trim() : "",
      options,
      multiSelect: item.multiSelect === true,
    });
  }
  return out;
}

/** 每题一份空草稿。 */
export function emptyAskDrafts(questions: AskQuestion[]): AskDraft[] {
  return questions.map(() => ({ selected: [], custom: "", refused: false }));
}

/** 这道题算不算处理过：选了选项、写了非空白的自定义文本，或明确「不回答」。 */
export function isDraftAnswered(draft: AskDraft | undefined): boolean {
  if (!draft) return false;
  return draft.refused || draft.selected.length > 0 || draft.custom.trim() !== "";
}

/** 第一道没答的题的下标；全答完返回 -1。提交前的自检就靠它。 */
export function firstUnanswered(drafts: AskDraft[]): number {
  for (let i = 0; i < drafts.length; i += 1) {
    if (!isDraftAnswered(drafts[i])) return i;
  }
  return -1;
}

/**
 * 问题文本重复的下标（第二道起）。
 *
 * answers 以问题原文为键，两道文字完全相同的题只能留下后一道的答案。极少见，
 * 但发生时会静默丢答案，所以界面上要提示一句。
 */
export function duplicateQuestionIndexes(questions: AskQuestion[]): number[] {
  const seen = new Set<string>();
  const dup: number[] = [];
  questions.forEach((q, i) => {
    if (seen.has(q.question)) dup.push(i);
    else seen.add(q.question);
  });
  return dup;
}

/**
 * 编码成 claude 要的 `answers`。
 *
 * 多选：已选 labels 的数组；多选 + 自定义：数组里再追加自定义文本（文档允许
 * 「数组或逗号拼接」，数组不会把含逗号的 label 拆错）。
 * 单选：自定义文本优先（界面保证它与 selected 互斥），否则就那一个 label。
 */
export function buildAskAnswers(
  questions: AskQuestion[],
  drafts: AskDraft[],
  /** 逐题拒绝时回给模型的占位文本（按界面语言给，中文为默认）。 */
  skipText: string = ASK_SKIP_ZH,
): Record<string, string | string[]> {
  const answers: Record<string, string | string[]> = {};
  questions.forEach((q, i) => {
    const draft = drafts[i] ?? { selected: [], custom: "", refused: false };
    if (draft.refused) {
      answers[q.question] = skipText;
      return;
    }
    const custom = draft.custom.trim();
    if (q.multiSelect) {
      answers[q.question] = custom ? [...draft.selected, custom] : [...draft.selected];
      return;
    }
    answers[q.question] = custom || draft.selected[0] || "";
  });
  return answers;
}

/**
 * 组装 allow 回包的 `updatedInput`。
 *
 * `questions` 必须原样回传模型给的那一份（含我们没渲染的未知字段）——CLI 按它
 * 校验答案；自己重新拼一份等于赌字段全对。
 */
export function askUpdatedInput(
  input: unknown,
  questions: AskQuestion[],
  drafts: AskDraft[],
  skipText: string = ASK_SKIP_ZH,
): { questions: unknown; answers: Record<string, string | string[]> } {
  const original = isRecord(input) && Array.isArray(input.questions) ? input.questions : [];
  return {
    // 原样回传模型给的那一份；拿不到时按我们解析出的内容**还原成 claude 的形状**
    // （只留 label/description，别把 display/recommended 这些前端字段塞回去）。
    questions: original.length > 0
      ? original
      : questions.map((q) => ({
          question: q.question,
          ...(q.header ? { header: q.header } : {}),
          ...(q.multiSelect ? { multiSelect: true } : {}),
          options: q.options.map((o) => ({ label: o.label, description: o.description })),
        })),
    answers: buildAskAnswers(questions, drafts, skipText),
  };
}

/**
 * CLI 把答案写回 `tool_result` 的**人话**形状（真机数据就是这个）。
 *
 * 实测 claude 2.1.325 的 `mapToolResultToToolResultBlockParam`：逐题拼成
 * `"<问题原文>"="<答案>"`（多选是数组被模板直接插值，于是变成 `A,B`，逗号后没有空格），
 * 一道没选的题写成 `"<问题>"=(no option selected)`，整串冠在下面某句前缀之后：
 *   - `Your questions have been answered: … You can now continue with these answers in mind.`
 *   - `The user answered: … Read the answers carefully — …`（有自定义回答时）
 *   - 超时（afk）：`… Before going idle the user had selected: …`
 *
 * **它不是 JSON**——所以只认 JSON 的旧解析在真机上一条都读不出来，卡片上所有选项都是
 * 未勾选状态。两种形状都认，JSON 在前（未来的结构化结果优先）。
 */
const PROSE_MARKERS = [
  "Your questions have been answered: ",
  "The user answered: ",
  "the user had selected: ",
];

/** 一对 `"问题"="答案"`；一道没选的题是 `(no option selected)` / `(notes only)`。 */
const PROSE_PAIR = /"([^"]*)"=(?:"([^"]*)"|\(([^)]*)\))/g;

/**
 * 读出一个引号包的答案。
 *
 * CLI 不做转义，答案里**可以带引号**（自定义回答、题干里本身就带引号），所以不能
 * 「取到下一个引号」了事——那样会把后面的文案一起吞进来。真机形状是
 * `"Q"="A", "Q2"="A2". You can now continue…`：结束引号后面紧跟 `, `（下一对）、
 * `.`（收尾句）或串尾。
 */
function readQuotedValue(raw: string): string | undefined {
  if (!raw.startsWith('"')) return undefined;
  for (let i = 1; i < raw.length; i += 1) {
    if (raw[i] !== '"') continue;
    const next = raw[i + 1];
    // 逗号也算收尾：切片按下一道题的锚点切开后，末尾那个 `, ` 可能已经被 trim 掉。
    if (next === undefined || next === "." || next === "," || raw.startsWith(", ", i + 1)) {
      return raw.slice(1, i);
    }
  }
  return raw.slice(1); // 没有像样的收尾引号：整段当答案，总比丢成空串好
}

/**
 * 人话里的答案，**按已知题目锚定**。
 *
 * 不锚定的话，题干里带一个引号就把整串切歪：`"Why does foo="bar" break?"="Because"`
 * 会解析出伪键 ` break?`，于是「题目一条都没配上」却返回了非空 map —— 气泡显示
 * 「没有记录到答案」并把真正的 `tool_result` 吞掉（AGENTS 4.2.1 明确不允许这样）。
 * 按 `"<题目原文>"=` 找锚点还顺带解决了「答案里带引号」：切片的终点是**下一道题的
 * 锚点**，不是下一个引号。
 */
function proseAnswersFor(text: string, questions: AskQuestion[]): Record<string, string> | null {
  if (!PROSE_MARKERS.some((marker) => text.includes(marker))) return null;
  const anchorOf = (q: string) => `"${q}"=`;
  const hits = questions
    .map((q) => ({ question: q.question, at: text.indexOf(anchorOf(q.question)) }))
    .filter((hit) => hit.at >= 0)
    .sort((a, b) => a.at - b.at);
  if (hits.length === 0) return null;

  const out: Record<string, string> = {};
  for (const [i, hit] of hits.entries()) {
    const anchor = anchorOf(hit.question);
    const from = hit.at + anchor.length;
    const to = i + 1 < hits.length ? hits[i + 1].at : text.length;
    const slice = text.slice(from, to).trim();
    if (slice.startsWith("(")) {
      // `(no option selected)` 与 CLI 的另一半 `(notes only)` 都是「这题没选」，
      // 统一成同一个哨兵值，`isSkipAnswer` 据此显示「已跳过」。
      out[hit.question] = ASK_NO_SELECTION;
      continue;
    }
    const value = readQuotedValue(slice);
    if (value !== undefined) out[hit.question] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 不知道题目时只能按形状切（兜底：只在调用方拿不到题目时走到）。 */
function proseAnswers(text: string): Record<string, string> | null {
  if (!PROSE_MARKERS.some((marker) => text.includes(marker))) return null;
  const out: Record<string, string> = {};
  let found = false;
  for (const match of text.matchAll(PROSE_PAIR)) {
    if (match[1] === "") continue;
    found = true;
    // 括号形态统一成哨兵值（`(no option selected)` / `(notes only)` 都是「没选」）。
    out[match[1]] = match[2] ?? ASK_NO_SELECTION;
  }
  return found ? out : null;
}

/**
 * 从工具结果的文本里捞回问答对（历史回放用）。
 *
 * 认两种形态：JSON（`{answers: {...}}`）与人话（见 `proseAnswersFor`）。
 * **能拿到题目时一定要传进来**：按锚点切才不会被题干里的引号带歪；拿不到题目时退回
 * 按形状切。都认不出就返回 null，由界面原样展示结果文本——不猜、不吞。
 */
export function answersFromResult(
  result: string | undefined,
  questions?: AskQuestion[],
): Record<string, string | string[]> | null {
  if (!result) return null;
  let value: unknown;
  try {
    value = JSON.parse(result);
  } catch {
    // 真机数据走这条：CLI 给的是人话，不是 JSON。
    return questions && questions.length > 0 ? proseAnswersFor(result, questions) : proseAnswers(result);
  }
  const answers = isRecord(value) ? value.answers : undefined;
  if (!isRecord(answers)) {
    return questions && questions.length > 0 ? proseAnswersFor(result, questions) : proseAnswers(result);
  }
  const out: Record<string, string | string[]> = {};
  for (const [key, raw] of Object.entries(answers)) {
    if (typeof raw === "string") out[key] = raw;
    else if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) out[key] = raw as string[];
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 按题目取答案：把多选的 `A,B` 拆回数组。
 *
 * 人话形状里多选是**逗号拼接**的（模板把数组插值了），不拆的话每一项都配不上 label，
 * 界面上就是「一道题都没选」。拆法按已知 label 走，三条边界：
 *   - 前面连续的都是已知 label → 拆成数组；「选项 + 自定义文本」拼在后面的，尾部落成一项；
 *   - 一个都不是已知 label → 整份就是自定义回答，原样留着（含逗号的自由文本不能被拆碎）；
 *   - 只有一项 → 保持字符串（单选与「只有一个多选项」都是这种）。
 */
export function answersOfQuestions(
  questions: AskQuestion[],
  result: string | undefined,
): Record<string, string | string[]> | null {
  const answers = answersFromResult(result, questions);
  if (!answers) return null;
  const out: Record<string, string | string[]> = {};
  for (const question of questions) {
    const answer = answers[question.question];
    if (answer === undefined) continue;
    if (typeof answer !== "string" || !question.multiSelect) {
      out[question.question] = answer;
      continue;
    }
    const labels = new Set(question.options.map((option) => option.label));
    const parts = answer.split(",").map((part) => part.trim());
    const head: string[] = [];
    while (head.length < parts.length && labels.has(parts[head.length])) head.push(parts[head.length]);
    if (head.length === parts.length) out[question.question] = head.length > 1 ? head : answer;
    else if (head.length === 0) out[question.question] = answer;
    else out[question.question] = [...head, parts.slice(head.length).join(",")];
  }
  return out;
}

/** 一题的作答，已经折成**展示用**的样子（气泡只渲染这个）。 */
export interface AskReply {
  question: AskQuestion;
  /** 选中选项的展示名，顺序与作答一致。 */
  chosen: string[];
  /** 不属于任何选项的部分 = 用户自己写的回答（多选时可能和选项并存）。 */
  custom: string;
  /** 这题被跳过（我们发的占位文本，或 CLI 的 `(no option selected)`）。 */
  skipped: boolean;
  /** 这次结果里有没有这道题的答案。false 时界面说「没有记录到答案」。 */
  recorded: boolean;
}

/**
 * 把「提问 + 结果」折成逐题问答。
 *
 * 题目解析不出来、或者答案形状认不出来时返回 null：调用方据此**继续用工具卡片**
 * （原样展示结果文本），而不是把一条读不懂的记录渲染成一个半空气泡。
 */
export function askReplies(input: unknown, result: string | undefined): AskReply[] | null {
  const questions = parseAskQuestions(input);
  if (questions.length === 0) return null;
  const answers = answersOfQuestions(questions, result);
  if (!answers) return null;
  return questions.map((question) => {
    const answer = answers[question.question];
    const labels = new Map(question.options.map((option) => [option.label, option.display]));
    const parts = answer === undefined ? [] : Array.isArray(answer) ? answer : [answer];
    const chosen: string[] = [];
    const custom: string[] = [];
    for (const part of parts) {
      if (part.trim() === "" || isSkipAnswer(part)) continue;
      const display = labels.get(part);
      if (display === undefined) custom.push(part);
      else chosen.push(display);
    }
    return {
      question,
      chosen,
      custom: custom.join("、"),
      skipped: isSkipAnswer(answer),
      recorded: answer !== undefined,
    };
  });
}

/**
 * 这条工具项是「已经答完的模型提问」：渲染成问答气泡，并且**不算过程**。
 *
 * 还在等回答（没有 result）、被拒 / 报错、或者结果形状认不出来时都返回 false，
 * 继续走原来的工具卡片——那些情况没有可展示的答案，把卡片换成气泡等于把结果原文吞掉。
 */
export function isAnsweredAsk(item: Item): item is ToolItem {
  return (
    item.kind === "tool" &&
    item.name === "AskUserQuestion" &&
    item.result !== undefined &&
    item.isError !== true &&
    askReplies(item.input, item.result) !== null
  );
}
