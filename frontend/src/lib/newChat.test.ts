import { describe, expect, it } from "vitest";
import { blankConversationIn, isNewChat } from "./newChat";
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

describe("blankConversationIn：每个工作区只认一条空对话", () => {
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
    const hit = blankConversationIn("/w", [conv("c1")]);
    expect(hit?.id).toBe("c1");
  });

  // 结尾多一个斜杠是同一个目录（工作区路径来自用户选择，写法不保证唯一）。
  it("路径去尾部斜杠后再比", () => {
    expect(blankConversationIn("/w/", [conv("c1", { cwd: "/w" })])?.id).toBe("c1");
    expect(blankConversationIn("/w", [conv("c1", { cwd: "/w/" })])?.id).toBe("c1");
  });

  // 不能借 `belongs`：那会把子目录里的对话也复用过来，新对话的 cwd 就悄悄换了。
  it("只认同一个工作区，子目录不算", () => {
    expect(blankConversationIn("/w", [conv("c1", { cwd: "/w/sub" })])).toBeNull();
    expect(blankConversationIn("/w/sub", [conv("c1", { cwd: "/w" })])).toBeNull();
  });

  it("有内容 / 归档 / 有消息流的都不算空对话", () => {
    expect(blankConversationIn("/w", [conv("c1", { messages: 3 })])).toBeNull();
    expect(blankConversationIn("/w", [conv("c1", { title: "我的对话" })])).toBeNull();
    expect(blankConversationIn("/w", [conv("c1", { archived: true })])).toBeNull();
    // 首条消息刚发出去、列表还没刷回来：本机已经有消息流，不能再当空壳复用。
    expect(blankConversationIn("/w", [conv("c1")], () => 1)).toBeNull();
  });

  // 历史遗留的堆叠（旧版本连点出来的）进最近那条，其余交给用户在侧栏删。
  it("堆了多条时取最近活跃的那条", () => {
    const hit = blankConversationIn("/w", [
      conv("old", { last_active: "2026-01-01T00:00:00Z" }),
      conv("new", { last_active: "2026-01-05T00:00:00Z" }),
    ]);
    expect(hit?.id).toBe("new");
  });

  it("没有工作区路径时返回 null", () => {
    expect(blankConversationIn("", [conv("c1")])).toBeNull();
  });
});
