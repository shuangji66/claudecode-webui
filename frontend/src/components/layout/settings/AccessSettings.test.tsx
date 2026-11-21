import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AccessSettings } from "./AccessSettings";
import { useAppStore } from "../../../store/useAppStore";
import { getToken } from "../../../lib/runtime";

const baseSettings = {
  providers: [],
  selected: { provider: "", model: "" },
  permission_mode: "default",
  locale: "zh",
  font_size: 15,
  tcp_enabled: false,
  tcp_port: 3141,
  tcp_password_set: false,
};

const baseInfo = {
  version: "test",
  base_url: "",
  socket: "/tmp/cc.sock",
  claude_bin: "",
  claude_version: "",
  projects_root: "/tmp",
  data_dir: "/tmp/data",
  claude_home: "/tmp/data/claude",
  settings_file: "/tmp/data/settings.json",
  workspaces_file: "/tmp/data/workspaces.json",
  auto_start: false,
  current_workspace: "/tmp",
  auth_required: false,
  auth_mode: "none",
  channel: "unix",
  tcp_port: 0,
  tcp_listening: false,
  frontend: true,
  max_sessions: 4,
  started_at: "",
};

function setStore(settings: Record<string, unknown> = {}, info: Record<string, unknown> = {}) {
  useAppStore.setState({
    settings: { ...baseSettings, ...settings } as never,
    info: { ...baseInfo, ...info } as never,
    settingsSaving: false,
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("AccessSettings", () => {
  beforeEach(() => {
    setStore();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("默认关闭端口访问，展示 3141", () => {
    render(<AccessSettings />);
    expect((screen.getByLabelText("TCP 端口") as HTMLInputElement).value).toBe("3141");
    expect(screen.getByText("端口访问已关闭。")).toBeTruthy();
    const sw = screen.getByRole("switch", { name: "启用端口访问" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect((screen.getByRole("button", { name: "保存访问设置" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("开启端口访问必须先设置合规密码；密码框可切换明文", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/settings" && init?.method === "PUT") {
        return jsonResponse({ ...baseSettings, tcp_enabled: true, tcp_port: 4141, tcp_password_set: true });
      }
      if (url === "/api/info") {
        return jsonResponse({ ...baseInfo, tcp_port: 4141, tcp_listening: true });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AccessSettings />);
    const save = screen.getByRole("button", { name: "保存访问设置" }) as HTMLButtonElement;

    fireEvent.click(screen.getByRole("switch", { name: "启用端口访问" }));
    fireEvent.change(screen.getByLabelText("TCP 端口"), { target: { value: "4141" } });
    // 没有密码：不能保存，并明确提示
    expect(save.disabled).toBe(true);
    expect(screen.getByText("开启端口访问前必须先设置访问密码。")).toBeTruthy();

    // 弱密码：仍不能保存，提示具体缺什么
    const pwd = screen.getByLabelText("访问密码") as HTMLInputElement;
    fireEvent.change(pwd, { target: { value: "short" } });
    expect(save.disabled).toBe(true);
    expect(screen.getByText("密码至少 8 位")).toBeTruthy();

    fireEvent.change(pwd, { target: { value: "s3cret-123" } });
    expect(save.disabled).toBe(false);

    // 小眼睛按钮：默认隐藏，可切明文
    expect(pwd.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "显示密码" }));
    expect(pwd.type).toBe("text");

    await act(async () => {
      fireEvent.click(save);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const put = fetchMock.mock.calls.find(([url, init]) => url === "/api/settings" && (init as RequestInit)?.method === "PUT");
    expect(put).toBeTruthy();
    const body = JSON.parse(String((put as unknown as [string, RequestInit])[1].body));
    expect(body).toEqual({ tcp_enabled: true, tcp_port: 4141, tcp_password: "s3cret-123" });
    // 密码框保存后清空
    expect((screen.getByLabelText("访问密码") as HTMLInputElement).value).toBe("");
  });

  it("已保存过密码时，开启访问不必重新输入", async () => {
    setStore({ tcp_password_set: true });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/settings" && init?.method === "PUT") {
        return jsonResponse({ ...baseSettings, tcp_enabled: true, tcp_password_set: true });
      }
      if (url === "/api/info") return jsonResponse({ ...baseInfo, tcp_listening: true, tcp_port: 3141 });
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AccessSettings />);
    fireEvent.click(screen.getByRole("switch", { name: "启用端口访问" }));
    const save = screen.getByRole("button", { name: "保存访问设置" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(save);
    });
    const put = fetchMock.mock.calls.find(([url, init]) => url === "/api/settings" && (init as RequestInit)?.method === "PUT");
    const body = JSON.parse(String((put as unknown as [string, RequestInit])[1].body));
    expect(body).toEqual({ tcp_enabled: true, tcp_port: 3141 });
  });

  it("登录有效期 12–72 步进 12，默认 24，改了才写进补丁", async () => {
    setStore({ tcp_password_set: true, login_ttl_hours: 24 });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/settings" && init?.method === "PUT") {
        return jsonResponse({ ...baseSettings, tcp_password_set: true, login_ttl_hours: 36 });
      }
      if (url === "/api/info") return jsonResponse({ ...baseInfo, tcp_listening: true, tcp_port: 3141 });
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AccessSettings />);
    const save = screen.getByRole("button", { name: "保存访问设置" }) as HTMLButtonElement;
    expect(screen.getByText("24 小时")).toBeTruthy();
    // 默认值不该让页面变成「未保存」
    expect(save.disabled).toBe(true);

    const dec = screen.getByRole("button", { name: "缩短登录有效期" }) as HTMLButtonElement;
    const inc = screen.getByRole("button", { name: "延长登录有效期" }) as HTMLButtonElement;
    fireEvent.click(dec);
    fireEvent.click(dec);
    // 12 是下限：再点不动
    expect(screen.getByText("12 小时")).toBeTruthy();
    expect(dec.disabled).toBe(true);

    fireEvent.click(inc);
    fireEvent.click(inc);
    expect(screen.getByText("36 小时")).toBeTruthy();
    expect(save.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(save);
    });
    const put = fetchMock.mock.calls.find(([url, init]) => url === "/api/settings" && (init as RequestInit)?.method === "PUT");
    expect(put).toBeTruthy();
    const body = JSON.parse(String((put as unknown as [string, RequestInit])[1].body));
    expect(body).toEqual({ tcp_enabled: false, tcp_port: 3141, login_ttl_hours: 36 });
  });

  it("有效期已经到 72 小时时上限按钮不再点得动", () => {
    setStore({ login_ttl_hours: 72 });
    render(<AccessSettings />);
    expect(screen.getByText("72 小时")).toBeTruthy();
    expect((screen.getByRole("button", { name: "延长登录有效期" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("监听失败时把原因显示出来", () => {
    setStore({ tcp_enabled: true }, { tcp_listening: false, tcp_port: 0, tcp_error: "listen tcp :3141: address already in use" });
    render(<AccessSettings />);
    expect(screen.getByText("当前没有在监听 TCP 端口。")).toBeTruthy();
    expect(screen.getByText(/address already in use/)).toBeTruthy();
  });

  it("开启并在监听时显示真实端口", () => {
    setStore({ tcp_enabled: true, tcp_port: 4141 }, { tcp_listening: true, tcp_port: 4141 });
    render(<AccessSettings />);
    expect(screen.getByText("监听中：端口 4141")).toBeTruthy();
  });

  it("端口范围 1025–65535，越界时禁止保存", () => {
    setStore({ tcp_password_set: true });
    render(<AccessSettings />);
    const save = screen.getByRole("button", { name: "保存访问设置" }) as HTMLButtonElement;

    fireEvent.change(screen.getByLabelText("TCP 端口"), { target: { value: "1024" } });
    expect(screen.getByText("端口必须在 1025–65535 之间")).toBeTruthy();
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("TCP 端口"), { target: { value: "65536" } });
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("TCP 端口"), { target: { value: "65535" } });
    expect(screen.queryByText("端口必须在 1025–65535 之间")).toBeNull();
  });

  it("TCP 通道改密码后用新密码重新登录，本地只存会话令牌", async () => {
    setStore(
      { tcp_enabled: true, tcp_password_set: true, tcp_port: 3141 },
      { channel: "tcp", auth_required: true, auth_mode: "password", tcp_listening: true, tcp_port: 3141 },
    );
    localStorage.clear();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/settings" && init?.method === "PUT") {
        return jsonResponse({ ...baseSettings, tcp_enabled: true, tcp_password_set: true, tcp_port: 3141 });
      }
      if (url === "/api/auth/login") return jsonResponse({ token: "sess-token" });
      if (url === "/api/info") {
        return jsonResponse({
          ...baseInfo,
          channel: "tcp",
          auth_required: true,
          auth_mode: "password",
          tcp_listening: true,
          tcp_port: 3141,
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AccessSettings />);
    fireEvent.change(screen.getByLabelText("访问密码"), { target: { value: "n3w-pass-456" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存访问设置" }));
    });

    await waitFor(() => expect(getToken()).toBe("sess-token"));
    const loginCall = fetchMock.mock.calls.find(([url]) => url === "/api/auth/login");
    expect(loginCall).toBeTruthy();
    expect(JSON.parse(String((loginCall as unknown as [string, RequestInit])[1].body))).toEqual({
      password: "n3w-pass-456",
    });
  });

  it("端口冲突时把后端错误就地显示，设置不落盘", async () => {
    setStore({ tcp_password_set: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "TCP 端口无法监听（可能已被其它程序占用）：bind: address already in use" }, 400),
      ),
    );
    render(<AccessSettings />);
    fireEvent.click(screen.getByRole("switch", { name: "启用端口访问" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存访问设置" }));
    });
    expect(await screen.findByText(/可能已被其它程序占用/)).toBeTruthy();
    expect(screen.queryByText("已保存")).toBeNull();
  });
});
