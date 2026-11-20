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
  /**
   * 这条是**插话**（`priority=now`），不是新的一轮。
   *
   * 插话是「往正在跑的这一轮里补一句」，CLI 会把它并入当前回合（挪走能后台化的工具）
   * 或者中断本轮重开。**它不能切开轮**：按用户消息切轮的话，一句话就会把这一轮的思考
   * 与工具调用劈成两半——前半截被当成「已完成」收起来、后半截被当成新一轮重新铺开，
   * 界面上就是「插了一句，前面的过程突然折起来了」。
   */
  interjected?: boolean;
  /**
   * 这条气泡来自后端广播的 `prompt.echo`（别的设备/标签发的）。
   *
   * 去重要靠它区分「本机乐观插入的那条」与「广播补进来的那条」：只按文本比对的话，
   * 同一个设备连着发两次「继续」，第二条广播会命中第一条气泡被吞掉——另一台设备上
   * 就少了一条。本机插入的那条没有这个标记，命中即说明「这条正是我发的」。
   */
  echoed?: boolean;
}

/** 回合结束时回填到该回合最后一条回答上的用量（只放 CLI 真给过的数）。 */
export interface TurnUsage {
  /** 整个回合的墙钟耗时（result.duration_ms）。 */
  durationMs?: number;
  /**
   * 这一轮的用量快照：`turnInputTokens` + `outputTokens` 是「本轮消耗」（输入含缓存），
   * `genMs` / `genTokens` 是**最近一次请求**的生成耗时与输出，用来算 tok/s。
   *
   * 不是「最后一次请求的上下文占用」——上下文占用归底栏那颗圆环（store 的 `usage`），
   * 回答下面只报这一轮花了多少。别按旧口径改回去。
   */
  usage?: UsageSnapshot;
}

export interface AssistantItem extends BaseItem {
  kind: "assistant";
  text: string;
  /** true 表示还在流式输出（收到完整 assistant 消息后转 false）。 */
  streaming: boolean;
  /**
   * 本回合结束时由 normalize 从 result 回填：只挂在**该回合最后一条回答**上，
   * 复制按钮那一行据此显示「耗时 · 本轮 tok · tok/s」。中间的过渡正文不带。
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
  /**
   * true 表示还在流式增长（收到完整 assistant 消息后转 false）。
   *
   * `--include-partial-messages` 会先给 `thinking_delta` 逐字增量、再给完整消息。
   * 不给标记的话，长时间思考期间界面上什么都不动（要等整条消息到齐才出现），
   * 用户会以为会话卡死了。
   */
  streaming?: boolean;
}

/** 一个子代理（claude 的 Task/Agent 任务）的实时状态。 */
export interface SubagentInfo {
  /** claude 的任务 id，也是子代理 id（task_started 的 task_id）。 */
  taskId: string;
  /**
   * task_started 的 task_type：`local_agent`（子代理）/ `local_bash`（后台命令）/
   * `mcp_task` 等。
   *
   * **这是区分「子代理」与「后台操作」的唯一可靠依据**：两者都发 task_* 事件、
   * 都带 task_id 与 description，只有 task_type 不同。缺失（老版本 CLI、转录回放）
   * 时按子代理处理——宁可多列在子智能体里，也不要把子代理错当成后台命令。
   */
  taskType?: string;
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
  /**
   * 进度事件里附带的一行说明（目前只有子代理重试：
   * `重试第 2/3 次 · HTTP 529 · overloaded`）。
   *
   * 单独一个字段而不是拼进 `progress`：秒数每秒都在变，说明只在事件到达时变，
   * 两者混在一起会让「运行中 12s」这种标签跟着抖。
   */
  progressNote?: string;
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
