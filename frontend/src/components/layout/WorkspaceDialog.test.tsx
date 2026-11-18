import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { SystemDialogs } from "../common/SystemDialogs";
import { useAppStore } from "../../store/useAppStore";
import { useDirsStore } from "../../store/useDirsStore";

const authorizeFnosDir = vi.fn();
const pickFnosDir = vi.fn();
vi.mock("../../lib/fnos", () => ({
  authorizeFnosDir: (path: string) => authorizeFnosDir(path),
  pickFnosDir: (params: unknown) => pickFnosDir(params),
}));

const addWorkspace = vi.fn();
const browseDirs = vi.fn();
const mkdirDir = vi.fn();
const probeDir = vi.fn();

const LISTING = {
  path: "/vol1/1000/demo",
  parent: "/vol1/1000",
  entries: [],
  roots: [],
  root: "/vol1",
  truncated: false,
};

/** 「已授权目录」芯片的数据源是 GET /api/dirs；默认回空列表。 */
function stubDirs(dirs: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ dirs, uid: 1000 }), { status: 200, headers: { "Content-Type": "application/json" } })),
  );
}

beforeEach(() => {
  stubDirs([]);
  useDirsStore.setState({ dirs: [], protected: [], uid: null, error: null, loading: false, removing: null });
  authorizeFnosDir.mockReset();
  pickFnosDir.mockReset();
  addWorkspace.mockReset().mockResolvedValue(true);
  browseDirs.mockReset().mockResolvedValue(LISTING);
  mkdirDir.mockReset();
  // 默认「应用用户写不进去」：授权链路的老用例仍然走 authorizeUserFile。
  probeDir.mockReset().mockResolvedValue({ path: "/vol1/1000/demo", writable: false, reason: "permission denied" });
  useAppStore.setState({
    workspaces: [],
    currentWorkspace: "",
    workspaceRoot: "/vol1/1000/demo",
    workspaceBusy: false,
    addWorkspace,
    browseDirs,
    mkdirDir,
    probeDir,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("应用用户已经能读写的目录直接登记，不再申请飞牛授权", async () => {
    probeDir.mockResolvedValue({ path: "/vol1/1000/demo", writable: true });
    const onClose = await openDialog();

    await submit();

    await waitFor(() => expect(addWorkspace).toHaveBeenCalledWith("/vol1/1000/demo"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(probeDir).toHaveBeenCalledWith("/vol1/1000/demo");
    expect(authorizeFnosDir).not.toHaveBeenCalled();
  });

  it("权限探测本身失败时退回飞牛授权，不阻塞添加", async () => {
    probeDir.mockRejectedValue(new Error("HTTP 502"));
    authorizeFnosDir.mockResolvedValue({ state: "ok" });
    await openDialog();

    await submit();

    // 全量跑时 jsdom worker 很挤，默认 1s 的 waitFor 偶尔不够（探测失败 → 授权 → 登记
    // 是一条异步链），放宽到 3s，避免把调度延迟当成失败。
    await waitFor(() => expect(authorizeFnosDir).toHaveBeenCalledWith("/vol1/1000/demo"), { timeout: 3000 });
    await waitFor(() => expect(addWorkspace).toHaveBeenCalledWith("/vol1/1000/demo"), { timeout: 3000 });
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

  it("「选择飞牛目录」挑完只进入该目录，不自动登记也不关闭弹窗", async () => {
    pickFnosDir.mockResolvedValue({ state: "ok", path: "/vol1/1000/picked" });
    browseDirs.mockResolvedValueOnce(LISTING).mockResolvedValue({ ...LISTING, path: "/vol1/1000/picked" });
    const onClose = await openDialog();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /选择飞牛目录/ }));
    });

    await waitFor(() => expect(browseDirs).toHaveBeenLastCalledWith("/vol1/1000/picked", false));
    // 挑完就授权了，但登记工作区要用户自己点「添加」
    expect(addWorkspace).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(authorizeFnosDir).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "目录路径" })).toHaveValue("/vol1/1000/picked");

    // 再点「添加」：目录已在 ACL 里，探测通过后直接登记，不再二次确认
    probeDir.mockResolvedValue({ path: "/vol1/1000/picked", writable: true });
    await submit();
    await waitFor(() => expect(addWorkspace).toHaveBeenCalledWith("/vol1/1000/picked"));
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

describe("WorkspaceDialog 的已授权目录", () => {
  // 打开弹窗就现查一次飞牛授权列表：用户可能刚在「设置 → 目录」或飞牛桌面里改过。
  it("读取飞牛已授权目录，芯片点一下就进入该目录", async () => {
    stubDirs(["/vol1/1000/other"]);
    await openDialog();

    const chip = await screen.findByRole("button", { name: "进入 /vol1/1000/other" });
    await act(async () => {
      fireEvent.click(chip);
    });
    await waitFor(() => expect(browseDirs).toHaveBeenLastCalledWith("/vol1/1000/other", false));
  });

  // 快捷入口原先和「已授权目录」重复（同一目录两行芯片），现在只剩一行。
  it("不再单独出现「快捷入口」", async () => {
    stubDirs(["/vol1/1000/other"]);
    await openDialog();

    expect(await screen.findByText("已授权目录")).toBeInTheDocument();
    expect(screen.queryByText("快捷入口")).toBeNull();
  });

  // 底部那行只读路径与「上一级」右侧的父路径都是重复信息：输入框里已经有当前路径。
  it("底部与「上一级」行不再显示多余的路径文本", async () => {
    await openDialog();

    expect(screen.getByRole("textbox", { name: "目录路径" })).toHaveValue("/vol1/1000/demo");
    expect(screen.queryByText("/vol1/1000/demo")).toBeNull();
    expect(screen.queryByText("/vol1/1000")).toBeNull();
  });

  // 这一栏只是跳转入口：撤销授权在「设置 → 目录」做。应用自己的安装目录也在
  // 列表里（ClaudeCode），在这里顺手删掉等于自断手脚。
  it("「已授权目录」只有跳转，没有任何删除入口", async () => {
    stubDirs(["/vol1/1000/other"]);
    useAppStore.setState({
      workspaces: [{ path: "/vol1/1000/demo", name: "demo", last_used: "", exists: true }],
      currentWorkspace: "/vol1/1000/demo",
    });
    await openDialog();

    expect(screen.getByRole("button", { name: "进入 /vol1/1000/demo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "进入 /vol1/1000/other" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /移除/ })).toBeNull();
  });
});

// 关闭弹窗时组件仍然挂载（`open=false` 只是早返回 null）。只要有一条 hook 排在
// `if (!open) return null` 之后，关闭就会「本次渲染的 hook 比上次少」→ React #300，
// 手机上是整屏「界面出错了」。这条用例把「开 → 关 → 再开」的 hooks 顺序钉住。
describe("WorkspaceDialog 的 hooks 顺序", () => {
  it("关闭再打开不报错（React #300 回归）", async () => {
    const onClose = vi.fn();
    const { rerender } = render(<WorkspaceDialog open onClose={onClose} />);
    await screen.findByRole("button", { name: /^添加$/ });

    await act(async () => {
      rerender(<WorkspaceDialog open={false} onClose={onClose} />);
    });
    expect(screen.queryByRole("button", { name: /^添加$/ })).toBeNull();

    await act(async () => {
      rerender(<WorkspaceDialog open onClose={onClose} />);
    });
    expect(await screen.findByRole("button", { name: /^添加$/ })).toBeInTheDocument();
  });
});
