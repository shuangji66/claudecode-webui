import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DirsSettings } from "./DirsSettings";
import { useAppStore } from "../../../store/useAppStore";
import { useDirsStore } from "../../../store/useDirsStore";
import { AUTH_MESSAGE } from "../../../lib/fnosAuth";

const addFnosDirAuth = vi.fn();
const hostAvailable = vi.fn(() => true);

vi.mock("../../../lib/fnos", () => ({
  addFnosDirAuth: (...args: unknown[]) => addFnosDirAuth(...args),
  fnosHostAvailable: () => hostAvailable(),
}));
vi.mock("../../common/SystemDialogs", () => ({ askConfirm: vi.fn().mockResolvedValue(true) }));

type Handler = (path: string, init?: RequestInit) => { status?: number; body: unknown };

/** 每个用例自己给 fetch 的应答：列表 GET 与撤销 POST 分开。 */
function stubFetch(handler: Handler) {
  const calls: { path: string; body?: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/api/, "/api");
      const init2 = init ?? {};
      calls.push({ path, body: init2.body ? JSON.parse(String(init2.body)) : undefined });
      const res = handler(path, init2);
      return new Response(JSON.stringify(res.body), {
        status: res.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

function seedInfo() {
  useAppStore.setState({ info: { trim_app: "ClaudeCode" } as never });
}

describe("设置 → 目录", () => {
  beforeEach(() => {
    localStorage.clear();
    useDirsStore.setState({ dirs: [], protected: [], uid: null, error: null, loading: false, removing: null });
    addFnosDirAuth.mockReset();
    hostAvailable.mockReturnValue(true);
    document.head.querySelector("base")?.remove();
    seedInfo();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("列出已授权目录，长路径整条可读（title）", async () => {
    stubFetch(() => ({ body: { dirs: ["/vol1/1000/workspace", "/vol2/share/照片"], uid: 1000 } }));
    render(<DirsSettings />);

    expect(await screen.findByText("/vol1/1000/workspace")).toBeInTheDocument();
    const long = screen.getByText("/vol2/share/照片");
    expect(long).toBeInTheDocument();
    expect(long).toHaveAttribute("title", "/vol2/share/照片");
    // 不需要打开目录 / 目录标识这类多余入口。
    expect(screen.queryByRole("button", { name: /打开/ })).toBeNull();
  });

  it("空列表给一句话，不是空白", async () => {
    stubFetch(() => ({ body: { dirs: [] } }));
    render(<DirsSettings />);
    expect(await screen.findByText("还没有授权目录")).toBeInTheDocument();
  });

  // 「查不到」和「没有授权」对用户是两件事：前者要说原因（不在飞牛网关下 / 缺 token）。
  it("后端给 error 时显示原因，而不是空列表", async () => {
    stubFetch(() => ({ body: { dirs: [], error: "拿不到当前飞牛用户：请从飞牛桌面或 App 打开本应用" } }));
    render(<DirsSettings />);
    expect(await screen.findByText(/拿不到当前飞牛用户/)).toBeInTheDocument();
    expect(screen.queryByText("还没有授权目录")).toBeNull();
  });

  it("撤销走 POST /api/dirs/remove 并刷新成后端返回的列表", async () => {
    let dirs = ["/vol1/a", "/vol1/b"];
    const calls = stubFetch((path) => {
      if (path === "/api/dirs/remove") dirs = ["/vol1/b"];
      return { body: { dirs, uid: 1000 } };
    });
    render(<DirsSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "撤销 /vol1/a 的授权" }));

    await waitFor(() => expect(screen.queryByText("/vol1/a")).toBeNull());
    expect(screen.getByText("/vol1/b")).toBeInTheDocument();
    const post = calls.find((c) => c.path === "/api/dirs/remove");
    expect(post?.body).toEqual({ path: "/vol1/a" });
  });

  // 应用自己的安装 / 数据目录是安装包固有目录：撤销等于自断手脚，后端也会拒绝，
  // 所以列表里干脆不出按钮。
  it("受保护目录没有撤销按钮", async () => {
    stubFetch(() => ({ body: { dirs: ["/vol1/@appshare/ClaudeCode", "/vol1/1000/tmp"], protected: ["/vol1/@appshare/ClaudeCode"] } }));
    render(<DirsSettings />);

    expect(await screen.findByText("/vol1/@appshare/ClaudeCode")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /撤销 \/vol1\/@appshare\/ClaudeCode/ })).toBeNull();
    // 普通目录照旧可撤销。
    expect(screen.getByRole("button", { name: "撤销 /vol1/1000/tmp 的授权" })).toBeInTheDocument();
  });

  // 后端 protectedConflict 的规则是「等于 / 在其上 / 在其内」都拒绝：撤销父目录
  // 同样会让应用的安装目录失去 ACL。前端只比相等的话会摆出一颗点了就报错的按钮。
  it("受保护目录的祖先目录也不给撤销按钮", async () => {
    stubFetch(() => ({
      body: { dirs: ["/vol1/@appdata", "/vol1/1000/tmp"], protected: ["/vol1/@appdata/ClaudeCode/data"] },
    }));
    render(<DirsSettings />);

    expect(await screen.findByText("/vol1/@appdata")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /撤销 \/vol1\/@appdata 的授权/ })).toBeNull();
    expect(screen.getByRole("button", { name: "撤销 /vol1/1000/tmp 的授权" })).toBeInTheDocument();
  });

  // 宿主内：选择器（pickUserFile）本身就是授权，选完直接刷新列表。
  it("宿主内添加：授权成功后刷新列表", async () => {
    let dirs: string[] = [];
    stubFetch(() => ({ body: { dirs, uid: 1000 } }));
    addFnosDirAuth.mockImplementation(async () => {
      dirs = ["/vol1/new"];
      return { state: "ok", path: "/vol1/new" };
    });
    render(<DirsSettings />);
    fireEvent.click(screen.getByRole("button", { name: "添加目录" }));

    expect(await screen.findByText("/vol1/new")).toBeInTheDocument();
    expect(addFnosDirAuth).toHaveBeenCalledTimes(1);
    // 授权页要用到 appname 与回调地址（宿主外才会真的打开）。
    const arg = addFnosDirAuth.mock.calls[0][0] as { appName: string; redirectUri: string; state: string };
    expect(arg.appName).toBe("ClaudeCode");
    expect(arg.redirectUri.endsWith("/callback")).toBe(true);
    expect(arg.state).not.toBe("");
  });

  // 宿主外：openAppAuth 另开窗口，按钮要给出「去那边确认，回来点刷新」的指示。
  it("宿主外添加：打开授权页后提示等待回调", async () => {
    stubFetch(() => ({ body: { dirs: [] } }));
    addFnosDirAuth.mockImplementation(async () => ({ state: "opened" }));
    render(<DirsSettings />);
    fireEvent.click(screen.getByRole("button", { name: "添加目录" }));

    expect(await screen.findByText(/已打开飞牛授权页/)).toBeInTheDocument();
  });

  // 直连端口访问（没有网关前缀）打不开 /app-auth，给一句人话而不是死链。
  it("宿主外且没有网关前缀时不打开授权页", async () => {
    hostAvailable.mockReturnValue(false);
    stubFetch(() => ({ body: { dirs: [] } }));
    render(<DirsSettings />);
    fireEvent.click(screen.getByRole("button", { name: "添加目录" }));

    expect(await screen.findByText(/直连端口访问打不开飞牛授权页/)).toBeInTheDocument();
    expect(addFnosDirAuth).not.toHaveBeenCalled();
  });

  // 回调页 postMessage 回来：只认自己发起的那次 state，然后刷新。
  it("收到回调消息（state 一致）后刷新列表", async () => {
    let dirs: string[] = [];
    stubFetch(() => ({ body: { dirs, uid: 1000 } }));
    addFnosDirAuth.mockImplementation(async () => ({ state: "opened" }));
    render(<DirsSettings />);
    fireEvent.click(screen.getByRole("button", { name: "添加目录" }));
    const state = (addFnosDirAuth.mock.calls[0][0] as { state: string }).state;
    await screen.findByText(/已打开飞牛授权页/);

    dirs = ["/vol1/from-auth"];
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: { type: AUTH_MESSAGE, result: { status: "success", state, paths: ["/vol1/from-auth"] } },
        }),
      );
    });

    expect(await screen.findByText("/vol1/from-auth")).toBeInTheDocument();
    expect(screen.queryByText(/已打开飞牛授权页/)).toBeNull();
  });

  // state 不对（别的窗口 / 重放）必须忽略：否则任意页面都能让我们刷新、误以为授权成功。
  it("state 不一致的回调消息被忽略", async () => {
    stubFetch(() => ({ body: { dirs: [] } }));
    addFnosDirAuth.mockImplementation(async () => ({ state: "opened" }));
    render(<DirsSettings />);
    fireEvent.click(screen.getByRole("button", { name: "添加目录" }));
    await screen.findByText(/已打开飞牛授权页/);

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: { type: AUTH_MESSAGE, result: { status: "success", state: "other", paths: ["/vol1/x"] } },
        }),
      );
    });
    expect(screen.queryByText("/vol1/x")).toBeNull();
  });
});
