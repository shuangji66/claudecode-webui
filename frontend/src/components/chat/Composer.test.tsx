import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "./Composer";
import { useAppStore } from "../../store/useAppStore";
import { SystemDialogs } from "../common/SystemDialogs";

const pickFnosFiles = vi.fn();
vi.mock("../../lib/fnos", () => ({
  pickFnosFiles: (params: unknown) => pickFnosFiles(params),
}));

const readHostFile = vi.fn();

const COMMANDS = [
  { name: "compact", description: "压缩以上对话内容" },
  { name: "model", description: "选择本会话使用的模型", argumentHint: "[model]" },
];

function setup(overrides: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const onSend = vi.fn();
  render(
    <Composer
      disabled={false}
      sendBlocked={false}
      starting={false}
      commands={COMMANDS}
      busy={false}
      modelOptions={[]}
      selectedKey=""
      selectedEffort=""
      permissionMode=""
      onSelectModel={vi.fn()}
      onSelectEffort={vi.fn()}
      onPermissionMode={vi.fn()}
      onSend={onSend}
      onInterrupt={vi.fn()}
      {...overrides}
    />,
  );
  return { onSend };
}

const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "添加" }));

beforeEach(() => {
  pickFnosFiles.mockReset();
  readHostFile.mockReset();
  useAppStore.setState({ readHostFile });
});

describe("Composer 添加菜单", () => {
  it("「+」打开菜单，分「添加」与「指令」两组", () => {
    setup();
    openMenu();

    expect(screen.getByText("添加")).toBeInTheDocument();
    expect(screen.getByText("指令")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /本地文件/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /从飞牛选择/ })).toBeInTheDocument();
  });

  it("点指令把 /name 插进输入框", () => {
    setup();
    openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: /compact/ }));

    const input = screen.getByRole("textbox", { name: "消息输入框" }) as HTMLTextAreaElement;
    expect(input.value).toBe("/compact ");
  });

  it("从飞牛选中图片时读成附件", async () => {
    pickFnosFiles.mockResolvedValue({ state: "ok", paths: ["/vol1/1000/pic/photo.png"] });
    readHostFile.mockResolvedValue({
      name: "photo.png",
      media_type: "image/png",
      size: 3,
      data: "AAAA",
    });
    setup();

    openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /从飞牛选择/ }));
    });

    expect(readHostFile).toHaveBeenCalledWith("/vol1/1000/pic/photo.png");
    expect(await screen.findByText("photo.png")).toBeInTheDocument();
  });

  it("从飞牛选中非图片/PDF 时只写路径引用，不读字节", async () => {
    pickFnosFiles.mockResolvedValue({ state: "ok", paths: ["/vol1/1000/docs/notes.md"] });
    setup();

    openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /从飞牛选择/ }));
    });

    const input = screen.getByRole("textbox", { name: "消息输入框" }) as HTMLTextAreaElement;
    expect(input.value).toBe("/vol1/1000/docs/notes.md\n");
    expect(readHostFile).not.toHaveBeenCalled();
  });

  it("不在飞牛宿主里时给出提示，不新增附件", async () => {
    pickFnosFiles.mockResolvedValue({ state: "skipped", reason: "standalone" });
    setup();

    openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /从飞牛选择/ }));
    });

    expect(await screen.findByText(/无法打开飞牛文件选择器/)).toBeInTheDocument();
  });
});

describe("Composer 权限模式", () => {
  function setupMode() {
    const onPermissionMode = vi.fn();
    render(
      <>
        <SystemDialogs />
        <Composer
          disabled={false}
          sendBlocked={false}
          starting={false}
          commands={COMMANDS}
          busy={false}
          modelOptions={[]}
          selectedKey=""
          selectedEffort=""
          permissionMode=""
          onSelectModel={vi.fn()}
          onSelectEffort={vi.fn()}
          onPermissionMode={onPermissionMode}
          onSend={vi.fn()}
          onInterrupt={vi.fn()}
        />
      </>,
    );
    return { onPermissionMode };
  }

  it("危险模式（跳过权限）先弹二次确认，确认后才切换", async () => {
    const { onPermissionMode } = setupMode();
    fireEvent.click(screen.getByLabelText("权限模式"));
    fireEvent.click(screen.getByRole("option", { name: "跳过权限" }));

    expect(await screen.findByText("切换到「跳过权限」？")).toBeInTheDocument();
    expect(onPermissionMode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("仍然切换"));
    await waitFor(() => expect(onPermissionMode).toHaveBeenCalledWith("bypassPermissions"));
  });

  it("取消确认就不切换", async () => {
    const { onPermissionMode } = setupMode();
    fireEvent.click(screen.getByLabelText("权限模式"));
    fireEvent.click(screen.getByRole("option", { name: "不询问" }));
    expect(await screen.findByText("切换到「不询问」？")).toBeInTheDocument();

    fireEvent.click(screen.getByText("保持当前模式"));
    await waitFor(() => expect(screen.queryByText("切换到「不询问」？")).toBeNull());
    expect(onPermissionMode).not.toHaveBeenCalled();
  });

  it("安全模式直接切换，不弹窗", () => {
    const { onPermissionMode } = setupMode();
    fireEvent.click(screen.getByLabelText("权限模式"));
    fireEvent.click(screen.getByRole("option", { name: "计划模式" }));
    expect(onPermissionMode).toHaveBeenCalledWith("plan");
    expect(screen.queryByText(/切换到「/)).toBeNull();
  });
});
