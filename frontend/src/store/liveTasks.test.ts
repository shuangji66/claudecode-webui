import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./useAppStore";
import type { LiveTask } from "../transport/types";

/**
 * 后台任务的 task_id 只出现在实时的 task_started 里，转录回放里没有。
 * 后端随 session.snapshot 下发一份「还没结束的后台任务」，前端据此把
 * 中途接入的设备也补上可中止的目标（见 lib/backgroundTasks）。
 */
const tasks: LiveTask[] = [
  { task_id: "task-1", tool_use_id: "tu1", description: "npm test", task_type: "local_bash" },
];

describe("session.snapshot 的后台任务表", () => {
  beforeEach(() => {
    useAppStore.setState({ activeId: "s1", liveTasks: {}, states: {}, inits: {}, perms: {}, conns: {} });
  });

  it("把快照里的 tasks 存进 liveTasks", () => {
    useAppStore.getState().applyEvent("s1", { kind: "session.snapshot", data: { tasks } });
    expect(useAppStore.getState().liveTasks.s1).toEqual(tasks);
  });

  // 空数组代表「确实一个都没在跑」，必须覆盖旧值：留着的话中止入口会指向
  // 早就不存在的任务。
  it("空数组也覆盖旧值", () => {
    useAppStore.setState({ liveTasks: { s1: tasks } });
    useAppStore.getState().applyEvent("s1", { kind: "session.snapshot", data: { tasks: [] } });
    expect(useAppStore.getState().liveTasks.s1).toEqual([]);
  });

  it("快照里没有 tasks 字段时按空处理（老后端）", () => {
    useAppStore.setState({ liveTasks: { s1: tasks } });
    useAppStore.getState().applyEvent("s1", { kind: "session.snapshot", data: { info: { state: "ready" } } });
    expect(useAppStore.getState().liveTasks.s1).toEqual([]);
  });
});
