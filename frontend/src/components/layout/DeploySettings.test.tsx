import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DeploySettings } from "./DeploySettings";
import { ClaudeInstallPrompt } from "./ClaudeInstallPrompt";
import { useAppStore } from "../../store/useAppStore";
import type { ClaudeStatus } from "../../transport/types";

const loadClaudeStatus = vi.fn();
const checkClaudeUpdate = vi.fn();
const installClaude = vi.fn();
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
  setClaudeActive.mockReset().mockResolvedValue(true);
  setClaudeSource.mockReset().mockResolvedValue(true);
  useAppStore.setState({
    claude: STATUS,
    claudeError: null,
    loadClaudeStatus,
    checkClaudeUpdate,
    installClaude,
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
