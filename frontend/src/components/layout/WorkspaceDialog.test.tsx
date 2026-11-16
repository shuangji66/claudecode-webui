import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { SystemDialogs } from "../common/SystemDialogs";
import { useAppStore } from "../../store/useAppStore";

const authorizeFnosDir = vi.fn();
const pickFnosDir = vi.fn();
vi.mock("../../lib/fnos", () => ({
  authorizeFnosDir: (path: string) => authorizeFnosDir(path),
  pickFnosDir: (params: unknown) => pickFnosDir(params),
}));

const addWorkspace = vi.fn();
const browseDirs = vi.fn();
const mkdirDir = vi.fn();

const LISTING = {
  path: "/vol1/1000/demo",
  parent: "/vol1/1000",
  entries: [],
  roots: [],
  root: "/vol1",
  truncated: false,
};

beforeEach(() => {
  authorizeFnosDir.mockReset();
  pickFnosDir.mockReset();
  addWorkspace.mockReset().mockResolvedValue(true);
  browseDirs.mockReset().mockResolvedValue(LISTING);
  mkdirDir.mockReset();
  useAppStore.setState({
    workspaces: [],
    currentWorkspace: "",
    workspaceRoot: "/vol1/1000/demo",
    workspaceBusy: false,
    addWorkspace,
    browseDirs,
    mkdirDir,
  });
});

/** 打开弹窗并等首次目录加载落定（load() 里的 setState 要在 act 内完成）。 */
const openDialog = async () => {
  const onClose = vi.fn();
  // 「新建文件夹」走统一的输入框，需要挂上全局对话框宿主。
  render(
    <>
      <WorkspaceDialog open onClose={onClose} />
      <SystemDialogs />
    </>,
  );
  await screen.findByRole("button", { name: /^添加$/ });
  return onClose;
};

const submit = async () => {
  const button = screen.getByRole("button", { name: /^添加$/ });
  await act(async () => {
    fireEvent.click(button);
  });
};

describe("WorkspaceDialog", () => {
  it("飞牛授权成功后登记工作区并关闭弹窗", async () => {
    authorizeFnosDir.mockResolvedValue({ state: "ok" });
    const onClose = await openDialog();

    await submit();

    await waitFor(() => expect(addWorkspace).toHaveBeenCalledWith("/vol1/1000/demo"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("用户取消飞牛授权时不登记工作区，并留在弹窗里提示", async () => {
    authorizeFnosDir.mockResolvedValue({ state: "denied", reason: "cancel" });
    const onClose = await openDialog();

    await submit();

    expect(await screen.findByText(/已取消飞牛目录授权/)).toBeInTheDocument();
    expect(addWorkspace).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("飞牛返回真实错误时把原文展示出来", async () => {
    authorizeFnosDir.mockResolvedValue({ state: "denied", reason: "message", message: "Permission denied" });
    await openDialog();

    await submit();

    expect(await screen.findByText(/飞牛目录授权失败：Permission denied/)).toBeInTheDocument();
    expect(addWorkspace).not.toHaveBeenCalled();
  });

  it("不在飞牛宿主里（直连端口）时跳过授权，按旧行为继续", async () => {
    authorizeFnosDir.mockResolvedValue({ state: "skipped", reason: "standalone" });
    await openDialog();

    await submit();

    await waitFor(() => expect(addWorkspace).toHaveBeenCalledWith("/vol1/1000/demo"));
  });

  it("「选择飞牛目录」挑完即登记（飞牛选择器本身就是授权）", async () => {
    pickFnosDir.mockResolvedValue({ state: "ok", path: "/vol1/1000/picked" });
    const onClose = await openDialog();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /选择飞牛目录/ }));
    });

    await waitFor(() => expect(addWorkspace).toHaveBeenCalledWith("/vol1/1000/picked"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // 已经授权过，不再走 authorizeUserFile 二次确认
    expect(authorizeFnosDir).not.toHaveBeenCalled();
  });

  it("不在飞牛宿主里时点「选择飞牛目录」给出提示，不登记", async () => {
    pickFnosDir.mockResolvedValue({ state: "skipped", reason: "standalone" });
    await openDialog();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /选择飞牛目录/ }));
    });

    expect(await screen.findByText(/无法打开飞牛目录选择器/)).toBeInTheDocument();
    expect(addWorkspace).not.toHaveBeenCalled();
  });

  it("「新建文件夹」用统一输入框填入名称，建好后进入新目录", async () => {
    mkdirDir.mockResolvedValue("/vol1/1000/demo/新目录");
    browseDirs.mockResolvedValueOnce(LISTING).mockResolvedValue({ ...LISTING, path: "/vol1/1000/demo/新目录" });
    await openDialog();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /新建文件夹/ }));
    });

    // 自绘输入框（不是 window.prompt）
    const input = await screen.findByRole("textbox", { name: "新建文件夹" });
    fireEvent.change(input, { target: { value: "新目录" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "创建" }));
    });

    await waitFor(() => expect(mkdirDir).toHaveBeenCalledWith("/vol1/1000/demo", "新目录"));
    await waitFor(() => expect(browseDirs).toHaveBeenLastCalledWith("/vol1/1000/demo/新目录", false));
  });
});
