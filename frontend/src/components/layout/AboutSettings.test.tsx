import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AboutSettings } from "./SettingsDrawer";
import { useAppStore } from "../../store/useAppStore";

describe("AboutSettings", () => {
  beforeEach(() => {
    useAppStore.setState({ info: { version: "1.2.3" } as never });
  });

  it("一句话介绍特性并显示版本", () => {
    render(<AboutSettings />);
    expect(screen.getByText("Claude Code WebUI")).toBeInTheDocument();
    expect(screen.getByText("v1.2.3")).toBeInTheDocument();
    expect(screen.getByText(/可视化 Web 控制台/)).toBeInTheDocument();
  });

  it("致谢 DeepSeek / DeepSeekRuntime / dsh-better-sidebar", () => {
    render(<AboutSettings />);
    expect(screen.getByText("DeepSeek")).toBeInTheDocument();
    expect(screen.getByText("DeepSeekRuntime（DSH）")).toBeInTheDocument();
    expect(screen.getByText("dsh-better-sidebar")).toBeInTheDocument();
  });

  it("GitHub 链接指向仓库，新窗口打开且带 noreferrer", () => {
    render(<AboutSettings />);
    const link = screen.getByRole("link", { name: /shuangji66\/claudecode-webui/ });
    expect(link).toHaveAttribute("href", "https://github.com/shuangji66/claudecode-webui");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });
});
