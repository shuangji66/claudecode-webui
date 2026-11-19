import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AskUserQuestionPanel } from "./AskUserQuestionPanel";
import type { PermissionPayload } from "../../transport/types";
import { useAppStore } from "../../store/useAppStore";

const rawQuestions = [
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
    options: [{ label: "安装" }, { label: "迁移", description: "从旧库迁数据" }],
  },
];

function perm(over: Partial<PermissionPayload> = {}): PermissionPayload {
  return {
    request_id: "ask-1",
    tool_name: "AskUserQuestion",
    display_name: "AskUserQuestion",
    input: { questions: rawQuestions },
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ info: null });
});

describe("AskUserQuestionPanel", () => {
  it("渲染问题、选项与说明，推荐项只加徽章、不预选", () => {
    render(<AskUserQuestionPanel perm={perm()} onReply={() => {}} />);
    expect(screen.getByText("模型提问")).toBeInTheDocument();
    expect(screen.getByText("用哪个数据库？")).toBeInTheDocument();
    expect(screen.getByText("事务与扩展都成熟")).toBeInTheDocument();
    expect(screen.getByText("推荐")).toBeInTheDocument();
    // 「(Recommended)」是给模型的原始 label，界面上只显示去掉后缀的那份
    expect(screen.queryByText(/Recommended\)/)).toBeNull();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios.every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
  });

  it("单选点一下即翻到下一题，回来时选中还在", () => {
    render(<AskUserQuestionPanel perm={perm()} onReply={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
    expect(screen.getByText("要包含哪些章节？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(screen.getByText("用哪个数据库？")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /SQLite/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("多选可以选多个，且自定义补充与选中并存", () => {
    const onReply = vi.fn();
    render(<AskUserQuestionPanel perm={perm()} onReply={onReply} />);
    fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    expect(screen.getByRole("checkbox", { name: /安装/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "再加一个附录" } });
    fireEvent.click(screen.getByText("提交回答"));
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply.mock.calls[0]![0]).toEqual({
      allow: true,
      updatedInput: {
        questions: rawQuestions,
        answers: { "用哪个数据库？": "SQLite", "要包含哪些章节？": ["安装", "迁移", "再加一个附录"] },
      },
    });
  });

  it("提交前自检：有未回答的题就跳回去并提示，不回包", () => {
    const onReply = vi.fn();
    render(<AskUserQuestionPanel perm={perm()} onReply={onReply} />);
    // 先翻到第二题作答，第一题留空
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    fireEvent.click(screen.getByText("提交回答"));
    expect(onReply).not.toHaveBeenCalled();
    expect(screen.getByText("第 1 题还没有回答")).toBeInTheDocument();
    expect(screen.getByText("用哪个数据库？")).toBeInTheDocument();
  });

  it("全部答完后提交，答案按 claude 的 answers 形状回传", () => {
    const onReply = vi.fn();
    render(<AskUserQuestionPanel perm={perm()} onReply={onReply} />);
    fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /安装/ }));
    fireEvent.click(screen.getByText("提交回答"));
    expect(onReply.mock.calls[0]![0]).toEqual({
      allow: true,
      updatedInput: {
        questions: rawQuestions,
        answers: { "用哪个数据库？": "SQLite", "要包含哪些章节？": ["安装"] },
      },
    });
  });

  it("单选用自定义回答时清掉已选选项", () => {
    const onReply = vi.fn();
    render(<AskUserQuestionPanel perm={perm()} onReply={onReply} />);
    fireEvent.click(screen.getByRole("radio", { name: /Postgres/ }));
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "其实用 MySQL" } });
    fireEvent.click(screen.getByText("下一题"));
    fireEvent.click(screen.getByRole("checkbox", { name: /安装/ }));
    fireEvent.click(screen.getByText("提交回答"));
    expect(onReply.mock.calls[0]![0].updatedInput).toEqual({
      questions: rawQuestions,
      answers: { "用哪个数据库？": "其实用 MySQL", "要包含哪些章节？": ["安装"] },
    });
  });

  // 逐题拒绝：只影响当前这一题，不牵连其他题（整批放弃走输入框的「停止」）。
  it("「这题不答」只跳过当前题并前进，回来仍是跳过状态", () => {
    render(<AskUserQuestionPanel perm={perm()} onReply={() => {}} />);
    fireEvent.click(screen.getByText("这题不答"));
    expect(screen.getByText("要包含哪些章节？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    const skip = screen.getByRole("button", { name: "已跳过这题" });
    expect(skip.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/已跳过这题：模型会收到一句「用户跳过此题」/)).toBeInTheDocument();
  });

  it("跳过的题以占位文本回给模型，其余题照常作答", () => {
    const onReply = vi.fn();
    render(<AskUserQuestionPanel perm={perm()} onReply={onReply} />);
    fireEvent.click(screen.getByText("这题不答"));
    fireEvent.click(screen.getByRole("checkbox", { name: /安装/ }));
    fireEvent.click(screen.getByText("提交回答"));
    expect(onReply.mock.calls[0]![0]).toEqual({
      allow: true,
      updatedInput: {
        questions: rawQuestions,
        answers: { "用哪个数据库？": "（用户跳过此题，按你的最佳判断继续）", "要包含哪些章节？": ["安装"] },
      },
    });
  });

  it("跳过之后再选选项会清掉跳过状态", () => {
    const onReply = vi.fn();
    render(<AskUserQuestionPanel perm={perm()} onReply={onReply} />);
    fireEvent.click(screen.getByText("这题不答"));
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
    expect(screen.queryByRole("button", { name: "已跳过这题" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /安装/ }));
    fireEvent.click(screen.getByText("提交回答"));
    expect(onReply.mock.calls[0]![0].updatedInput).toEqual({
      questions: rawQuestions,
      answers: { "用哪个数据库？": "SQLite", "要包含哪些章节？": ["安装"] },
    });
  });

  it("每一题都能单独跳过，全跳过也能提交", () => {
    const onReply = vi.fn();
    render(<AskUserQuestionPanel perm={perm()} onReply={onReply} />);
    fireEvent.click(screen.getByText("这题不答"));
    fireEvent.click(screen.getByText("这题不答"));
    fireEvent.click(screen.getByText("提交回答"));
    expect(onReply.mock.calls[0]![0].updatedInput).toEqual({
      questions: rawQuestions,
      answers: {
        "用哪个数据库？": "（用户跳过此题，按你的最佳判断继续）",
        "要包含哪些章节？": "（用户跳过此题，按你的最佳判断继续）",
      },
    });
  });

  it("题目正文里的 Markdown 正常渲染", () => {
    const q = [{ question: "选 **哪个** 方案？", options: [{ label: "A" }] }];
    render(<AskUserQuestionPanel perm={perm({ input: { questions: q } })} onReply={() => {}} />);
    expect(screen.getByText("哪个")).toBeInTheDocument();
  });

  it("结构不合法时回落到通用审批面板（还能拒绝）", () => {
    render(<AskUserQuestionPanel perm={perm({ input: { nope: true } })} onReply={() => {}} />);
    expect(screen.getByText(/需要授权：AskUserQuestion/)).toBeInTheDocument();
  });

  it("用户配了 askUserQuestionTimeout 时在卡片上提示", () => {
    useAppStore.setState({ info: { ask_question_timeout: "5m" } as never });
    render(<AskUserQuestionPanel perm={perm()} onReply={() => {}} />);
    expect(screen.getByText(/CLI 设置了提问超时（5m）/)).toBeInTheDocument();
  });

  it("超时值被设成 never 时不提示", () => {
    useAppStore.setState({ info: { ask_question_timeout: "never" } as never });
    render(<AskUserQuestionPanel perm={perm()} onReply={() => {}} />);
    expect(screen.queryByText(/提问超时/)).toBeNull();
  });

  // 切走对话再回来卡片会重新挂载，草稿必须从浏览器本地回填。
  it("重新挂载后从本地草稿恢复页码与答案", () => {
    const first = render(<AskUserQuestionPanel perm={perm()} onReply={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "备注" } });
    first.unmount();

    render(<AskUserQuestionPanel perm={perm()} onReply={() => {}} />);
    expect(screen.getByText("要包含哪些章节？")).toBeInTheDocument();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("备注");
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(screen.getByRole("radio", { name: /SQLite/ }).getAttribute("aria-checked")).toBe("true");
  });
});
