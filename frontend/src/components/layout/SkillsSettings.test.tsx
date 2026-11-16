import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../common/SystemDialogs", () => ({ askConfirm: vi.fn().mockResolvedValue(true) }));
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SkillsSettings } from "./SkillsSettings";
import { useSkillsStore } from "../../store/useSkillsStore";
import type { SkillDoc, SkillsPayload } from "../../transport/types";

const load = vi.fn();
const read = vi.fn();
const save = vi.fn();
const remove = vi.fn();
const clearDoc = vi.fn();
const setError = vi.fn();

const DATA: SkillsPayload = {
  personal: [
    { name: "summarize", scope: "personal", description: "Summarize the diff", path: "/data/claude/.claude/skills/summarize/SKILL.md", updated: "2026-11-16T10:00:00Z", size: 120, read_only: false },
  ],
  project: [
    { name: "deploy", scope: "project", description: "Deploy to prod", path: "/work/.claude/skills/deploy/SKILL.md", updated: "2026-11-16T10:00:00Z", size: 90, read_only: false },
  ],
  synced: [
    { name: "pdf", scope: "synced", description: "Anthropic built-in", path: "/data/claude/.claude/skills/synced/pdf/SKILL.md", updated: "2026-11-16T10:00:00Z", size: 80, read_only: true },
  ],
  project_root: "/work",
  personal_root: "/data/claude/.claude/skills",
};

function doc(over: Partial<SkillDoc> = {}): SkillDoc {
  return {
    name: "summarize",
    scope: "personal",
    description: "Summarize the diff",
    path: "/data/claude/.claude/skills/summarize/SKILL.md",
    updated: "2026-11-16T10:00:00Z",
    size: 120,
    read_only: false,
    content: "---\ndescription: Summarize the diff\n---\n",
    ...over,
  };
}

beforeEach(() => {
  load.mockReset().mockResolvedValue(undefined);
  // 真 store 的 read/save 会同时更新 doc；这里照做，否则组件拿不到当前正文。
  read.mockReset().mockImplementation(async () => {
    const d = doc();
    useSkillsStore.setState({ doc: d });
    return d;
  });
  save.mockReset().mockImplementation(async (_scope, _name, content) => {
    const d = doc({ content });
    useSkillsStore.setState({ doc: d });
    return d;
  });
  remove.mockReset().mockResolvedValue(true);
  clearDoc.mockReset();
  setError.mockReset();
  useSkillsStore.setState({ cwd: "", data: DATA, doc: null, error: null, busy: false, load, read, save, remove, clearDoc, setError });
});

describe("SkillsSettings", () => {
  it("按来源列出技能并显示命令名", () => {
    render(<SkillsSettings cwd="/work" />);
    expect(screen.getByText("summarize")).toBeTruthy();
    expect(screen.getByText("deploy")).toBeTruthy();
    expect(screen.getByText("pdf")).toBeTruthy();
    expect(load).toHaveBeenCalledWith("/work");
  });

  it("选中技能后加载正文并可保存", async () => {
    render(<SkillsSettings cwd="/work" />);
    fireEvent.click(screen.getByText("summarize"));
    await waitFor(() => expect(read).toHaveBeenCalledWith("personal", "summarize"));

    const editor = await screen.findByRole("textbox", { name: "" });
    // 选中后编辑区出现命令名标题
    expect(screen.getByText("/summarize")).toBeTruthy();
    fireEvent.change(editor, { target: { value: "---\ndescription: 改过了\n---\n" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("personal", "summarize", "---\ndescription: 改过了\n---\n"));
  });

  it("只读来源不给删除按钮", async () => {
    read.mockImplementation(async () => {
      const d = doc({ scope: "synced", name: "pdf", read_only: true });
      useSkillsStore.setState({ doc: d });
      return d;
    });
    render(<SkillsSettings cwd="/work" />);
    fireEvent.click(screen.getByText("pdf"));
    await waitFor(() => expect(screen.getByText("/pdf")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    expect(screen.getByText("该来源只读")).toBeTruthy();
  });

  it("新建时名字为空不能提交", () => {
    render(<SkillsSettings cwd="/work" />);
    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    const create = screen.getByRole("button", { name: "创建" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
  });
});
