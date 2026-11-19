import { describe, expect, it } from "vitest";
import {
  ASK_SKIP_EN,
  ASK_SKIP_ZH,
  answersFromResult,
  askUpdatedInput,
  buildAskAnswers,
  duplicateQuestionIndexes,
  emptyAskDrafts,
  firstUnanswered,
  isDraftAnswered,
  isSkipAnswer,
  parseAskQuestions,
  splitRecommended,
} from "./askQuestion";

function input(questions: unknown): unknown {
  return { questions };
}

const twoQuestions = input([
  {
    question: "用哪个数据库？",
    header: "数据库",
    options: [
      { label: "Postgres (Recommended)", description: "事务与扩展都成熟" },
      { label: "SQLite", description: "零运维，单机够用" },
    ],
  },
  {
    question: "要包含哪些章节？",
    header: "章节",
    multiSelect: true,
    options: [
      { label: "安装" },
      { label: "迁移", description: "从旧库迁数据" },
    ],
  },
]);

describe("splitRecommended", () => {
  it("认英文/中文两种推荐后缀，并去掉它", () => {
    expect(splitRecommended("Postgres (Recommended)")).toEqual({ label: "Postgres", recommended: true });
    expect(splitRecommended("Postgres（推荐）")).toEqual({ label: "Postgres", recommended: true });
  });

  it("只认行尾，中间出现不算", () => {
    expect(splitRecommended("(Recommended) 方案 B")).toEqual({ label: "(Recommended) 方案 B", recommended: false });
    expect(splitRecommended("SQLite")).toEqual({ label: "SQLite", recommended: false });
  });
});

describe("parseAskQuestions", () => {
  it("解析题目、选项与多选标记，推荐项保留原始 label 只多一个 display", () => {
    const qs = parseAskQuestions(twoQuestions);
    expect(qs).toHaveLength(2);
    expect(qs[0]?.header).toBe("数据库");
    expect(qs[0]?.multiSelect).toBe(false);
    expect(qs[0]?.options[0]).toEqual({
      // 原始 label 要原样回给模型，展示用的才是去掉后缀的那份
      label: "Postgres (Recommended)",
      display: "Postgres",
      description: "事务与扩展都成熟",
      recommended: true,
    });
    expect(qs[1]?.multiSelect).toBe(true);
    expect(qs[1]?.options[1]?.description).toBe("从旧库迁数据");
  });

  it("结构不合法时整体返回空（调用方回落到 JSON 审批面板）", () => {
    expect(parseAskQuestions(null)).toEqual([]);
    expect(parseAskQuestions({})).toEqual([]);
    expect(parseAskQuestions({ questions: [] })).toEqual([]);
    expect(parseAskQuestions({ questions: "nope" })).toEqual([]);
    // 缺 question 文本 = 没法生成 answers 的键
    expect(parseAskQuestions({ questions: [{ options: [{ label: "A" }] }] })).toEqual([]);
  });

  // answers 以问题原文为键、以原始 label 为值：这两处都不能 trim，多一个空格就配不上。
  it("问题原文与选项 label 原样保留，只有 display 被裁剪", () => {
    const qs = parseAskQuestions(input([{ question: "  选哪个？ ", options: [{ label: " A " }] }]));
    expect(qs[0]?.question).toBe("  选哪个？ ");
    expect(qs[0]?.options[0]?.label).toBe(" A ");
    expect(qs[0]?.options[0]?.display).toBe("A");
    expect(buildAskAnswers(qs, [{ selected: [" A "], custom: "", refused: false }])).toEqual({
      "  选哪个？ ": " A ",
    });
  });

  it("没有选项的题也保留（只能自由作答）", () => {
    const qs = parseAskQuestions(input([{ question: "项目叫什么名字？" }]));
    expect(qs).toHaveLength(1);
    expect(qs[0]?.options).toEqual([]);
  });

  it("单个坏选项只跳过自己", () => {
    const qs = parseAskQuestions(
      input([{ question: "选一个", options: [{ label: "A" }, { nope: 1 }, { label: "" }, { label: "B" }] }]),
    );
    expect(qs[0]?.options.map((o) => o.label)).toEqual(["A", "B"]);
  });
});

describe("草稿与自检", () => {
  it("选中选项、非空白自定义文本、或明确「不答」都算处理过", () => {
    expect(isDraftAnswered({ selected: [], custom: "", refused: false })).toBe(false);
    expect(isDraftAnswered({ selected: [], custom: "   ", refused: false })).toBe(false);
    expect(isDraftAnswered({ selected: ["A"], custom: "", refused: false })).toBe(true);
    expect(isDraftAnswered({ selected: [], custom: "自己写", refused: false })).toBe(true);
    // 逐题拒绝也是「处理过」：它会在提交时换成一句占位文本
    expect(isDraftAnswered({ selected: [], custom: "", refused: true })).toBe(true);
  });

  it("firstUnanswered 指向第一道没答的题", () => {
    const drafts = [
      { selected: ["A"], custom: "", refused: false },
      { selected: [], custom: "", refused: false },
      { selected: [], custom: "", refused: false },
    ];
    expect(firstUnanswered(drafts)).toBe(1);
    expect(firstUnanswered(emptyAskDrafts(parseAskQuestions(twoQuestions)))).toBe(0);
    expect(firstUnanswered([{ selected: ["A"], custom: "", refused: false }])).toBe(-1);
    expect(firstUnanswered([{ selected: [], custom: "", refused: true }])).toBe(-1);
  });

  it("发现重复的问题文本（answers 的键会互相覆盖）", () => {
    const qs = parseAskQuestions(
      input([
        { question: "同名问题", options: [{ label: "A" }] },
        { question: "另一个", options: [{ label: "B" }] },
        { question: "同名问题", options: [{ label: "C" }] },
      ]),
    );
    expect(duplicateQuestionIndexes(qs)).toEqual([2]);
  });
});

describe("buildAskAnswers", () => {
  it("单选给单个 label（原始写法），多选给数组", () => {
    const qs = parseAskQuestions(twoQuestions);
    const answers = buildAskAnswers(qs, [
      { selected: ["Postgres (Recommended)"], custom: "", refused: false },
      { selected: ["安装", "迁移"], custom: "", refused: false },
    ]);
    expect(answers).toEqual({
      "用哪个数据库？": "Postgres (Recommended)",
      "要包含哪些章节？": ["安装", "迁移"],
    });
  });

  it("自定义回答：单选替换选择，多选追加到已选之后", () => {
    const qs = parseAskQuestions(twoQuestions);
    expect(
      buildAskAnswers(qs, [
        { selected: ["SQLite"], custom: "其实用 MySQL", refused: false },
        { selected: ["安装"], custom: "再加一个附录", refused: false },
      ]),
    ).toEqual({
      "用哪个数据库？": "其实用 MySQL",
      "要包含哪些章节？": ["安装", "再加一个附录"],
    });
  });

  it("逐题拒绝换成占位文本，默认中文、可传英文", () => {
    const qs = parseAskQuestions(twoQuestions);
    const drafts = [
      { selected: [], custom: "", refused: true },
      { selected: ["安装"], custom: "", refused: false },
    ];
    expect(buildAskAnswers(qs, drafts)).toEqual({
      "用哪个数据库？": ASK_SKIP_ZH,
      "要包含哪些章节？": ["安装"],
    });
    expect(buildAskAnswers(qs, drafts, ASK_SKIP_EN)["用哪个数据库？"]).toBe(ASK_SKIP_EN);
    // 多选的题被跳过时也是整条占位文本，不是空数组
    expect(
      buildAskAnswers(qs, [
        { selected: [], custom: "自己写", refused: true },
        { selected: [], custom: "", refused: false },
      ])["用哪个数据库？"],
    ).toBe(ASK_SKIP_ZH);
  });

  it("isSkipAnswer 只认两种占位文本", () => {
    expect(isSkipAnswer(ASK_SKIP_ZH)).toBe(true);
    expect(isSkipAnswer(ASK_SKIP_EN)).toBe(true);
    expect(isSkipAnswer("SQLite")).toBe(false);
    expect(isSkipAnswer(["安装"])).toBe(false);
    expect(isSkipAnswer(undefined)).toBe(false);
  });

  it("updatedInput 原样回传模型的 questions（含没渲染的未知字段）", () => {
    const raw = [
      { question: "Q", options: [{ label: "A", preview: "<div>x</div>" }], somethingElse: 1 },
    ];
    const qs = parseAskQuestions({ questions: raw });
    const payload = askUpdatedInput({ questions: raw }, qs, [{ selected: ["A"], custom: "", refused: false }]);
    expect(payload.questions).toBe(raw);
    expect(payload.answers).toEqual({ Q: "A" });
  });
});

describe("answersFromResult", () => {
  it("认 JSON 里的 answers（历史回放）", () => {
    expect(answersFromResult('{"answers":{"Q":"A"}}')).toEqual({ Q: "A" });
    expect(answersFromResult('{"answers":{"Q":["A","B"]}}')).toEqual({ Q: ["A", "B"] });
  });

  it("认不出就返回 null，由界面原样显示结果文本", () => {
    expect(answersFromResult(undefined)).toBeNull();
    expect(answersFromResult("User has answered your questions")).toBeNull();
    expect(answersFromResult('{"foo":1}')).toBeNull();
  });
});
