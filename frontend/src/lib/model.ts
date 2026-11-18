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

/** 用户气泡里的图片附件（粘贴/选中的截图，或转录回放里的 image block）。 */
export interface UserImage {
  name: string;
  mediaType: string;
  /** 纯 base64（不含 data URL 前缀）；渲染时按 mediaType 拼成 data URL。 */
  data: string;
}

export interface UserItem extends BaseItem {
  kind: "user";
  text: string;
  /**
   * 随消息发出的图片：在气泡里直接显示并可点开预览。
   *
   * 只放图片（PDF / 文本文件仍然以「附件：名字」的正文出现）——图片本身是内容，
   * 一行文件名看不出用户发了什么。
   */
  images?: UserImage[];
}

/** 回合结束时回填到该回合最后一条回答上的用量（只放 CLI 真给过的数）。 */
export interface TurnUsage {
  /** 整个回合的墙钟耗时（result.duration_ms）。 */
  durationMs?: number;
  /** 最后一次请求的用量快照：输出 token、API 耗时、上下文占用。 */
  usage?: UsageSnapshot;
}

export interface AssistantItem extends BaseItem {
  kind: "assistant";
  text: string;
  /** true 表示还在流式输出（收到完整 assistant 消息后转 false）。 */
  streaming: boolean;
  /**
   * 本回合结束时由 normalize 从 result 回填：只挂在**该回合最后一条回答**上，
   * 复制按钮那一行据此显示「耗时 · 输出 tok · tok/s」。中间的过渡正文不带。
   */
  turn?: TurnUsage;
  /**
   * 这条不是模型说的话，而是 CLI 包装的 API 错误（`isApiErrorMessage`）。
   *
   * 上游报错时 CLI 会先发一条正文是「API Error: …」的 assistant 消息，随后
   * result 里再给同一段原因。两条都渲染等于同一句话出现两遍，所以带着这个标记的
   * 消息在 result 里不再重复原因（见 applyResult）。
   */
  apiError?: boolean;
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

/**
 * 「本轮被中断」标记。
 *
 * CLI 在回合被中断时会往流里写一条合成 user 消息（`[Request interrupted by user]`）。
 * 它既不是用户说的话（渲染成气泡会让人以为自己发过这句），也不是普通 system 输出，
 * 所以单独一种 item，由渲染层给一句中性的提示。
 */
export interface InterruptItem extends BaseItem {
  kind: "interrupt";
  /** CLI 的标记原文（只用于排查，不展示）。 */
  marker: string;
  /**
   * 谁结束了这一轮：
   * - `user`：用户自己按了停止；
   * - `session`：会话/进程被结束（重启、被回收、被删版本），**没人要求停**——
   *   恢复对话时 CLI 会补写一条说明性的标记；
   * - `agent`：子代理被中断。
   *
   * 三种都要显示不同的话：把「进程被结束」说成「已中断」会让用户以为是自己停的。
   */
  reason: InterruptReason;
}

export type InterruptReason = "user" | "session" | "agent";

/** 把 CLI 的中断标记归到三种原因之一。 */
export function interruptReason(marker: string): InterruptReason {
  const t = marker.trim();
  if (t.startsWith("[Agent call interrupted")) return "agent";
  if (t.startsWith("[Request interrupted by user")) return "user";
  return "session";
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
  | InterruptItem
  | ResultItem
  | ErrorItem;

export function isTool(i: Item): i is ToolItem {
  return i.kind === "tool";
}
