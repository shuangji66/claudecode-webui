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
   * `turnGenMs` / `turnGenTokens` 是**这一轮所有量到的请求**的生成耗时与输出之和，
   * `turnThroughput` 用它算本轮 tok/s（`genMs` / `genTokens` 只是兜底：本回合一次都没
   * 量到时退回最近一次真量到的请求）。
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
  /**
   * 这次请求用的模型（CLI 的 `message.model`）。
   *
   * 只给**轨迹面板**用：一条消息一个模型名，同一轮里切换过模型（子代理、回退被禁后
   * 手动换档）时泳道要按它分开画。老转录没这个字段时为空串。
   */
  model?: string;
}

export interface ThinkingItem extends BaseItem {
  kind: "thinking";
  text: string;
  /**
   * true 表示还在流式增长（收到完整 assistant 消息后转 false）。
   *
   * `--include-partial-messages` 会先给 `thinking_delta` 逐字增量、再给完整消息。
   * 不给标记的话，长时间思考期间界面上什么都不动（要等整条消息才出现），
   * 用户会以为会话卡死了。
   */
  streaming?: boolean;
  /** 这次请求用的模型（CLI 的 `message.model`）；轨迹按它标泳道。 */
  model?: string;
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
  /**
   * 用量。字段可缺：
   * - `totalTokens` 一定有（CLI 的 `subagent_tokens`，或重启后从子代理转录恢复的同一个数）；
   * - `toolUses` / `durationMs` 只有 CLI 的进度/结束通知才给，恢复出来的那份没有——
   *   别拿 0 兜底，界面上「0 次工具 · 00:00」比不显示更误导。
   */
  usage?: { totalTokens: number; toolUses?: number; durationMs?: number };
  /**
   * 从子代理转录尾部读出的收尾时刻（unix 毫秒，`settleSubagents` 回填）。
   *
   * 后台子代理的 `tool_result` 只是启动回执，`doneAt` 记的是「启动回执到达」；
   * 拿它当结束时刻会算出 0 秒。主转录里又没有 `task_*` 帧，只有磁盘上那份转录
   * 还留着真实的收尾时间。
   */
  endedAt?: number;
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
  /**
   * 这张卡是 `system/task_*` 事件先造的**占位卡**（真正的 `tool_use` 还没到）。
   *
   * 只给轨迹面板用：占位卡的时间戳是 task 事件的时刻，不是一次模型请求的落盘时刻，
   * 拿它当「请求边界」会凭空多画一段模型耗时。真正的 `tool_use` 到达时这里会被置回
   * false（见 `applyAssistant` 的合并分支）。
   */
  placeholder?: boolean;
  /**
   * 结果回填的时刻（`tool_result` 帧/转录行的到达时间）。
   *
   * **不要拿 `ts` 当结束时刻**：`ts` 是 `tool_use` 到达、也就是这次调用**开始**的时刻
   * （`applyAssistant` 建卡片时写死）。轨迹面板靠 `doneAt - ts` 画工具耗时；undefined
   * 表示结果还没回来（还在跑，或者是被中断的工具）。
   */
  doneAt?: number;
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

/**
 * 「这一轮是被谁唤醒的」——后台任务结束时 CLI 注入的那条 user 行
 * （`<task-notification>`）。
 *
 * **它是新的一轮，不是上一轮的续写。** CLI 自己就是这么记的：真实转录里
 * `turnPosition` 在每次通知处都递增 `turnIndex`、而 `promptIndex` 不变
 * （实测一份转录里 `prompt=2` 下依次是 `turn=2 human → turn=3 通知 → turn=4 通知 →
 * turn=5 通知 → turn=6 human`）。把三条通知并进同一个 turnIndex，界面上就会出现
 * 「主任务暂时收尾、挂上『已完成』并收起思考 → 子代理回报后又重新铺开」的来回跳，
 * 中间那段过渡正文的用量也留在旧轮的收起行下面（用户报的就是这个）。
 *
 * 它同时**不是用户说的话**：渲染成气泡等于把 `<task-id>` 那坨 XML 摆在对话里。
 * 所以单列一种 Item——渲染层把它画成一行「轮次触发条」（对齐 DSH 的
 * `turn-trigger` 节点：图标 + 一句人话 + 时刻，点开才看通知原文）。
 *
 * 三种消费方要注意：轮锚点（`turns.turnsOf` / `process.turnSpans` /
 * `hiddenReplyIds` / `normalize.turnsFromTranscript`）把它当轮头；正文流渲染它；
 * 标题与摘要（`labels`、`trace` 的 prompt）**跳过它**——它不该成为会话标题。
 */
export interface WakeItem extends BaseItem {
  kind: "wake";
  /**
   * 唤醒来源。目前只有后台任务（子代理 / 后台命令 / MCP 调用），未来 CLI 可能加别的。
   * 未知值按「后台任务」渲染，不要因此不显示这一行。
   */
  origin: "task";
  /** 被唤醒的那个任务（子代理的 agentId / 后台命令的 task-id）。 */
  taskId?: string;
  /** 发起它的那次 tool_use：用来回查是哪条 Agent 卡片。 */
  toolUseId?: string;
  /** 一句话说明（通知里的 `<summary>`，通常是 `Agent "…" finished`）。 */
  summary?: string;
  /** 任务的最终状态（`<status>`）。未知值不猜，留空。 */
  status?: SubagentInfo["status"];
  /** 通知原文（点开触发条时看的），不展示在正文流里。 */
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
  | ErrorItem
  | WakeItem;

/**
 * 这一条是不是「一轮的开头」。
 *
 * 两个来源：用户亲手发的一条（插话不算，它并进当前回合），以及后台任务的唤醒通知
 * （见 `WakeItem`）。**所有按轮切分的地方都必须用这一份**，各写一遍必然漂移——
 * 漏了 wake 就会出现「等待子代理的那一段」被压成一坨。
 */
export function isTurnHead(item: Item | undefined): boolean {
  if (!item) return false;
  if (item.kind === "wake") return true;
  return item.kind === "user" && !item.interjected;
}

/**
 * 唤醒轮的短标签（轮次刻度悬停、轨迹的 prompt 行用）。
 *
 * 通知里的 `<summary>` 是英文人话（`Agent "审查网关鉴权与路径围栏" finished`），
 * 直接摆上去在中文界面里很突兀，所以只把它里的**名字**摘出来；摘不出就按状态说一句。
 * 状态未知时说「已返回」——那是事实（通知到了就说明它停了），不猜成功或失败。
 */
export function wakeLabel(item: WakeItem, locale: "zh" | "en" = "zh"): string {
  const name = agentNameOf(item.summary);
  const state = wakeStatusText(item.status, locale);
  if (locale === "en") return name ? `${name} — ${state}` : state;
  return name ? `子代理「${name}」${state}` : state;
}

/** 从 `Agent "名字" finished` 里摘名字（CLI 的 summary 模板）。 */
function agentNameOf(summary: string | undefined): string {
  if (!summary) return "";
  const quoted = /"([^"]+)"/.exec(summary);
  if (quoted) return quoted[1];
  // 没有引号（老模板 / 后台命令的摘要）：整句太吵，只留前 30 字。
  const s = summary.trim();
  return s.length > 30 ? `${s.slice(0, 30)}…` : s;
}

function wakeStatusText(status: SubagentInfo["status"] | undefined, locale: "zh" | "en"): string {
  switch (status) {
    case "completed":
      return locale === "en" ? "finished" : "已完成";
    case "failed":
      return locale === "en" ? "failed" : "失败了";
    case "stopped":
      return locale === "en" ? "stopped" : "已停止";
    default:
      // running 不会出现在唤醒里（通知表示它停了）；未知值不猜成功。
      return locale === "en" ? "woke this turn" : "已返回";
  }
}

export function isTool(i: Item): i is ToolItem {
  return i.kind === "tool";
}
