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

/** 这条答案是不是「跳过」占位（历史回放用它显示「已跳过」而不是「自定义回答」）。 */
export function isSkipAnswer(answer: string | string[] | undefined): boolean {
  if (typeof answer !== "string") return false;
  return answer === ASK_SKIP_ZH || answer === ASK_SKIP_EN;
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
 * 从工具结果的文本里捞回问答对（历史回放用）。
 *
 * CLI 的 result 具体形状没有文档，所以这里只认「JSON 里带 answers」这一种形态，
 * 认不出就返回 null，由界面原样展示结果文本——不猜、不吞。
 */
export function answersFromResult(
  result: string | undefined,
): Record<string, string | string[]> | null {
  if (!result) return null;
  let value: unknown;
  try {
    value = JSON.parse(result);
  } catch {
    return null;
  }
  const answers = isRecord(value) ? value.answers : undefined;
  if (!isRecord(answers)) return null;
  const out: Record<string, string | string[]> = {};
  for (const [key, raw] of Object.entries(answers)) {
    if (typeof raw === "string") out[key] = raw;
    else if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) out[key] = raw as string[];
  }
  return Object.keys(out).length > 0 ? out : null;
}
