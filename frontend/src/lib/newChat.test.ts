import { describe, expect, it } from "vitest";
import { blankConversationIn, blankConversations, isNewChat } from "./newChat";
import type { ConversationInfo } from "../transport/types";

describe("isNewChat", () => {
  it("没有 activeId（conversation 为空）且没有消息 → 新对话", () => {
    expect(isNewChat(null, 0)).toBe(true);
    expect(isNewChat(undefined, 0)).toBe(true);
  });

  it("刚创建、还没落元数据的会话 → 新对话", () => {
    // 后端要等首条 prompt 成功才写 conversations.json，此时 conversation 还是 null。
    expect(isNewChat(null, 0)).toBe(true);
  });

  it("有消息 → 不是新对话", () => {
    expect(isNewChat(null, 2)).toBe(false);
    expect(isNewChat({ messages: 3, title: "" }, 3)).toBe(false);
  });

  it("历史对话还没回放完（items 暂时为空）也不算新对话", () => {
    // 只看 items 会让每次点开旧对话都先闪一下新对话页。
    expect(isNewChat({ messages: 5, title: "" }, 0)).toBe(false);
    expect(isNewChat({ messages: 1, title: "旧标题" }, 0)).toBe(false);
  });

  it("只有标题没有消息（重命名过的空对话）不算新对话", () => {
    expect(isNewChat({ messages: 0, title: "我的对话" }, 0)).toBe(false);
    expect(isNewChat({ messages: 0, title: "   " }, 0)).toBe(true);
  });
});

describe("blankConversations：全局只有一条新对话", () => {
  const conv = (id: string, over: Partial<ConversationInfo> = {}): ConversationInfo => ({
    id,
    cwd: "/w",
    title: "",
    created_at: "2026-01-01T00:00:00Z",
    last_active: "2026-01-01T00:00:00Z",
    messages: 0,
    archived: false,
    live: false,
    ...over,
  });

  it("找到这个工作区的空对话", () => {
    expect(blankConversations("/w", [conv("c1")]).reusable?.id).toBe("c1");
  });

  // 结尾多一个斜杠是同一个目录（工作区路径来自用户选择，写法不保证唯一）。
  it("路径去尾部斜杠后再比", () => {
    expect(blankConversations("/w/", [conv("c1", { cwd: "/w" })]).reusable?.id).toBe("c1");
    expect(blankConversations("/w", [conv("c1", { cwd: "/w/" })]).reusable?.id).toBe("c1");
  });

  // 不能借 `belongs`：那会把子目录里的对话也复用过来，新对话的 cwd 就悄悄换了。
  it("只认同一个工作区，子目录不算可复用", () => {
    const sub = blankConversations("/w", [conv("c1", { cwd: "/w/sub" })]);
    expect(sub.reusable).toBeNull();
    // 但它确实是一条空壳：列进 stale，等新建成功后收掉。
    expect(sub.stale.map((c) => c.id)).toEqual(["c1"]);
  });

  // 这就是「不同工作区都能创建新对话」的根因：别的目录的空壳既不能被复用
  // （claude 会在错的 cwd 里跑），也不能就此不管（它占着常驻槽位）。
  it("别的工作区的空壳进 stale，不进 reusable", () => {
    const r = blankConversations("/a", [conv("x", { cwd: "/b" })]);
    expect(r.reusable).toBeNull();
    expect(r.stale.map((c) => c.id)).toEqual(["x"]);
  });

  it("本工作区有一条、别处还有几条时，本工作区那条可复用，其余收掉", () => {
    const r = blankConversations("/a", [
      conv("here", { cwd: "/a" }),
      conv("b1", { cwd: "/b", last_active: "2026-01-03T00:00:00Z" }),
      conv("b2", { cwd: "/c", last_active: "2026-01-02T00:00:00Z" }),
    ]);
    expect(r.reusable?.id).toBe("here");
    expect(r.stale.map((c) => c.id)).toEqual(["b1", "b2"]);
  });

  it("有内容 / 归档 / 有消息流的都不算空对话", () => {
    expect(blankConversations("/w", [conv("c1", { messages: 3 })]).reusable).toBeNull();
    expect(blankConversations("/w", [conv("c1", { title: "我的对话" })]).reusable).toBeNull();
    expect(blankConversations("/w", [conv("c1", { archived: true })]).reusable).toBeNull();
    // 首条消息刚发出去、列表还没刷回来：本机已经有消息流，不能再当空壳复用。
    expect(blankConversations("/w", [conv("c1")], () => 1).reusable).toBeNull();
    // 也不能把它当成 stale 收掉——那会把一条刚发出消息的对话关掉。
    expect(blankConversations("/w", [conv("c1", { cwd: "/b" })], () => 1).stale).toEqual([]);
  });

  // 历史遗留的堆叠（旧版本连点出来的）进最近那条，其余交给 reclaim 收掉。
  it("同一工作区堆了多条时取最近那条，其余进 stale", () => {
    const r = blankConversations("/w", [
      conv("old", { last_active: "2026-01-01T00:00:00Z" }),
      conv("new", { last_active: "2026-01-05T00:00:00Z" }),
    ]);
    expect(r.reusable?.id).toBe("new");
    expect(r.stale.map((c) => c.id)).toEqual(["old"]);
  });

  it("没有工作区路径时没有可复用的，但空壳仍要收", () => {
    const r = blankConversations("", [conv("c1")]);
    expect(r.reusable).toBeNull();
    expect(r.stale.map((c) => c.id)).toEqual(["c1"]);
  });
});

describe("blankConversationIn", () => {
  it("只返回可复用的那条（stale 不参与）", () => {
    const here = { id: "a", cwd: "/w", title: "", messages: 0, archived: false } as ConversationInfo;
    const there = { id: "b", cwd: "/x", title: "", messages: 0, archived: false } as ConversationInfo;
    expect(blankConversationIn("/w", [here, there])?.id).toBe("a");
    expect(blankConversationIn("/y", [here, there])).toBeNull();
  });
});
