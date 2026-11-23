// 「新对话」判定：决定输入框用居中布局（品牌 + 工作区选择器 + 居中输入框）
// 还是常规对话布局（消息列表 + 贴底输入框）。
import { samePath, sortByRecent } from "./conversations";
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

/**
 * 在某个工作区里找一条**已经存在的空对话**（新建了但一条消息都没发）。
 *
 * 「每个工作区只有一条新对话」靠它：点「新对话」或工作区行尾的「+」时，若这里
 * 已经有空壳就进去，而不是再建一条。以前只在「当前正打开的这条就是空对话」时
 * no-op，于是从一条有内容的对话上连点几次「+」（或者中途切去别的对话再点回来）
 * 就会堆出一串同名「新对话」，每一条都占着一个常驻会话槽位。
 *
 * 判定复用 `isNewChat`：元数据 `messages === 0` 且没有标题，再叠加本机有没有
 * 消息流（首条消息刚发出、列表还没刷回来的那几百毫秒里，元数据仍是 0）。
 * `cwd` 按工作区精确匹配（去尾部斜杠），不是 `belongs`：子目录里建出来的对话
 * 复用过来会让新对话的 cwd 悄悄换个目录。
 */
export function blankConversationIn(
  cwd: string,
  conversations: ConversationInfo[],
  localItemCount: (id: string) => number = () => 0,
): ConversationInfo | null {
  if (!cwd) return null;
  // 有多条（历史遗留的堆叠）时进最近那条，其余留给用户在侧栏删掉。
  const hits = conversations.filter(
    (c) => !c.archived && samePath(c.cwd, cwd) && isNewChat(c, localItemCount(c.id)),
  );
  return sortByRecent(hits)[0] ?? null;
}
