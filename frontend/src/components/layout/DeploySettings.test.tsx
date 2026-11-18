import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../common/SystemDialogs", () => ({ askConfirm: vi.fn().mockResolvedValue(true) }));
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { askConfirm } from "../common/SystemDialogs";
import { DeploySettings } from "./DeploySettings";
import { ClaudeInstallPrompt } from "./ClaudeInstallPrompt";
import { useAppStore } from "../../store/useAppStore";
import type { ClaudeStatus } from "../../transport/types";

const loadClaudeStatus = vi.fn();
const checkClaudeUpdate = vi.fn();
const installClaude = vi.fn();
const cancelClaudeInstall = vi.fn();
const deleteClaudeVersion = vi.fn();
const setClaudeActive = vi.fn();
const setClaudeSource = vi.fn();

const STATUS: ClaudeStatus = {
  platform: "linux-x64",
  dir: "/data/claude/versions",
  installed: [
    { version: "2.1.325", path: "/data/claude/versions/2.1.325/claude", size: 365842960, installed_at: "2026-11-16T10:00:00Z" },
    { version: "2.1.311", path: "/data/claude/versions/2.1.311/claude", size: 293776752, installed_at: "2026-11-10T10:00:00Z" },
  ],
  active: "2.1.325",
  source: "npmmirror",
  latest: "2.1.325",
  update_available: false,
  job: null,
};

beforeEach(() => {
  loadClaudeStatus.mockReset().mockResolvedValue(undefined);
  checkClaudeUpdate.mockReset();
  installClaude.mockReset().mockResolvedValue(true);
  cancelClaudeInstall.mockReset().mockResolvedValue(true);
  deleteClaudeVersion.mockReset().mockResolvedValue(true);
  setClaudeActive.mockReset().mockResolvedValue(true);
  setClaudeSource.mockReset().mockResolvedValue(true);
  useAppStore.setState({
    claude: STATUS,
    claudeError: null,
    loadClaudeStatus,
    checkClaudeUpdate,
    installClaude,
    cancelClaudeInstall,
    deleteClaudeVersion,
    setClaudeActive,
    setClaudeSource,
  });
});

describe("DeploySettings", () => {
  it("列出已安装版本并标出使用中的那个", () => {
    render(<DeploySettings />);
    expect(screen.getByText("2.1.325")).toBeTruthy();
    expect(screen.getByText("2.1.311")).toBeTruthy();
    expect(screen.getByText("使用中")).toBeTruthy();
    // 生效版本那一行不能再给「切换到此版本」。
    const switches = screen.getAllByRole("button", { name: "切换到此版本" });
    expect(switches).toHaveLength(1);
  });

  it("切换版本调用 store", async () => {
    render(<DeploySettings />);
    fireEvent.click(screen.getByRole("button", { name: "切换到此版本" }));
    await waitFor(() => expect(setClaudeActive).toHaveBeenCalledWith("2.1.311"));
  });

  it("未安装时给出醒目提示", () => {
    useAppStore.setState({ claude: { ...STATUS, installed: [], active: "", latest: "" } });
    render(<DeploySettings />);
    expect(screen.getByText(/尚未安装任何版本/)).toBeTruthy();
  });

  it("下载源包含腾讯云与华为云镜像", () => {
    render(<DeploySettings />);
    fireEvent.click(screen.getByRole("button", { name: "下载源" }));
    expect(screen.getByRole("option", { name: /腾讯云镜像/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /华为云镜像/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /官方 npm registry/ })).toBeTruthy();
  });

  it("已安装未使用的版本可删除，生效版本没有删除按钮", async () => {
    render(<DeploySettings />);
    expect(screen.queryByRole("button", { name: "删除版本 2.1.325" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "删除版本 2.1.311" }));
    await waitFor(() => expect(deleteClaudeVersion).toHaveBeenCalledWith("2.1.311"));
  });

  // 删除会先结束正在使用该版本的会话，确认框必须把这件事说清楚。
  it("删除仍被会话使用的旧版本时提示会先结束对话", async () => {
    useAppStore.setState({
      claude: {
        ...STATUS,
        installed: [
          { version: "2.1.325", path: "/data/claude/versions/2.1.325/claude", size: 1, installed_at: "", in_use: 1 },
          { version: "2.1.311", path: "/data/claude/versions/2.1.311/claude", size: 1, installed_at: "", in_use: 2 },
        ],
      },
    });
    render(<DeploySettings />);
    expect(screen.getByText("2 个对话使用中")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除版本 2.1.311" }));
    await waitFor(() => expect(deleteClaudeVersion).toHaveBeenCalledWith("2.1.311"));
    const opts = vi.mocked(askConfirm).mock.calls[0][0];
    expect(opts.message).toContain("2 个对话正在使用该版本");
    expect(opts.message).toContain("先被结束");
  });

  it("删除没有会话在用的旧版本时不说会打断对话", async () => {
    render(<DeploySettings />);
    fireEvent.click(screen.getByRole("button", { name: "删除版本 2.1.311" }));
    await waitFor(() => expect(deleteClaudeVersion).toHaveBeenCalledWith("2.1.311"));
    const opts = vi.mocked(askConfirm).mock.calls[0][0];
    expect(opts.message).toContain("该版本目录会被移除");
    expect(opts.message).not.toContain("先被结束");
  });

  it("安装中可取消", async () => {
    useAppStore.setState({
      claude: {
        ...STATUS,
        job: {
          version: "2.1.330",
          source: "npmmirror",
          phase: "downloading",
          downloaded: 12,
          total: 100,
          started_at: "2026-11-16T10:00:00Z",
        },
      },
    });
    render(<DeploySettings />);
    fireEvent.click(screen.getByRole("button", { name: /取消安装/ }));
    await waitFor(() => expect(cancelClaudeInstall).toHaveBeenCalled());
  });

  it("展示安装进度与失败原因", () => {
    useAppStore.setState({
      claude: {
        ...STATUS,
        job: {
          version: "2.1.330",
          source: "npmmirror",
          phase: "error",
          downloaded: 12,
          total: 100,
          error: "完整性校验失败",
          started_at: "2026-11-16T10:00:00Z",
        },
      },
    });
    render(<DeploySettings />);
    expect(screen.getByText("安装失败")).toBeTruthy();
    expect(screen.getByText("完整性校验失败")).toBeTruthy();
  });
});

describe("ClaudeInstallPrompt", () => {
  it("「去安装」把人送到部署页", () => {
    const onGoDeploy = vi.fn();
    const onClose = vi.fn();
    render(<ClaudeInstallPrompt open onClose={onClose} onGoDeploy={onGoDeploy} />);
    fireEvent.click(screen.getByRole("button", { name: "去安装" }));
    expect(onGoDeploy).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("关闭时不跳转", () => {
    const onGoDeploy = vi.fn();
    const onClose = vi.fn();
    render(<ClaudeInstallPrompt open onClose={onClose} onGoDeploy={onGoDeploy} />);
    fireEvent.click(screen.getByRole("button", { name: "稍后" }));
    expect(onClose).toHaveBeenCalled();
    expect(onGoDeploy).not.toHaveBeenCalled();
  });
});
