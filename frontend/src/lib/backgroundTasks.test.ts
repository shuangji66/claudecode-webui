import { describe, expect, it } from "vitest";
import { backgroundTasks, isSubagentTask, subagentsOnly } from "./backgroundTasks";
import type { Item, ToolItem } from "./model";
import type { LiveTask } from "../transport/types";

function tool(over: Partial<ToolItem>): ToolItem {
  return { id: "i1", seq: 0, ts: 0, kind: "tool", toolUseId: "tu1", name: "Bash", input: {}, ...over };
}

/** 后台命令：local_bash，还在跑。 */
const bgBash = tool({
  id: "i1",
  toolUseId: "tu_bash",
  subagent: {
    taskId: "task-bash",
    taskType: "local_bash",
    description: "npm test",
    status: "running",
  },
});
/** 子代理：local_agent，还在跑。 */
const subagent = tool({
  id: "i2",
  toolUseId: "tu_agent",
  name: "Agent",
  subagent: {
    taskId: "task-agent",
    taskType: "local_agent",
    description: "先读代码",
    type: "Explore",
    status: "running",
  },
});
/** 已经跑完的后台命令：不该留在面板里。 */
const doneBash = tool({
  id: "i3",
  toolUseId: "tu_done",
  subagent: { taskId: "task-done", taskType: "local_bash", description: "npm run build", status: "completed" },
});

describe("isSubagentTask", () => {
  it("local_agent 是子代理，其余是后台操作", () => {
    expect(isSubagentTask("local_agent")).toBe(true);
    expect(isSubagentTask("local_bash")).toBe(false);
    expect(isSubagentTask("mcp_task")).toBe(false);
  });

  // 老版本 CLI 与转录回放都给不出 task_type：宁可多列在子智能体里，
  // 也不要把子代理错当成后台命令（那会连「查看对话」的入口一起丢掉）。
  it("缺 task_type 时按子代理处理", () => {
    expect(isSubagentTask(undefined)).toBe(true);
    expect(isSubagentTask("")).toBe(true);
  });
});

describe("backgroundTasks", () => {
  it("只列非子代理、且还在跑的任务", () => {
    const items: Item[] = [bgBash, subagent, doneBash];
    const got = backgroundTasks(items);
    expect(got.map((e) => e.taskId)).toEqual(["task-bash"]);
    expect(got[0]).toMatchObject({ label: "npm test", toolName: "Bash", toolUseId: "tu_bash" });
  });

  it("子代理不进这个列表（它归页头的「子智能体」）", () => {
    expect(backgroundTasks([subagent])).toEqual([]);
  });

  it("全部跑完后列表为空（入口图标据此自动隐藏）", () => {
    expect(backgroundTasks([doneBash])).toEqual([]);
  });

  // 中途接入的设备只有转录回放，拿不到 task_started，卡片上也就没有 taskId。
  // 后端那份 liveTasks 要按 tool_use_id 把 task_id 补回来，否则中止按钮没有目标。
  it("用后端下发的 liveTasks 按 tool_use_id 补 task_id 与描述", () => {
    const replay = tool({
      id: "i9",
      toolUseId: "tu_replay",
      name: "Bash",
      input: { command: "npm test", run_in_background: true },
      subagent: { taskId: "", status: "running" },
    });
    const live: LiveTask[] = [
      { task_id: "task-live", tool_use_id: "tu_replay", description: "npm test", task_type: "local_bash" },
    ];
    const got = backgroundTasks([replay], live);
    expect(got).toHaveLength(1);
    expect(got[0].taskId).toBe("task-live");
    expect(got[0].label).toBe("npm test");
  });

  it("两边都给不出 task_id 时不编（界面据此不给中止按钮）", () => {
    const replay = tool({
      id: "i9",
      toolUseId: "tu_replay",
      // taskType 已知是后台命令、但 task_id 两边都查不到。
      subagent: { taskId: "", taskType: "local_bash", status: "running" },
    });
    const got = backgroundTasks([replay], []);
    expect(got).toHaveLength(1);
    expect(got[0].taskId).toBe("");
  });

  it("ambient 任务不出现在活动指示里", () => {
    const replay = tool({
      id: "i9",
      toolUseId: "tu_watch",
      subagent: { taskId: "", status: "running" },
    });
    // 唯一的线索是后端表里那条 ambient 记录；它被丢掉后这个条目既补不出
    // task_id、也补不出 task_type，按「缺 taskType 当子代理」处理 —— 不出现在这里。
    const live: LiveTask[] = [{ task_id: "task-watch", tool_use_id: "tu_watch", ambient: true, task_type: "local_bash" }];
    expect(backgroundTasks([replay], live)).toEqual([]);
  });

  // 实时路径上卡片自己就带 taskId（`task_started` 写进去的），所以不能只靠
  // 「live 里查不到 → 当成子代理」来挡 ambient：必须按 task_id 也建索引，并在出
  // 列表时再挡一次。否则观察者类任务会出现在页头的「后台操作」里。
  it("卡片自带 taskId 时，ambient 仍然不列", () => {
    const live = tool({
      id: "i9",
      toolUseId: "tu_watch",
      subagent: { taskId: "task-watch", taskType: "local_bash", status: "running" },
    });
    const table: LiveTask[] = [{ task_id: "task-watch", tool_use_id: "tu_watch", ambient: true }];
    expect(backgroundTasks([live], table)).toEqual([]);
  });

  it("live 里没有 tool_use_id 时也能按 task_id 补描述", () => {
    const live = tool({
      id: "i9",
      toolUseId: "tu_bg",
      subagent: { taskId: "task-bg", taskType: "local_bash", status: "running" },
    });
    const table: LiveTask[] = [{ task_id: "task-bg", description: "跑测试" }];
    expect(backgroundTasks([live], table)[0].label).toBe("跑测试");
  });
});

describe("subagentsOnly", () => {
  it("从子代理条目里剔掉后台命令", () => {
    const got = subagentsOnly([bgBash, subagent, doneBash]);
    expect(got.map((e) => e.agentId)).toEqual(["task-agent"]);
  });
});
