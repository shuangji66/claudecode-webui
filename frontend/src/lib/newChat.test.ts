import { describe, expect, it } from "vitest";
import { isNewChat } from "./newChat";

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
