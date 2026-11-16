// 「新对话」判定：决定输入框用居中布局（品牌 + 工作区选择器 + 居中输入框）
// 还是常规对话布局（消息列表 + 贴底输入框）。
import type { ConversationInfo } from "../transport/types";

/**
 * 当前是不是还没开始的新对话。
 *
 * 判断依据是**对话元数据**，不是 items 是否为空：打开历史对话时转录是异步
 * 拉回来的，只看 items 会让每次点开旧对话都先闪一下新对话页。
 * 刚创建、还没落元数据的会话（conversation 为 null）算新对话。
 */
export function isNewChat(
  conversation: Pick<ConversationInfo, "messages" | "title"> | null | undefined,
  itemCount: number,
): boolean {
  if (itemCount > 0) return false;
  if (!conversation) return true;
  return conversation.messages === 0 && !conversation.title?.trim();
}
