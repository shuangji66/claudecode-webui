// 前端渲染用的归一化消息模型。
//
// CLI 的原始消息（assistant/user/system/result/stream_event）不直接进渲染层：
// 先经 normalize.ts 归一成这里的 Item，组件只认 Item。
// 这样做的好处是工具卡片、流式去重、tool_use↔tool_result 配对都收敛在纯函数里，可单测。
import type { UsageSnapshot } from "./usage";

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

/** 一个子代理（claude 的 Task/Agent 任务）的实时状态。 */
export interface SubagentInfo {
  /** claude 的任务 id，也是子代理 id（task_started 的 task_id）。 */
  taskId: string;
  /** 查看子代理转录要用的 id；没有 task 事件时从 tool_result 的 agentId 里补。 */
  agentId?: string;
  /** subagent_type，例如 general-purpose / Explore。 */
  type?: string;
  description?: string;
  prompt?: string;
  status: "running" | "completed" | "failed" | "stopped";
  /** true 表示在后台跑（run_in_background / 被转到后台）。 */
  background?: boolean;
  spawnDepth?: number;
  summary?: string;
  outputFile?: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
}

/** tool_result 里带的图片（base64）；渲染成缩略图，不把 base64 当正文塞进 <pre>。 */
export interface ToolImage {
  mediaType: string;
  data: string;
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
  /** 结果里的图片（Read 读图、截图类工具）。 */
  images?: ToolImage[];
  /** 子代理状态（只有 Agent/Task 工具会有）。 */
  subagent?: SubagentInfo;
  /** tool_progress 给的已运行秒数；没有进度事件时为空。 */
  progress?: number;
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
  /** 出错时的原因（CLI 的 result / errors 字段）；成功回合为空。 */
  text?: string;
  /** CLI 的结果子类型，例如 error_max_turns。 */
  subtype?: string;
  denials?: unknown[];
  /** 本回合的用量快照（转录回放时靠它还原上下文/tok/s，见 lib/usage）。 */
  usage?: UsageSnapshot;
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
