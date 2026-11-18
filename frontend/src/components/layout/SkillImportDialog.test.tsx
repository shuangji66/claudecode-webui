import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SkillImportDialog } from "./SkillImportDialog";
import { useSkillsStore } from "../../store/useSkillsStore";

const pickFnosFiles = vi.fn();
vi.mock("../../lib/fnos", () => ({ pickFnosFiles: (params: unknown) => pickFnosFiles(params) }));

const importEntries = vi.fn();
const importFromPaths = vi.fn();

const EMPTY = { personal: [], project: [], synced: [], project_root: "", personal_root: "" };

function setup(over: Partial<Parameters<typeof SkillImportDialog>[0]> = {}) {
  importEntries.mockReset().mockResolvedValue([]);
  importFromPaths.mockReset().mockResolvedValue([]);
  useSkillsStore.setState({
    cwd: "/work",
    data: { ...EMPTY, personal: [], project: [] },
    doc: null,
    error: null,
    busy: false,
    importEntries,
    importFromPaths,
  } as never);
  const props = {
    open: true,
    onClose: vi.fn(),
    onImported: vi.fn(),
    target: "/work",
    onTargetChange: vi.fn(),
    existing: { personal: [], project: [] },
    workspaces: [{ path: "/work", name: "work", last_used: "", exists: true }],
    ...over,
  };
  render(<SkillImportDialog {...props} />);
  return props;
}

beforeEach(() => {
  pickFnosFiles.mockReset();
});

describe("SkillImportDialog", () => {
  it("本地文件按文件名推技能名，导入到个人技能；完成即关闭弹窗", async () => {
    const props = setup();
    const file = new File(["---\ndescription: alpha\n---\n"], "alpha.md", { type: "text/markdown" });
    fireEvent.change(screen.getByLabelText("选择技能文件"), { target: { files: [file] } });

    expect(await screen.findByDisplayValue("alpha")).toBeTruthy();
    importEntries.mockResolvedValue([{ name: "alpha", ok: true }]);

    fireEvent.click(screen.getByRole("button", { name: /导入 1 个/ }));
    await waitFor(() => expect(importEntries).toHaveBeenCalledWith("personal", [{ name: "alpha", content: "---\ndescription: alpha\n---\n" }]));
    // 结果交给页面显示，弹窗自己关掉；底部不再有第二个「关闭」。
    await waitFor(() => expect(props.onImported).toHaveBeenCalledWith([{ name: "alpha", ok: true }]));
    expect(props.onClose).toHaveBeenCalled();
    // 底部不再有第二个「关闭」：只剩右上角那颗 ×。
    expect(screen.getAllByRole("button", { name: "关闭" })).toHaveLength(1);
  });

  it("选文件夹时只收 SKILL.md，并从目录名取名", async () => {
    setup();
    const skill = new File(["x\n"], "SKILL.md");
    Object.defineProperty(skill, "webkitRelativePath", { value: "myskills/deploy/SKILL.md" });
    const readme = new File(["docs\n"], "README.md");
    Object.defineProperty(readme, "webkitRelativePath", { value: "myskills/deploy/README.md" });

    fireEvent.change(screen.getByLabelText("选择技能文件夹"), { target: { files: [skill, readme] } });
    expect(await screen.findByDisplayValue("deploy")).toBeTruthy();
    expect(screen.queryByDisplayValue("README")).toBeNull();
  });

  it("项目级导入要求先选工作区，并在切换作用域后显示目标路径", async () => {
    const props = setup({ target: "" });
    const file = new File(["x\n"], "beta.md");
    fireEvent.change(screen.getByLabelText("选择技能文件"), { target: { files: [file] } });
    await screen.findByDisplayValue("beta");

    fireEvent.click(screen.getByRole("button", { name: "导入作用域" }));
    fireEvent.click(screen.getByRole("option", { name: "项目技能" }));
    const submit = screen.getByRole("button", { name: /导入 1 个/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByText(/先选一个工作区，才能导入项目技能/)).toBeTruthy();
    expect(props.onTargetChange).not.toHaveBeenCalled();
  });

  it("飞牛选择器只列 markdown（accept），不在宿主时给出人话提示", async () => {
    setup();
    pickFnosFiles.mockResolvedValue({ state: "skipped", reason: "standalone" });
    fireEvent.click(screen.getByRole("button", { name: /从飞牛选择/ }));
    expect(await screen.findByText(/当前不在飞牛宿主中/)).toBeTruthy();
    // 选择器过滤是「门帘」，老的宿主会忽略它——后端与前端都还会再校验一次。
    expect(pickFnosFiles).toHaveBeenCalledWith(expect.objectContaining({ accept: [".md", ".markdown"] }));
    expect(importFromPaths).not.toHaveBeenCalled();
  });

  it("飞牛返回多条 SKILL.md 时一次全部入清单，导入只传路径", async () => {
    const props = setup();
    pickFnosFiles.mockResolvedValue({ state: "ok", paths: ["/vol1/s/a/SKILL.md", "/vol1/s/b/SKILL.md"] });
    fireEvent.click(screen.getByRole("button", { name: /从飞牛选择/ }));
    expect(await screen.findByDisplayValue("a")).toBeTruthy();
    expect(screen.getByDisplayValue("b")).toBeTruthy();

    importFromPaths.mockResolvedValue([
      { path: "/vol1/s/a/SKILL.md", name: "a", ok: true },
      { path: "/vol1/s/b/SKILL.md", name: "b", ok: false, error: "同名技能已存在" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: /导入 2 个/ }));
    await waitFor(() => expect(importFromPaths).toHaveBeenCalledWith("personal", ["/vol1/s/a/SKILL.md", "/vol1/s/b/SKILL.md"]));
    // 逐条结果（含失败原因）原样交给页面，弹窗关闭。
    await waitFor(() =>
      expect(props.onImported).toHaveBeenCalledWith([
        { path: "/vol1/s/a/SKILL.md", name: "a", ok: true },
        { path: "/vol1/s/b/SKILL.md", name: "b", ok: false, error: "同名技能已存在" },
      ]),
    );
    expect(props.onClose).toHaveBeenCalled();
  });
});

describe("SkillImportDialog 的失败路径", () => {
  it("读不出来的文件既不进清单，也不能被下面的清空吞掉原因", async () => {
    setup();
    const good = new File(["x\n"], "good.md");
    const bad = new File(["y\n"], "bad.md");
    vi.spyOn(bad, "text").mockRejectedValue(new Error("文件被占用"));

    fireEvent.change(screen.getByLabelText("选择技能文件"), { target: { files: [good, bad] } });

    // 读得出来的照常入清单
    expect(await screen.findByDisplayValue("good")).toBeTruthy();
    // 读不出来的要说明是哪一条、为什么
    expect(screen.getByText(/bad\.md：文件被占用/)).toBeTruthy();
    expect(screen.queryByDisplayValue("bad")).toBeNull();
  });

  it("有条目没填名字时拦住导入，不静默少导一个", async () => {
    const props = setup();
    // 光秃秃的 SKILL.md 推不出目录名 → 技能名为空（红框）
    const file = new File(["x\n"], "SKILL.md");
    fireEvent.change(screen.getByLabelText("选择技能文件"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText("技能名")).toHaveValue(""));

    fireEvent.click(screen.getByRole("button", { name: /导入 1 个/ }));
    expect(await screen.findByText(/给每个技能填一个名字/)).toBeTruthy();
    expect(importEntries).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});
