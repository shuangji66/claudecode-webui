import { describe, expect, it } from "vitest";
import type { Item, ThinkingItem, ToolItem } from "./model";
import {
  buildProcessRows,
  hiddenReplyIds,
  dominantCategory,
  groupCategories,
  groupTitle,
  isProcessItem,
  liveDetail,
  reasoningPreview,
  runningTool,
  toolCategory,
} from "./process";

const thinking = (id: string, text = id): ThinkingItem => ({ id, seq: 0, ts: 0, kind: "thinking", text });
const tool = (id: string, name = "Bash", result?: string): ToolItem => ({
  id,
  seq: 0,
  ts: 0,
  kind: "tool",
  toolUseId: id,
  name,
  input: name === "Read" ? { file_path: `/w/${id}.md` } : { command: `cmd ${id}` },
  ...(result !== undefined ? { result } : {}),
});
const reply = (id: string): Item => ({ id, seq: 0, ts: 0, kind: "assistant", text: id, streaming: false });

describe("toolCategory", () => {
  it("按「用户在做什么」归类，未收录的落到 tools", () => {
    expect(toolCategory("Read")).toBe("read");
    expect(toolCategory("Edit")).toBe("edit");
    expect(toolCategory("Bash")).toBe("commands");
    expect(toolCategory("WebSearch")).toBe("webSearch");
    expect(toolCategory("Agent")).toBe("subagents");
    expect(toolCategory("SomeFutureTool")).toBe("tools");
  });
});

describe("isProcessItem", () => {
  it("只有思考与工具是过程", () => {
    expect(isProcessItem(thinking("a"))).toBe(true);
    expect(isProcessItem(tool("b"))).toBe(true);
    expect(isProcessItem(reply("c"))).toBe(false);
  });
});

describe("buildProcessRows", () => {
  it("≥2 条连续过程折成一组", () => {
    const rows = buildProcessRows([tool("a"), thinking("b"), tool("c")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("process");
    if (rows[0].type !== "process") return;
    expect(rows[0].items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("组尾就是列表末尾时算进行中；回答一出现立刻结束", () => {
    const running = buildProcessRows([tool("a"), tool("b")]);
    expect(running[0].type === "process" && running[0].live).toBe(true);

    const answered = buildProcessRows([tool("a"), tool("b"), reply("r")]);
    expect(answered[0].type === "process" && answered[0].live).toBe(false);
  });

  it("单独一步不折组：省掉一次点击", () => {
    const rows = buildProcessRows([reply("r"), tool("a"), reply("r2")]);
    expect(rows.map((r) => r.type)).toEqual(["item", "item", "item"]);
  });

  it("相邻思考合并成一块，单条思考保持原样", () => {
    const rows = buildProcessRows([thinking("a"), thinking("b"), reply("r"), thinking("c")]);
    expect(rows.map((r) => r.type)).toEqual(["thinking", "item", "item"]);
    expect(rows[0].type === "thinking" && rows[0].items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("回答会切开过程组", () => {
    const rows = buildProcessRows([tool("a"), tool("b"), reply("r"), tool("c"), tool("d")]);
    expect(rows.map((r) => r.type)).toEqual(["process", "item", "process"]);
  });

  it("key 取自块内第一条：追加内容不会整块重挂", () => {
    const before = buildProcessRows([tool("a"), tool("b")]);
    const after = buildProcessRows([tool("a"), tool("b"), tool("c")]);
    expect(after[0].key).toBe(before[0].key);
    expect(after[0].start).toBe(0);
  });
});

describe("组头文案", () => {
  it("进行中取「正在跑的那件事」，没有就跑分析", () => {
    expect(groupTitle([thinking("a"), tool("b", "Read")], "running", "zh")).toBe("正在读取文件");
    expect(groupTitle([thinking("a"), tool("b", "Read", "done")], "running", "zh")).toBe("正在分析请求");
    expect(groupTitle([tool("a", "Bash")], "running", "en")).toBe("Running commands");
  });

  it("已结束拼一句人话：两类用「并」，三类用逗号，超过三类加「等」", () => {
    expect(groupTitle([tool("a", "Read", "x"), tool("b", "Bash", "y")], "done", "zh")).toBe("已读取文件并执行了命令");
    expect(
      groupTitle([tool("a", "Read", "x"), tool("b", "Bash", "y"), tool("c", "WebSearch", "z")], "done", "zh"),
    ).toBe("已读取文件，执行了命令，已搜索网页");
    const many = groupTitle(
      [
        tool("a", "Read", "x"),
        tool("b", "Bash", "y"),
        tool("c", "WebSearch", "z"),
        tool("d", "Write", "w"),
      ],
      "done",
      "zh",
    );
    expect(many.endsWith("等")).toBe(true);
    expect(many).not.toContain("已写入文件");
  });

  it("只有思考的组：已结束显示分析", () => {
    expect(groupTitle([thinking("a")], "done", "zh")).toBe("已完成分析");
  });

  it("英文用小写连接，不出现「已」", () => {
    expect(groupTitle([tool("a", "Read", "x"), tool("b", "Bash", "y")], "done", "en")).toBe("Read files and ran commands");
  });

  it("按次数排序，同次数按首次出现的先后", () => {
    const cats = groupCategories([tool("a", "Read"), tool("b", "Bash"), tool("c", "Read")]);
    expect(cats).toEqual([
      { category: "read", count: 2 },
      { category: "commands", count: 1 },
    ]);
    expect(dominantCategory([tool("a", "Bash")])).toBe("commands");
    expect(dominantCategory([thinking("a")])).toBe("analysis");
  });
});

describe("组头详情与推理预览", () => {
  it("推理预览取最近一段思考的首个非空行", () => {
    expect(reasoningPreview([thinking("a", "\n\n第一行\n第二行")])).toBe("第一行");
    expect(reasoningPreview([thinking("a", "旧的"), thinking("b", "新的")])).toBe("新的");
    expect(reasoningPreview([tool("a")])).toBe("");
  });

  it("标准模式的详情优先显示正在跑的工具，其次才是思考", () => {
    expect(liveDetail([thinking("首行"), tool("a", "Read")])).toBe("/w/a.md");
    expect(liveDetail([thinking("首行"), tool("a", "Read", "done")])).toBe("首行");
    expect(runningTool([tool("a", "Read", "done")])).toBeUndefined();
  });
});

describe("hiddenReplyIds（仅最终回答）", () => {
  const user = (id: string): Item => ({ id, seq: 0, ts: 0, kind: "user", text: id });
  const say = (id: string, text = id): Item => ({ id, seq: 0, ts: 0, kind: "assistant", text, streaming: false });

  it("同一轮只留最后一条回答", () => {
    const items = [user("u1"), say("a1"), tool("t1"), say("a2")];
    expect([...hiddenReplyIds(items, false)]).toEqual(["a1"]);
  });

  it("最新一轮仍在展开时一条都不隐藏（过程都没收，回复先消失会像丢消息）", () => {
    const items = [user("u1"), say("a1"), tool("t1"), say("a2")];
    expect(hiddenReplyIds(items, true).size).toBe(0);
  });

  it("每一轮各自只留最后一条", () => {
    const items = [user("u1"), say("a1"), say("a2"), user("u2"), say("b1"), say("b2")];
    expect([...hiddenReplyIds(items, false)].sort()).toEqual(["a1", "b1"]);
  });

  it("没有用户消息（窗口被截断）时整段当一轮", () => {
    const items = [say("a1"), tool("t1"), say("a2")];
    expect([...hiddenReplyIds(items, false)]).toEqual(["a1"]);
  });

  it("空白回答不参与：只有一条有正文时不会被隐藏", () => {
    const items = [user("u1"), say("a0", "   "), say("a1")];
    expect(hiddenReplyIds(items, false).size).toBe(0);
  });

  it("只有一条回答的轮次不动", () => {
    const items = [user("u1"), say("a1")];
    expect(hiddenReplyIds(items, false).size).toBe(0);
  });
});
