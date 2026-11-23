import { describe, expect, it } from "vitest";
import type { Item, ThinkingItem, ToolItem } from "./model";
import {
  buildProcessRows,
  hiddenReplyIds,
  dominantCategory,
  groupCategories,
  groupTitle,
  isProcessItem,
  reasoningPreview,
  runningTool,
  replyCopy,
  replyDividerIds,
  toolCategory,
  turnSpans,
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

  // 提问要两层都画：过程里留一步「提问 · 已回答」（点开看完整选项），正文流里再挂
  // 一枚问答气泡。气泡是 MessageList 另外从同一个 Item 派生的，不能靠把这条判成
  // 「不是过程」来实现——那样步骤就跟着没了。
  it("已作答的提问仍然是过程（步骤要留在过程里）", () => {
    const ask: ToolItem = {
      ...tool("ask", "AskUserQuestion"),
      input: { questions: [{ question: "Q", options: [{ label: "A" }] }] },
    };
    const answered = 'Your questions have been answered: "Q"="A". You can now continue with these answers in mind.';
    expect(isProcessItem({ ...ask, result: answered })).toBe(true);
    expect(isProcessItem(ask)).toBe(true);
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

  it("只有含工具的连续过程才成组：纯思考另有合并行", () => {
    const rows = buildProcessRows([thinking("a"), thinking("b")]);
    expect(rows.map((r) => r.type)).toEqual(["thinking"]);
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

  it("正在跑的工具只认还没拿到结果的那条", () => {
    expect(runningTool([tool("a", "Read")])?.name).toBe("Read");
    expect(runningTool([tool("a", "Read", "done")])).toBeUndefined();
  });

  // 一轮被中断时它的工具永远等不到 tool_result，`result` 一直是 undefined。
  // 不按回合划边界的话，从那一刻起每一轮都会被判成「有工具在跑」——组头一直
  // 显示那个早就不回来的命令，ChatPane 的沉默提示（runningTool 决定要不要看）
  // 也永久失效。
  it("上一轮遗留的未完成工具不算「正在跑」", () => {
    const stale: Item[] = [
      { id: "u1", seq: 0, ts: 1, kind: "user", text: "跑个长命令" },
      tool("t1", "Bash"),
      { id: "r1", seq: 2, ts: 3, kind: "result", isError: true, subtype: "interrupt" },
    ];
    expect(runningTool(stale)).toBeUndefined();

    // 同一轮的下一轮里真有工具在跑时照样认得出。
    const fresh: Item[] = [
      ...stale,
      { id: "u2", seq: 3, ts: 4, kind: "user", text: "下一轮" },
      tool("t2", "Read"),
    ];
    expect(runningTool(fresh)?.toolUseId).toBe("t2");
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

// 收起是**轮级**的（对齐 DSH）：整轮的过程一起收进轮首一行，正文照常留着。
describe("turnSpans", () => {
  const user2 = (id: string): Item => ({ id, seq: 0, ts: 0, kind: "user", text: id });
  const result2 = (id: string, ms?: number): Item => ({ id, seq: 0, ts: 0, kind: "result", durationMs: ms });

  it("按用户消息切轮，并捞出每轮的过程条目", () => {
    const spans = turnSpans([user2("u1"), thinking("t1"), tool("x1"), result2("r1"), user2("u2"), tool("x2")]);
    expect(spans).toHaveLength(2);
    expect(spans[0].process.map((i) => i.id)).toEqual(["t1", "x1"]);
    expect(spans[1].process.map((i) => i.id)).toEqual(["x2"]);
  });

  it("正文与用户消息不算过程：收起只藏过程，留下的正是这些", () => {
    const spans = turnSpans([user2("u1"), thinking("t1"), reply("a1"), result2("r1")]);
    expect(spans[0].process.map((i) => i.id)).toEqual(["t1"]);
  });

  it("本轮有 result 才算结束；会话空闲时历史轮次（回放没有 result）也算结束", () => {
    expect(turnSpans([user2("u1"), tool("x1")], true)[0].finished).toBe(false);
    expect(turnSpans([user2("u1"), tool("x1")], false)[0].finished).toBe(true);
    expect(turnSpans([user2("u1"), tool("x1"), result2("r1")], true)[0].finished).toBe(true);
  });

  it("带上本轮耗时（没有 result 时按时间戳推，连时间戳都没有才是 undefined）", () => {
    expect(turnSpans([user2("u1"), result2("r1", 9000)], true)[0].durationMs).toBe(9000);
    expect(turnSpans([user2("u1")], false)[0].durationMs).toBeUndefined();
  });

  // 「结束」不等于「做完了」：用户按停止、上游报错、进程被结束都会让这一轮收尾。
  // 收起行按 outcome 分文案（见 TurnCollapse），不分的话被打断的一轮会写着
  // 「已完成，用时 19 分 52 秒」——那是在告诉用户「这活干完了」。
  describe("outcome：这一轮是怎么结束的", () => {
    const stop = (id: string): Item => ({ id, seq: 0, ts: 0, kind: "result", subtype: "interrupt", isError: false });
    const fail = (id: string): Item => ({ id, seq: 0, ts: 0, kind: "result", isError: true, subtype: "error_during_execution" });

    it("正常收尾是 ok", () => {
      expect(turnSpans([user2("u1"), tool("x1"), result2("r1", 1000)], true)[0].outcome).toBe("ok");
    });

    it("中断标记（subtype 带 interrupt）是 stopped，哪怕归一化之后 isError 是 false", () => {
      expect(turnSpans([user2("u1"), tool("x1"), stop("r1")], true)[0].outcome).toBe("stopped");
    });

    it("真报错（isError）是 failed", () => {
      expect(turnSpans([user2("u1"), tool("x1"), fail("r1")], true)[0].outcome).toBe("failed");
    });

    // 一段里可能有多条 result（插话把一轮拆成几个子回合）：决定结局的是**最后**那条。
    it("多条 result 时以最后一条为准", () => {
      const spans = turnSpans([user2("u1"), tool("x1"), stop("r1"), reply("a1"), result2("r2", 500)], true);
      expect(spans[0].outcome).toBe("ok");
    });

    // null 一走的 result 不算收尾（见 handoffResult）：那时这一轮还在跑，不该有结局。
    it("还没结束的轮报 ok（调用方本来也不用它）", () => {
      expect(turnSpans([user2("u1"), tool("x1")], true)[0].outcome).toBe("ok");
    });
  });

  // 转录回放没有 result 行（claude 只把 result 写 stdout），以前「重进前端，已完成右边
  // 的用时」全没了。回放的条目带着转录里的时间戳，按这一轮首尾两条活动条目自己算。
  describe("回放没有 result 时按时间戳推耗时", () => {
    const at = (id: string, kind: Item["kind"], ts: number, extra: Partial<Item> = {}): Item =>
      ({ id, seq: 0, ts, kind, ...extra }) as Item;

    it("从用户消息到这一轮最后一条活动（工具/思考都算）", () => {
      const items = [
        at("u1", "user", 1_000, { text: "问题" }),
        at("t1", "thinking", 5_000, { text: "想想" }),
        at("x1", "tool", 12_000, { name: "Bash", toolUseId: "tu1", input: {}, result: "ok" }),
        at("a1", "assistant", 20_000, { text: "答案" }),
      ];
      expect(turnSpans(items, false)[0].durationMs).toBe(19_000);
    });

    it("有 result 时用 CLI 的口径，不再按时间戳另算一份", () => {
      const items = [
        at("u1", "user", 1_000, { text: "问题" }),
        at("a1", "assistant", 20_000, { text: "答案" }),
        at("r1", "result", 21_000, { durationMs: 9_000 }),
      ];
      expect(turnSpans(items, false)[0].durationMs).toBe(9_000);
    });

    // 同一条消息会被拆成多行，时间戳撞在一起就是 0；报「用时 0 秒」看着像 bug。
    it("首尾时间戳不足 1 秒不给数字", () => {
      const items = [at("u1", "user", 1_000, { text: "问题" }), at("a1", "assistant", 1_000, { text: "嗯" })];
      expect(turnSpans(items, false)[0].durationMs).toBeUndefined();
    });

    it("还在跑的那一轮不算：那是「此刻说到哪」，不是耗时", () => {
      const items = [at("u1", "user", 1_000, { text: "问题" }), at("a1", "assistant", 20_000, { text: "半句" })];
      expect(turnSpans(items, true)[0].finished).toBe(false);
      expect(turnSpans(items, true)[0].durationMs).toBeUndefined();
    });

    // 截断时回放会在最前面垫一条系统提示，它的时间戳是「现在」——拿它当起点会算出
    // 一个几小时的耗时。只有「有内容」的条目（用户 / 回答 / 思考 / 工具）才是边界。
    it("回放被截断时前面垫的系统提示不参与（它的时间戳是「现在」）", () => {
      const items = [
        at("s1", "system", Date.now(), { text: "更早的消息已被省略（只保留最近一段转录）" }),
        at("u1", "user", 1_000, { text: "问题" }),
        at("a1", "assistant", 61_000, { text: "答案" }),
      ];
      const spans = turnSpans(items, false);
      // 那条系统提示自己占一段（用户消息才是轮首），它没有耗时。
      expect(spans[0].durationMs).toBeUndefined();
      expect(spans[1].durationMs).toBe(60_000);
    });
  });

  // 会话正在跑最新一轮时，前面的轮次**必然已经结束**（后面已经开了新一轮，否则它们
  // 到不了这里）。按「会话在不在跑」一刀切会把整段历史的思考与工具全摊开。
  it("只有最后一轮才可能还在跑：历史轮次永远算结束", () => {
    const spans = turnSpans([user2("u1"), thinking("t1"), user2("u2"), tool("x2")], true);
    expect(spans.map((s) => s.finished)).toEqual([true, false]);
  });

  it("最后一轮里有 result 也算结束（会话还没切到空闲的那一瞬）", () => {
    const spans = turnSpans([user2("u1"), thinking("t1"), user2("u2"), tool("x2"), result2("r2")], true);
    expect(spans.map((s) => s.finished)).toEqual([true, true]);
  });

  it("列表开头没有用户消息时也算一轮，否则那段过程无处可收", () => {
    const spans = turnSpans([tool("x1"), reply("a1"), user2("u2"), tool("x2")], false);
    expect(spans.map((s) => s.start)).toEqual([0, 2]);
    expect(spans[0].process.map((i) => i.id)).toEqual(["x1"]);
  });

  // 插话没赶上当前回合时 CLI 先 result 收尾、再开一轮跑插话——那条 result 是交棒，
  // 尾轮不该据此判成「已完成」（收起行会先闪一下再被推翻）。但**后面已经开了新的
  // 一轮**（!isTail）就说明这一段确实收尾了：再判「还在跑」会让它的过程永远摊着。
  it("交棒 result 只在尾轮才推迟「结束」，非尾轮照常算结束", () => {
    const handoff = (next: Item[]): Item[] => [
      user2("u1"),
      tool("x1"),
      reply("a1"),
      result2("r1"),
      { id: "u2", seq: 0, ts: 0, kind: "user", text: "插话", interjected: true } as Item,
      result2("r2"),
      ...next,
    ];
    // 尾轮：交棒，还不算结束。
    expect(turnSpans(handoff([]), true)[0].finished).toBe(false);
    // 后面又发了一句（新的一轮）：前一段确实结束了。
    expect(turnSpans(handoff([user2("u3"), tool("x3")]), true).map((s) => s.finished)).toEqual([true, false]);
  });
});

// 复制入口只给最终回答，但复制的是**整轮的正文输出**：一轮里模型会写好几段过渡正文，
// 它们各自挂一个复制按钮是噪音，而收起态下那些过渡正文又多半看不见。
describe("replyCopy", () => {
  const say = (id: string, text = id): Item => ({ id, seq: 0, ts: 0, kind: "assistant", text, streaming: false });

  it("只有最后一条回答给复制入口", () => {
    const turn = [thinking("t1"), say("a1", "先看目录"), tool("x1"), say("a2", "改好了")];
    expect(replyCopy(turn, "a1")).toBeUndefined();
    expect(replyCopy(turn, "a2")).toBe("先看目录\n\n改好了");
  });

  it("复制内容按顺序拼起整轮正文，思考过程不进", () => {
    const turn = [thinking("t1", "不该被复制"), say("a1", "第一段"), tool("x1"), say("a2", "第二段")];
    expect(replyCopy(turn, "a2")).toBe("第一段\n\n第二段");
  });

  it("空正文与 CLI 包的 API 错误不算正文", () => {
    const apiError: Item = { id: "e1", seq: 0, ts: 0, kind: "assistant", text: "API Error: 400", streaming: false, apiError: true };
    const turn = [say("a1", "   "), apiError, say("a2", "真正的答案")];
    expect(replyCopy(turn, "a2")).toBe("真正的答案");
    expect(replyCopy(turn, "e1")).toBeUndefined();
  });

  it("这一轮没结束就一个都不给：跑到一半的最后一条只是半句话", () => {
    const turn = [thinking("t1"), say("a1", "正在改"), tool("x1")];
    expect(replyCopy(turn, "a1", false)).toBeUndefined();
    // 同一份内容，轮次结束后就有了。
    expect(replyCopy(turn, "a1", true)).toBe("正在改");
  });

  it("不是回答的条目一律不给", () => {
    const turn = [thinking("t1"), say("a1", "答案")];
    expect(replyCopy(turn, "t1")).toBeUndefined();
  });
});

// 插话（priority=now）是往正在跑的这一轮里补一句，**不切轮**。按它切的话，一句话就把
// 这一轮的思考与工具调用劈成两半：前半截被当成「已完成」收起来（还冒出复制按钮），
// 后半截被当成新一轮重新铺开。
describe("插话不切轮", () => {
  const user = (id: string, interjected = false): Item => ({
    id,
    seq: 0,
    ts: 0,
    kind: "user",
    text: id,
    ...(interjected ? { interjected: true } : {}),
  });
  const result = (id: string, ms?: number): Item => ({ id, seq: 0, ts: 0, kind: "result", durationMs: ms });

  it("插话留在当前这一轮里", () => {
    const spans = turnSpans([user("u1"), thinking("t1"), tool("x1"), user("i1", true), tool("x2")], true);
    expect(spans).toHaveLength(1);
    expect(spans[0].process.map((i) => i.id)).toEqual(["t1", "x1", "x2"]);
  });

  it("一轮还没跑完：插话之后仍是「进行中」，不给复制也不收起来", () => {
    const turn = [user("u1"), thinking("t1"), reply("a1"), user("i1", true), tool("x2")];
    const spans = turnSpans(turn, true);
    expect(spans).toHaveLength(1);
    expect(spans[0].finished).toBe(false);
    // 这一轮还没结束：一条复制入口都不给。
    expect(replyCopy(turn, "a1", spans[0].finished)).toBeUndefined();
  });

  it("真正的下一条用户消息仍然切轮", () => {
    const spans = turnSpans([user("u1"), tool("x1"), user("u2"), tool("x2")], true);
    expect(spans).toHaveLength(2);
  });

  it("插话之后整轮结束，过程照常收进同一行", () => {
    const spans = turnSpans([user("u1"), thinking("t1"), user("i1", true), tool("x2"), result("r1", 9000)], true);
    expect(spans).toHaveLength(1);
    expect(spans[0].finished).toBe(true);
    expect(spans[0].durationMs).toBe(9000);
  });

  // 实测（2.1.328）：插话没赶上当前回合时，CLI 先把这一轮收尾（发 result）、再发一条
  // system/init 开新一轮把插话跑完。消息流因此是 `... result → 插话 → 新的思考 → 新 result`。
  // 只判「本段里有 result」就会把插话之后的思考与工具一起收进「已完成」那一行——用户
  // 看到的就是「插了一句，后面的过程突然折起来了」。
  it("插话落在 result 之后：这一轮没结束，后半段过程仍然铺开", () => {
    const turn = [user("u1"), thinking("t1"), result("r1", 9000), user("i1", true), thinking("t2"), tool("x2")];
    const spans = turnSpans(turn, true);
    expect(spans).toHaveLength(1);
    expect(spans[0].finished).toBe(false);
    // 还是不给复制：这一轮的下半截正在写。
    expect(replyCopy(turn, "t1", spans[0].finished)).toBeUndefined();
  });

  it("插话之后 CLI 又跑完一轮：整轮才算结束，耗时把两段加起来", () => {
    const spans = turnSpans(
      [user("u1"), thinking("t1"), result("r1", 9000), user("i1", true), thinking("t2"), result("r2", 4000)],
      true,
    );
    expect(spans).toHaveLength(1);
    expect(spans[0].finished).toBe(true);
    expect(spans[0].durationMs).toBe(13000);
  });

  // 实测（2.1.328）的**真实顺序**：本地气泡先落地，CLI 交棒时补发的 result 随后到，
  // 新一轮的思考再晚一帧。那一瞬间 result 确实是段里最后一条内容，判据立刻成立——
  // 界面上收起行闪一下「已完成」、约 1 秒后又被新一轮的内容推翻（截图复现过）。
  it("插话之后紧跟的 result 是交棒，不该让整轮闪一下「已完成」", () => {
    const turn = [user("u1"), thinking("t1"), tool("x1"), user("i1", true), result("r1", 16000)];
    const spans = turnSpans(turn, true);
    expect(spans).toHaveLength(1);
    expect(spans[0].finished).toBe(false);
  });

  it("交棒的 result 之后接着跑起来：这一轮从头到尾都是一段、都在跑", () => {
    const turn = [
      user("u1"),
      thinking("t1"),
      user("i1", true),
      result("r1", 16000),
      { id: "th2", seq: 0, ts: 0, kind: "thinking", text: "插话后的思考" } as Item,
    ];
    const spans = turnSpans(turn, true);
    expect(spans).toHaveLength(1);
    expect(spans[0].finished).toBe(false);
    expect(spans[0].process.map((i) => i.id)).toEqual(["t1", "th2"]);
  });

  // 出错 / 被中断的 result 是真的停了：收起行该出来，哪怕它紧挨着一条插话。
  it("插话之后紧跟的 result 若是出错/中断，这一轮确实结束", () => {
    for (const extra of [{ isError: true }, { subtype: "interrupt" }]) {
      const spans = turnSpans(
        [user("u1"), thinking("t1"), user("i1", true), { id: "r1", seq: 0, ts: 0, kind: "result", ...extra } as Item],
        true,
      );
      expect(spans[0].finished).toBe(true);
    }
  });

  it("插话之后还有内容才收尾：那是这一轮真的跑完了", () => {
    const spans = turnSpans(
      [user("u1"), thinking("t1"), user("i1", true), reply("a1"), result("r1", 9000)],
      true,
    );
    expect(spans[0].finished).toBe(true);
  });
});

describe("replyDividerIds（最终回答前面的分隔线）", () => {
  it("跨过过程之后的最终回答加一条线", () => {
    // 用户 → 过渡正文 a1 → 思考 → 工具 → 最终回答 a2
    const turn: Item[] = [
      reply("a1"),
      thinking("t1"),
      tool("b1", "Read", "ok"),
      reply("a2"),
    ];
    expect([...replyDividerIds(turn)]).toEqual(["a2"]);
  });

  it("多段过渡正文只给最后一段画一条，不是每段都画", () => {
    // 折叠之后过渡正文全部连在一起，逐段加线会变成满屏横线的噪音。
    const turn: Item[] = [
      reply("a1"),
      thinking("t1"),
      reply("a2"),
      tool("b1", "Bash", "ok"),
      reply("a3"),
      thinking("t2"),
      reply("a4"),
    ];
    expect([...replyDividerIds(turn)]).toEqual(["a4"]);
  });

  it("只有一段正文时不画（纯问答不需要边界）", () => {
    expect(replyDividerIds([reply("a1")]).size).toBe(0);
    expect(replyDividerIds([reply("a1"), thinking("t1")]).size).toBe(0);
  });

  it("最后一段之前没跨过过程时不画（上游把一条回复拆成多个 text 块）", () => {
    const turn: Item[] = [reply("a1"), reply("a2"), reply("a3")];
    expect(replyDividerIds(turn).size).toBe(0);
  });

  it("空正文的 assistant 不参与判断（它不占渲染位置）", () => {
    const blank: Item = { id: "a0", seq: 0, ts: 0, kind: "assistant", text: "   ", streaming: false };
    const turn: Item[] = [blank, thinking("t1"), reply("a1")];
    // a0 不算一段正文，a1 因此是唯一可见段。
    expect(replyDividerIds(turn).size).toBe(0);
  });

  it("被「仅最终回答」藏掉的回复不参与判断", () => {
    const turn: Item[] = [reply("a1"), thinking("t1"), reply("a2")];
    expect([...replyDividerIds(turn)]).toEqual(["a2"]);
    // a1 被藏了：a2 成了唯一可见段，不该再挂一条"看不见前文"的线。
    expect(replyDividerIds(turn, new Set(["a1"])).size).toBe(0);
  });
});

describe("replyDividerIds 只在轮次结束后画线", () => {
  // 跑到一半时最后一段正文只是「此刻说到哪」，模型还会接着说。按它画线的话，
  // 线先挂在过渡正文上、随后又跳到结论前面（截图里那道在思考过程上方的横线）。
  it("settled=false 时一条线都不画", () => {
    const turn: Item[] = [reply("a1"), thinking("t1"), reply("a2")];
    expect(replyDividerIds(turn, undefined, true).size).toBe(1);
    expect(replyDividerIds(turn, undefined, false).size).toBe(0);
  });

  it("默认参数按已结束处理（历史回放与既有调用点不受影响）", () => {
    const turn: Item[] = [reply("a1"), thinking("t1"), reply("a2")];
    expect([...replyDividerIds(turn)]).toEqual(["a2"]);
  });
});

describe("提问在组头里的说法", () => {
  it("提问单独一类：不和「调用工具」混在一起", () => {
    expect(toolCategory("AskUserQuestion")).toBe("ask");
  });

  it("命令 + 提问拼成人话，与 DSH 的组头一致", () => {
    const ask: ToolItem = {
      ...tool("ask", "AskUserQuestion"),
      input: { questions: [{ question: "Q", options: [{ label: "A" }] }] },
      result: 'Your questions have been answered: "Q"="A". You can now continue with these answers in mind.',
    };
    const items: Item[] = [tool("b", "Bash", "ok"), ask];
    expect(groupTitle(items, "done", "zh")).toBe("执行了命令并向你提出了问题");
  });
});
