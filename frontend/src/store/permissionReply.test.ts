import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./useAppStore";

const perm = {
  request_id: "p1",
  tool_name: "Bash",
  display_name: "Bash",
  description: "rm -rf /tmp/x",
  input: { command: "rm -rf /tmp/x" },
};

const perm2 = {
  request_id: "p2",
  tool_name: "Bash",
  display_name: "Bash",
  description: "claude mcp list",
  input: { command: "claude mcp list" },
};

describe("审批链路", () => {
  beforeEach(() => {
    useAppStore.setState({ activeId: "s1", perms: {}, inits: {}, states: {}, conns: {}, error: null });
  });

  it("连接不可用时保留审批卡片，而不是假装已批准", () => {
    // 没有对应的 client = socket 不在 OPEN（自动重连中）。
    useAppStore.setState({ perms: { s1: [perm] } });
    useAppStore.getState().replyPermission(perm, true);

    const s = useAppStore.getState();
    expect(s.perms.s1).toHaveLength(1);
    expect(s.error).toContain("连接已断开");
  });

  it("会话关闭后清空挂起审批", () => {
    useAppStore.setState({ perms: { s1: [perm] } });
    useAppStore.getState().applyEvent("s1", { kind: "closed", data: { id: "s1" } });
    expect(useAppStore.getState().perms.s1).toEqual([]);
  });

  it("重连快照重放挂起审批，并按 request_id 去重", () => {
    useAppStore.getState().applyEvent("s1", {
      kind: "session.snapshot",
      data: { info: { state: "busy" }, permissions: [perm] },
    });
    expect(useAppStore.getState().perms.s1).toHaveLength(1);

    // 快照之后再收到同一条实时事件，不能出现两张一样的卡片。
    useAppStore.getState().applyEvent("s1", { kind: "permission", data: perm });
    expect(useAppStore.getState().perms.s1).toHaveLength(1);
  });

  it("别的设备处理掉审批后，本机卡片跟着消失（且只删这一条）", () => {
    useAppStore.setState({ perms: { s1: [perm, perm2] } });
    useAppStore.getState().applyEvent("s1", { kind: "permission.resolved", data: { request_id: "p1" } });
    expect(useAppStore.getState().perms.s1).toEqual([perm2]);

    // 同一条结论重复到达（重连快照 + 广播）不能报错或误删。
    useAppStore.getState().applyEvent("s1", { kind: "permission.resolved", data: { request_id: "p1" } });
    expect(useAppStore.getState().perms.s1).toEqual([perm2]);
  });

  it("没有 request_id 的结论事件不误删任何卡片", () => {
    useAppStore.setState({ perms: { s1: [perm] } });
    useAppStore.getState().applyEvent("s1", { kind: "permission.resolved", data: {} });
    expect(useAppStore.getState().perms.s1).toEqual([perm]);
  });
});
