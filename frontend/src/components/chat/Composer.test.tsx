import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Composer } from "./Composer";
import { moveDraft, readDraft, writeDraft } from "../../lib/drafts";
import { useAppStore } from "../../store/useAppStore";
import { SystemDialogs } from "../common/SystemDialogs";

const pickFnosFiles = vi.fn();
const canPickFnos = vi.fn();
vi.mock("../../lib/fnos", () => ({
  pickFnosFiles: (params: unknown) => pickFnosFiles(params),
  canPickFnos: (opts: { channel?: string | null; inHost: boolean }) => canPickFnos(opts),
  fnosHostAvailable: () => true,
}));

const readHostFile = vi.fn();

const COMMANDS = [
  { name: "compact", description: "压缩以上对话内容" },
  { name: "model", description: "选择本会话使用的模型", argumentHint: "[model]" },
];

type ComposerProps = React.ComponentProps<typeof Composer>;

/** 一份完整的 props（测试只关心自己那几个），rebuild 时用来换 draftKey。 */
function composerEl(overrides: Partial<ComposerProps> = {}, onSend = vi.fn()) {
  return (
    <Composer
      disabled={false}
      sendBlocked={false}
      starting={false}
      commands={COMMANDS}
      busy={false}
      queued={[]}
      modelOptions={[]}
      selectedKey=""
      selectedEffort=""
      permissionMode=""
      cwd=""
      onSelectModel={vi.fn()}
      onSelectEffort={vi.fn()}
      onPermissionMode={vi.fn()}
      onSend={onSend}
      onQueue={vi.fn(() => true)}
      onDropQueued={vi.fn()}
      onEditQueued={vi.fn()}
      onEditingQueued={vi.fn()}
      onSteerQueued={vi.fn()}
      onInterrupt={vi.fn()}
      draftKey=""
      {...overrides}
    />
  );
}

function setup(overrides: Partial<ComposerProps> = {}) {
  const onSend = vi.fn();
  const utils = render(composerEl(overrides, onSend));
  return { onSend, ...utils };
}

const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "添加" }));

beforeEach(() => {
  pickFnosFiles.mockReset();
  readHostFile.mockReset();
  canPickFnos.mockReset();
  // 默认在飞牛宿主里（unix 通道）：`@` 菜单里才会出现「从飞牛选择」。
  canPickFnos.mockReturnValue(true);
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

  it("pointerdown 点外部就关：分隔线在 pointerdown 里 preventDefault，收不到 mousedown", () => {
    // 右侧栏分隔线的 onResizeStart 会 preventDefault，浏览器随即不再合成兼容的
    // mousedown；只听 mousedown 时拖分隔线菜单既不关也不跟随宽度。
    setup();
    openMenu();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("pointerdown 落在菜单或「+」按钮上时不关", () => {
    setup();
    openMenu();

    fireEvent.pointerDown(screen.getByRole("menuitem", { name: /本地文件/ }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "添加" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
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

describe("Composer 指令补全", () => {
  it("补全列表用中文说明，而不是 CLI 的英文长句", () => {
    setup({
      commands: [
        {
          name: "simplify",
          description: "Skill — Review the changed code for cleanup opportunities and apply the fixes.",
        },
      ],
    });
    fireEvent.change(screen.getByLabelText("消息输入框"), { target: { value: "/si" } });

    expect(screen.getByText("精简改动过的代码")).toBeInTheDocument();
    expect(screen.queryByText(/Skill — Review/)).toBeNull();
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
          queued={[]}
          draftKey=""
          modelOptions={[]}
          selectedKey=""
          selectedEffort=""
          permissionMode=""
          cwd=""
          onSelectModel={vi.fn()}
          onSelectEffort={vi.fn()}
          onPermissionMode={onPermissionMode}
          onSend={vi.fn()}
          onQueue={vi.fn(() => true)}
          onDropQueued={vi.fn()}
          onEditQueued={vi.fn()}
          onEditingQueued={vi.fn()}
          onSteerQueued={vi.fn()}
          onInterrupt={vi.fn()}
        />
      </>,
    );
    return { onPermissionMode };
  }

  it("危险模式（跳过权限）先弹二次确认，确认后才切换", async () => {
    const { onPermissionMode } = setupMode();
    fireEvent.click(screen.getByLabelText(/^权限模式/));
    fireEvent.click(screen.getByRole("option", { name: "跳过权限" }));

    expect(await screen.findByText("切换到「跳过权限」？")).toBeInTheDocument();
    expect(onPermissionMode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("仍然切换"));
    await waitFor(() => expect(onPermissionMode).toHaveBeenCalledWith("bypassPermissions"));
  });

  it("取消确认就不切换", async () => {
    const { onPermissionMode } = setupMode();
    fireEvent.click(screen.getByLabelText(/^权限模式/));
    fireEvent.click(screen.getByRole("option", { name: "不询问" }));
    expect(await screen.findByText("切换到「不询问」？")).toBeInTheDocument();

    fireEvent.click(screen.getByText("保持当前模式"));
    await waitFor(() => expect(screen.queryByText("切换到「不询问」？")).toBeNull());
    expect(onPermissionMode).not.toHaveBeenCalled();
  });

  it("窄屏折叠模式文本：标签带容器查询折叠类，当前模式进 aria-label", () => {
    setupMode();
    // jsdom 不做布局，只能钉住类名：折叠由工具条的 @container 驱动（宽度跟着实际可用
    // 空间走，不是视口断点），标签在 ≤460px 时 display:none，图标与箭头留下。
    const trigger = screen.getByLabelText(/^权限模式/);
    expect(trigger).toHaveAccessibleName("权限模式 默认模式");
    expect(within(trigger).getByText("默认模式").className).toContain("@max-[460px]:hidden");
    expect(trigger.parentElement?.parentElement?.className).toContain("@container");
  });

  it("安全模式直接切换，不弹窗", () => {
    const { onPermissionMode } = setupMode();
    fireEvent.click(screen.getByLabelText(/^权限模式/));
    fireEvent.click(screen.getByRole("option", { name: "计划模式" }));
    expect(onPermissionMode).toHaveBeenCalledWith("plan");
    expect(screen.queryByText(/切换到「/)).toBeNull();
  });
});


describe("Composer 草稿", () => {
  const textarea = () => screen.getByLabelText("消息输入框") as HTMLTextAreaElement;

  beforeEach(() => {
    localStorage.clear();
  });

  it("重进前端（组件重新挂载）后草稿还在", () => {
    const first = setup({ draftKey: "s1" });
    fireEvent.change(textarea(), { target: { value: "打了半天的提示词" } });
    expect(readDraft("s1")).toBe("打了半天的提示词");
    first.unmount();

    setup({ draftKey: "s1" });
    expect(textarea().value).toBe("打了半天的提示词");
  });

  it("发送成功后草稿一并清掉，不留空壳", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    setup({ onSend, draftKey: "s1" });
    fireEvent.change(textarea(), { target: { value: "你好" } });
    fireEvent.keyDown(textarea(), { key: "Enter" });

    await waitFor(() => expect(textarea().value).toBe(""));
    expect(readDraft("s1")).toBe("");
  });

  it("每个对话一份：切过去看到它自己的草稿，切回来还在", () => {
    writeDraft("s1", "属于 s1");
    writeDraft("s2", "属于 s2");
    const { rerender } = render(composerEl({ draftKey: "s1" }));
    expect(textarea().value).toBe("属于 s1");

    rerender(composerEl({ draftKey: "s2" }));
    expect(textarea().value).toBe("属于 s2");

    rerender(composerEl({ draftKey: "s1" }));
    expect(textarea().value).toBe("属于 s1");
  });

  it("还没建会话（按工作区存的草稿）也照样恢复", () => {
    writeDraft("ws:/work", "新对话页打的字");
    setup({ draftKey: "ws:/work" });
    expect(textarea().value).toBe("新对话页打的字");
  });

  // 新对话页的第一条消息会让 store 在发送途中新建会话：createSession 调
  // moveDraft(ws:<目录>, 新 id) 把这串正文搬到刚生成的 id 下，随后 activeId 一变，
  // Composer 换键重读草稿——那串正文已经不是草稿了，却会被当成草稿放回输入框。
  it("新对话页发出首条消息时，输入框不残留刚发出的正文", async () => {
    const text = "这一串已经发出去了";
    let rerenderWithNewKey: () => void = () => {};
    const onSend = vi.fn(async () => {
      moveDraft("ws:/work", "s-new");
      rerenderWithNewKey();
      return true;
    });
    const { rerender } = render(composerEl({ draftKey: "ws:/work", onSend }, onSend));
    rerenderWithNewKey = () => rerender(composerEl({ draftKey: "s-new", onSend }, onSend));

    fireEvent.change(textarea(), { target: { value: text } });
    fireEvent.keyDown(textarea(), { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalled());
    await waitFor(() => expect(textarea().value).toBe(""));
    expect(readDraft("s-new")).toBe("");
  });
});

describe("Composer 发送结果", () => {
  const textarea = () => screen.getByLabelText("消息输入框") as HTMLTextAreaElement;

  it("发送失败时保留草稿与附件，不清空输入框", async () => {
    const onSend = vi.fn().mockResolvedValue(false);
    setup({ onSend });
    fireEvent.change(textarea(), { target: { value: "这段提示词不能丢" } });
    fireEvent.keyDown(textarea(), { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(textarea().value).toBe("这段提示词不能丢");
  });

  it("发送成功后才清空输入框", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    setup({ onSend });
    fireEvent.change(textarea(), { target: { value: "你好" } });
    fireEvent.keyDown(textarea(), { key: "Enter" });

    await waitFor(() => expect(textarea().value).toBe(""));
  });

  it("会话未就绪（sendBlocked）时 Enter 不发请求", () => {
    const onSend = vi.fn().mockResolvedValue(true);
    setup({ onSend, sendBlocked: true });
    fireEvent.change(textarea(), { target: { value: "在线吗" } });
    fireEvent.keyDown(textarea(), { key: "Enter" });

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea().value).toBe("在线吗");
  });
});

describe("Composer 待发送队列", () => {
  const textarea = () => screen.getByLabelText("消息输入框") as HTMLTextAreaElement;
  const queuedItem = { id: "q1", text: "改成不用 lodash", attachments: [], label: "附件：", ts: 1 };

  it("回合进行中 Enter 只入队：不写 stdin，也不清空成没提交", () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onQueue = vi.fn(() => true);
    setup({ onSend, onQueue, busy: true });

    fireEvent.change(textarea(), { target: { value: "改成不用 lodash" } });
    fireEvent.keyDown(textarea(), { key: "Enter" });

    expect(onQueue).toHaveBeenCalledWith("改成不用 lodash", []);
    expect(onSend).not.toHaveBeenCalled();
    // 已交给队列，草稿清空（内容在输入框上方的待发送里）。
    expect(textarea().value).toBe("");
  });

  it("Ctrl+Enter 才是立刻插话", () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onQueue = vi.fn(() => true);
    setup({ onSend, onQueue, busy: true });

    fireEvent.change(textarea(), { target: { value: "先别改测试" } });
    fireEvent.keyDown(textarea(), { key: "Enter", ctrlKey: true });

    // 进行中的 Ctrl+Enter 必须标 priority=now：不带的话 CLI 只会等这一轮收尾。
    expect(onSend).toHaveBeenCalledWith("先别改测试", [], { priority: "now" });
    expect(onQueue).not.toHaveBeenCalled();
  });

  it("待发送显示在输入框上方，带条数与投递时机", () => {
    setup({ busy: true, queued: [queuedItem, { ...queuedItem, id: "q2", text: "顺便跑一下 lint" }] });

    expect(screen.getByText(/待发送 2 条/)).toBeInTheDocument();
    expect(screen.getByText("改成不用 lodash")).toBeInTheDocument();
    expect(screen.getByText(/本轮结束后自动发送/)).toBeInTheDocument();
  });

  it("点正文就地展开编辑框，保存后按原位置更新这一条", () => {
    const onEditQueued = vi.fn();
    const onEditingQueued = vi.fn();
    setup({ busy: true, queued: [queuedItem], onEditQueued, onEditingQueued });

    fireEvent.click(screen.getByText("改成不用 lodash"));
    const editor = screen.getByLabelText("编辑待发送消息") as HTMLTextAreaElement;
    expect(editor.value).toBe("改成不用 lodash");
    // 编辑期间要让后端按住自动发送，别把改到一半的旧文本发出去。
    expect(onEditingQueued).toHaveBeenCalledWith("q1");

    fireEvent.change(editor, { target: { value: "改成不用 lodash，另外跑一下 lint" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(onEditQueued).toHaveBeenCalledWith("q1", "改成不用 lodash，另外跑一下 lint", []);
    expect(screen.queryByLabelText("编辑待发送消息")).toBeNull();
    expect(onEditingQueued).toHaveBeenLastCalledWith(null);
    // 正文编辑不影响主输入框的草稿。
    expect(textarea().value).toBe("");
  });

  it("Shift+Enter 换行、Esc 取消不保存", () => {
    const onEditQueued = vi.fn();
    setup({ busy: true, queued: [queuedItem], onEditQueued });

    fireEvent.click(screen.getByText("改成不用 lodash"));
    const editor = screen.getByLabelText("编辑待发送消息") as HTMLTextAreaElement;

    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    expect(onEditQueued).not.toHaveBeenCalled();
    expect(screen.getByLabelText("编辑待发送消息")).toBeInTheDocument();

    fireEvent.change(editor, { target: { value: "改到一半" } });
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(onEditQueued).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("编辑待发送消息")).toBeNull();
  });

  it("编辑时能移除附件，保存时一并提交", () => {
    const onEditQueued = vi.fn();
    const withFile = { ...queuedItem, attachments: [{ name: "a.png", media_type: "image/png", data: "aGk=" }] };
    setup({ busy: true, queued: [withFile], onEditQueued });

    fireEvent.click(screen.getByText("改成不用 lodash"));
    fireEvent.click(screen.getByLabelText("移除附件 a.png"));
    fireEvent.click(screen.getByText("保存"));

    expect(onEditQueued).toHaveBeenCalledWith("q1", "改成不用 lodash", []);
  });

  it("垃圾桶直接删掉整条（不用先进编辑）", () => {
    const onDropQueued = vi.fn();
    setup({ busy: true, queued: [queuedItem], onDropQueued });

    fireEvent.click(screen.getByLabelText("删除这条待发送"));
    expect(onDropQueued).toHaveBeenCalledWith("q1");
  });

  it("编辑态里也能一步删除这条", () => {
    const onDropQueued = vi.fn();
    const onEditingQueued = vi.fn();
    setup({ busy: true, queued: [queuedItem], onDropQueued, onEditingQueued });

    fireEvent.click(screen.getByText("改成不用 lodash"));
    fireEvent.click(screen.getByRole("button", { name: /删除/ }));

    expect(onDropQueued).toHaveBeenCalledWith("q1");
    expect(screen.queryByLabelText("编辑待发送消息")).toBeNull();
    // 删掉之后必须放开按住，否则这个会话的自动发送会被永久卡住。
    expect(onEditingQueued).toHaveBeenLastCalledWith(null);
  });

  it("「立即插话」把这一条现在就发出去", () => {
    const onSteerQueued = vi.fn();
    setup({ busy: true, queued: [queuedItem], onSteerQueued });

    fireEvent.click(screen.getByLabelText("立即插话"));
    expect(onSteerQueued).toHaveBeenCalledWith("q1");
  });

  it("进行中且有草稿：主按钮换成发送（排队），中断缩成旁边的小圆钮", async () => {
    const onQueue = vi.fn(() => true);
    const onSend = vi.fn().mockResolvedValue(true);
    setup({ busy: true, onQueue, onSend });

    // 没内容时只有中断。
    expect(screen.queryByRole("button", { name: "发送并排队" })).toBeNull();
    expect(screen.getByRole("button", { name: "中断本轮" })).toBeInTheDocument();

    fireEvent.change(textarea(), { target: { value: "哈喽" } });
    const send = screen.getByRole("button", { name: "发送并排队" });
    expect(screen.getByRole("button", { name: "中断本轮" })).toBeInTheDocument();

    fireEvent.click(send);
    // 点发送 = 排队（不是立刻写 stdin），点完草稿清空、本轮继续跑。
    expect(onQueue).toHaveBeenCalledWith("哈喽", []);
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea().value).toBe("");
    expect(screen.getByRole("button", { name: "中断本轮" })).toBeInTheDocument();
  });

  it("进行中草稿清空后，发送按钮收起、只剩中断", () => {
    setup({ busy: true });
    fireEvent.change(textarea(), { target: { value: "写点什么" } });
    expect(screen.getByRole("button", { name: "发送并排队" })).toBeInTheDocument();

    fireEvent.change(textarea(), { target: { value: "   " } });
    expect(screen.queryByRole("button", { name: "发送并排队" })).toBeNull();
    expect(screen.getByRole("button", { name: "中断本轮" })).toBeInTheDocument();
  });

  it("不忙时这一条仍然可以手动发（被中断后暂停的队列）", () => {
    const onSteerQueued = vi.fn();
    setup({ busy: false, queued: [queuedItem], onSteerQueued });

    expect(screen.queryByLabelText("立即插话")).toBeNull();
    // 空闲时不会自动发（被中断的回合不替用户继续），所以文案不能写「即将发送」。
    expect(screen.getByText(/空闲中，点右侧箭头逐条发送/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("发送这条"));
    expect(onSteerQueued).toHaveBeenCalledWith("q1");
  });
});

describe("Composer @ 文件引用", () => {
  const completePaths = vi.fn();

  const listing = (entries: { path: string; type: "dir" | "file" }[]) => ({
    root: "/ws",
    path: "",
    truncated: false,
    entries: entries.map((entry) => ({
      name: entry.path.split("/").pop() ?? entry.path,
      path: entry.path,
      type: entry.type,
    })),
  });

  /** 输入正文并把光标放到末尾（fireEvent.change 不保证 selectionStart）。 */
  const typeAtEnd = (value: string) => {
    const input = screen.getByLabelText("消息输入框") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value } });
    input.setSelectionRange(value.length, value.length);
    fireEvent.select(input);
    return input;
  };

  beforeEach(() => {
    completePaths.mockReset();
    useAppStore.setState({ completePaths });
  });

  it("不在飞牛宿主里（或 TCP 直连）时菜单里没有「从飞牛选择」", async () => {
    canPickFnos.mockReturnValue(false);
    completePaths.mockResolvedValue(listing([{ path: "README.md", type: "file" }]));
    setup({ cwd: "/ws" });

    typeAtEnd("@");
    await screen.findByText("README.md");
    expect(screen.queryByText(/从飞牛选择/)).toBeNull();
  });

  it("输入 @ 弹出工作区候选，并带上会话 cwd 取列表", async () => {
    completePaths.mockResolvedValue(
      listing([
        { path: "src", type: "dir" },
        { path: "README.md", type: "file" },
      ]),
    );
    setup({ cwd: "/ws" });

    typeAtEnd("@");

    expect(await screen.findByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("src/")).toBeInTheDocument();
    expect(completePaths).toHaveBeenCalledWith("/ws", "", expect.anything());
    // 常驻的飞牛入口也在菜单里。
    expect(screen.getByText(/从飞牛选择/)).toBeInTheDocument();
  });

  it("Tab 进入目录：查询串换成这一层，菜单继续列内容", async () => {
    completePaths
      .mockResolvedValueOnce(listing([{ path: "src", type: "dir" }]))
      .mockResolvedValueOnce(listing([{ path: "src/main.go", type: "file" }]));
    setup({ cwd: "/ws" });

    const input = typeAtEnd("@");
    await screen.findByText("src/");
    fireEvent.keyDown(input, { key: "Tab" });

    expect(input.value).toBe("@src/");
    expect(await screen.findByText("main.go")).toBeInTheDocument();
    expect(completePaths).toHaveBeenLastCalledWith("/ws", "src/", expect.anything());
  });

  it("Enter 引用文件：把 @ 查询换成路径，不发送", async () => {
    completePaths.mockResolvedValue(listing([{ path: "README.md", type: "file" }]));
    const onSend = vi.fn().mockResolvedValue(true);
    setup({ cwd: "/ws", onSend });

    const input = typeAtEnd("@REA");
    await screen.findByText("README.md");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input.value).toBe("@README.md ");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("点目录行的 Tab 提示同样进入该目录", async () => {
    completePaths
      .mockResolvedValueOnce(listing([{ path: "src", type: "dir" }]))
      .mockResolvedValueOnce(listing([]));
    setup({ cwd: "/ws" });

    const input = typeAtEnd("@s");
    fireEvent.click(await screen.findByRole("button", { name: "进入 src" }));

    expect(input.value).toBe("@src/");
  });

  it("Esc 关掉菜单后 Enter 照常发送原文", async () => {
    completePaths.mockResolvedValue(listing([{ path: "README.md", type: "file" }]));
    const onSend = vi.fn().mockResolvedValue(true);
    setup({ cwd: "/ws", onSend });

    const input = typeAtEnd("@x");
    await screen.findByText("README.md");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByText("README.md")).toBeNull();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("@x", [], undefined);
  });

  it("菜单里的飞牛入口：调用选择器并顶掉 @ 查询", async () => {
    completePaths.mockResolvedValue(listing([]));
    pickFnosFiles.mockResolvedValue({ state: "ok", paths: ["/vol1/1000/docs/notes.md"] });
    setup({ cwd: "/ws" });

    const input = typeAtEnd("@no");
    fireEvent.click(await screen.findByRole("button", { name: /从飞牛选择/ }));

    await waitFor(() => expect(input.value).toBe("@/vol1/1000/docs/notes.md\n"));
    expect(pickFnosFiles).toHaveBeenCalled();
    expect(readHostFile).not.toHaveBeenCalled();
  });

  it("「从飞牛选择」排在第一行，但默认高亮仍是第一个工作区候选", async () => {
    completePaths.mockResolvedValue(
      listing([
        { path: "src", type: "dir" },
        { path: "README.md", type: "file" },
      ]),
    );
    const onSend = vi.fn().mockResolvedValue(true);
    setup({ cwd: "/ws", onSend });

    const input = typeAtEnd("@");
    await screen.findByText("src/");

    const rows = within(screen.getByLabelText("文件引用候选")).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("从飞牛选择");
    // 敲完 `@` 直接回车是引用第一个文件，不能被带进飞牛选择器。
    fireEvent.keyDown(input, { key: "Enter" });
    expect(pickFnosFiles).not.toHaveBeenCalled();
    expect(input.value).toBe("@src/ ");
  });

  it("Esc 关掉后删掉 @ 重新敲，菜单能再打开", async () => {
    completePaths.mockResolvedValue(listing([{ path: "README.md", type: "file" }]));
    setup({ cwd: "/ws" });

    const input = typeAtEnd("@");
    await screen.findByText("README.md");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByText("README.md")).toBeNull();

    // 删掉再敲：同一个位置、同一个查询串，tokenKey 与上次完全一样。
    typeAtEnd("");
    typeAtEnd("@");

    expect(await screen.findByText("README.md")).toBeInTheDocument();
  });
});

describe("Composer 粘贴图片", () => {
  const paste = (input: HTMLElement, items: unknown[], files: File[]) =>
    fireEvent.paste(input, { clipboardData: { items, files } });

  it("截图粘贴直接变成附件，没有文件名时补一个", async () => {
    setup();
    const input = screen.getByLabelText("消息输入框");
    const png = new File([new Uint8Array([137, 80, 78, 71])], "", { type: "image/png" });

    await act(async () => {
      paste(input, [{ kind: "file", getAsFile: () => png }], []);
    });

    expect(await screen.findByText(/^clipboard-\d{8}-\d{6}\.png$/)).toBeInTheDocument();
    expect(screen.getByText("4 B")).toBeInTheDocument();
  });

  it("带名字的文件沿用原名", async () => {
    setup();
    const input = screen.getByLabelText("消息输入框");
    const png = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });

    await act(async () => {
      paste(input, [], [png]);
    });

    expect(await screen.findByText("shot.png")).toBeInTheDocument();
  });

  it("纯文本粘贴不产生附件", () => {
    setup();
    const input = screen.getByLabelText("消息输入框");

    paste(input, [{ kind: "string", getAsFile: () => null }], []);

    expect(screen.queryByText(/^clipboard-/)).toBeNull();
    expect(screen.queryByLabelText(/^移除 /)).toBeNull();
  });
});

describe("Composer 附件预览", () => {
  const pasteImage = async (name: string, type = "image/png") => {
    const input = screen.getByLabelText("消息输入框");
    const file = new File([new Uint8Array([137, 80, 78, 71])], name, { type });
    await act(async () => {
      fireEvent.paste(input, { clipboardData: { items: [], files: [file] } });
    });
  };

  it("点图片缩略图打开大图，关闭后收起", async () => {
    setup();
    await pasteImage("shot.png");

    fireEvent.click(await screen.findByRole("button", { name: "预览 shot.png" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    // 文件名在芯片与预览标题里各出现一次，只在弹窗里断言。
    expect(within(dialog).getByText("shot.png")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /关闭/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("删除这条附件时预览跟着关掉", async () => {
    setup();
    await pasteImage("shot.png");
    fireEvent.click(await screen.findByRole("button", { name: "预览 shot.png" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "移除 shot.png" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("非图片附件不给预览按钮", async () => {
    setup();
    const input = screen.getByLabelText("消息输入框");
    const file = new File([new TextEncoder().encode("hello")], "notes.txt", { type: "text/plain" });
    await act(async () => {
      fireEvent.paste(input, { clipboardData: { items: [], files: [file] } });
    });

    expect(await screen.findByText("notes.txt")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /预览/ })).toBeNull();
  });
});

describe("Composer 引用到对话", () => {
  const textarea = () => screen.getByLabelText("消息输入框") as HTMLTextAreaElement;

  it("把绝对路径折成相对会话 cwd 的 @ 引用并消费请求", async () => {
    setup({ cwd: "/ws" });

    act(() => {
      useAppStore.getState().requestMention("/ws/src/main.go", "file");
    });

    await waitFor(() => expect(textarea().value).toBe("@src/main.go "));
    expect(useAppStore.getState().mentionRequest).toBeNull();
  });

  it("目录以 / 结尾；工作区外的路径保留绝对写法", async () => {
    setup({ cwd: "/ws" });

    act(() => {
      useAppStore.getState().requestMention("/ws/docs", "dir");
    });
    await waitFor(() => expect(textarea().value).toBe("@docs/ "));

    act(() => {
      useAppStore.getState().requestMention("/vol1/other/a.png", "file");
    });
    await waitFor(() => expect(textarea().value).toBe("@docs/ @/vol1/other/a.png "));
  });
});
