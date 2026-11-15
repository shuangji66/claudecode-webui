// 前端渲染用的归一化消息模型。
//
// CLI 的原始消息（assistant/user/system/result/stream_event）不直接进渲染层：
// 先经 normalize.ts 归一成这里的 Item，组件只认 Item。
// 这样做的好处是工具卡片、流式去重、tool_use↔tool_result 配对都收敛在纯函数里，可单测。

export interface BaseItem {
  id: string;
  /** 会话内事件顺序号，用于稳定排序。 */
  seq: number;
  ts: number;
}

export interface UserItem extends BaseItem {
  kind: "user";
  text: string;
}

export interface AssistantItem extends BaseItem {
  kind: "assistant";
  text: string;
  /** true 表示还在流式输出（收到完整 assistant 消息后转 false）。 */
  streaming: boolean;
}

export interface ThinkingItem extends BaseItem {
  kind: "thinking";
  text: string;
}

export interface ToolItem extends BaseItem {
  kind: "tool";
  toolUseId: string;
  name: string;
  input: unknown;
  /** 工具执行结果文本；undefined 表示尚未返回。 */
  result?: string;
  isError?: boolean;
  /** 结构化结果（如 Edit 的 structuredPatch），用于 diff 渲染。 */
  structured?: unknown;
}

export interface SystemItem extends BaseItem {
  kind: "system";
  subtype?: string;
  text: string;
}

export interface ResultItem extends BaseItem {
  kind: "result";
  costUsd?: number;
  durationMs?: number;
  isError?: boolean;
  denials?: unknown[];
}

export interface ErrorItem extends BaseItem {
  kind: "error";
  text: string;
}

export type Item =
  | UserItem
  | AssistantItem
  | ThinkingItem
  | ToolItem
  | SystemItem
  | ResultItem
  | ErrorItem;

export function isTool(i: Item): i is ToolItem {
  return i.kind === "tool";
}
