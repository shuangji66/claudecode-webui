import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PermissionPanel } from "./PermissionPanel";
import type { PermissionPayload } from "../../transport/types";

function perm(over: Partial<PermissionPayload> = {}): PermissionPayload {
  return {
    request_id: "p1",
    tool_name: "Bash",
    display_name: "Bash",
    description: "危险操作",
    input: { command: "rm -rf /tmp/x" },
    blocked_path: "/tmp/x",
    ...over,
  };
}

describe("PermissionPanel", () => {
  it("展示工具名、命令与阻塞路径", () => {
    render(<PermissionPanel perm={perm()} onReply={() => {}} />);
    expect(screen.getByText(/需要授权：Bash/)).toBeInTheDocument();
    expect(screen.getByText(/路径：\/tmp\/x/)).toBeInTheDocument();
    expect(screen.getByText(/rm -rf \/tmp\/x/)).toBeInTheDocument();
  });

  it("仅此次允许回 allow", () => {
    const onReply = vi.fn();
    render(<PermissionPanel perm={perm()} onReply={onReply} />);
    fireEvent.click(screen.getByText("仅此次允许"));
    expect(onReply).toHaveBeenCalledWith({ allow: true });
  });

  it("拒绝回 allow:false 并带理由", () => {
    const onReply = vi.fn();
    render(<PermissionPanel perm={perm()} onReply={onReply} />);
    fireEvent.click(screen.getByText("拒绝"));
    expect(onReply).toHaveBeenCalledWith({ allow: false, message: "用户拒绝" });
  });

  // 「始终允许」只在后端给出 addRules 建议时出现——没有规则就没法持久化，不能假装能。
  it("没有 addRules 建议时不显示始终允许", () => {
    render(<PermissionPanel perm={perm()} onReply={() => {}} />);
    expect(screen.queryByText(/始终允许/)).toBeNull();
  });

  it("有 addRules 建议时显示始终允许并透传规则", () => {
    const onReply = vi.fn();
    const suggestions = [
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm -rf /tmp/x" }], behavior: "allow", destination: "localSettings" },
    ];
    render(<PermissionPanel perm={perm({ permission_suggestions: suggestions })} onReply={onReply} />);
    const btn = screen.getByText(/始终允许/);
    expect(btn.textContent).toContain("Bash(rm -rf /tmp/x)");
    fireEvent.click(btn);
    expect(onReply).toHaveBeenCalledWith({ allow: true, updatedPermissions: suggestions[0] });
  });

  it("有 setMode 建议且无 addRules 时显示切模式", () => {
    const onReply = vi.fn();
    render(
      <PermissionPanel
        perm={perm({ permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] })}
        onReply={onReply}
      />,
    );
    fireEvent.click(screen.getByText(/切到 acceptEdits 模式/));
    expect(onReply).toHaveBeenCalledWith({
      allow: true,
      updatedPermissions: { type: "setMode", mode: "acceptEdits", destination: "session" },
    });
  });

  it("编辑后运行：改过的 JSON 作为 updatedInput 上报", () => {
    const onReply = vi.fn();
    render(<PermissionPanel perm={perm()} onReply={onReply} />);
    fireEvent.click(screen.getByText("编辑后运行"));
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{"command":"rm -rf ./build"}' } });
    fireEvent.click(screen.getByText("执行修改后的输入"));
    expect(onReply).toHaveBeenCalledWith({ allow: true, updatedInput: { command: "rm -rf ./build" } });
  });

  it("编辑后运行：非法 JSON 不提交并提示", () => {
    const onReply = vi.fn();
    render(<PermissionPanel perm={perm()} onReply={onReply} />);
    fireEvent.click(screen.getByText("编辑后运行"));
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "{oops" } });
    fireEvent.click(screen.getByText("执行修改后的输入"));
    expect(onReply).not.toHaveBeenCalled();
    expect(screen.getByText(/JSON/)).toBeInTheDocument();
  });
});
