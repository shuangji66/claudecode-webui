// 过程分组：决定「思考过程 / 工具调用」在对话里怎么排。
//
// 口径对齐 DSH：
//   - 同一轮内相邻的过程内容（思考 + 工具）合成一个「过程组」；
//   - 一条 Assistant 回复结束前面的组（回复本身不进组，始终可见）；
//   - 组头用**人话摘要**（已读取文件并运行了命令），不是工具名计数；
//   - 组是否还在跑由「组尾是不是整条列表的末尾」判断——回答一出现，组就结束。
//
// 两条轴，互不影响：
//   - **展示档位**决定「展开后每一步怎么画」：简洁按组折成一行摘要、标准不分组一步一行、
//     详细直接铺开完整卡片；
//   - **收起**是轮级的（`collapseTiming`）：把整轮的过程收进轮首一行，只剩正文输出；
//     点开那一行才按上面的档位把思维链与工具调用还原回原来的位置。
//
// 分组只影响渲染：Item 本身、seq、id、转录回放都不动。
import { tr, type Locale } from "./i18n";
import type { AssistantItem, Item, ThinkingItem, ToolItem } from "./model";
import { toolSummary } from "./tools";

/** 工具按「用户在做什么」归类，组头文案与图标都用它。 */
export type ToolCategory =
  | "read"
  | "search"
  | "write"
  | "edit"
  | "commands"
  | "webSearch"
  | "webFetch"
  | "subagents"
  | "plan"
  | "tools"
  | "analysis";

const CATEGORY_BY_TOOL: Record<string, ToolCategory> = {
  Read: "read",
  NotebookRead: "read",
  Grep: "search",
  Glob: "search",
  LS: "search",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Bash: "commands",
  BashOutput: "commands",
  KillShell: "commands",
  KillBash: "commands",
  WebSearch: "webSearch",
  WebFetch: "webFetch",
  Agent: "subagents",
  Task: "subagents",
  TodoWrite: "plan",
  TaskCreate: "plan",
  TaskUpdate: "plan",
  TaskList: "plan",
  TaskGet: "plan",
  ExitPlanMode: "plan",
};

/** 未收录的工具归到「调用工具」，不要因此不显示组头。 */
export function toolCategory(name: string): ToolCategory {
  return CATEGORY_BY_TOOL[name] ?? "tools";
}

const CATEGORY_TEXT: Record<ToolCategory, { running: [string, string]; done: [string, string] }> = {
  read: { running: ["正在读取文件", "Reading files"], done: ["已读取文件", "Read files"] },
  search: { running: ["正在搜索代码", "Searching code"], done: ["已搜索代码", "Searched code"] },
  write: { running: ["正在写入文件", "Writing files"], done: ["已写入文件", "Wrote files"] },
  edit: { running: ["正在编辑文件", "Editing files"], done: ["修改了文件", "Edited files"] },
  commands: { running: ["正在运行命令", "Running commands"], done: ["执行了命令", "Ran commands"] },
  webSearch: { running: ["正在搜索网页", "Searching the web"], done: ["已搜索网页", "Searched the web"] },
  webFetch: { running: ["正在访问网页", "Fetching pages"], done: ["已访问网页", "Fetched pages"] },
  subagents: { running: ["正在协调子代理", "Coordinating subagents"], done: ["已协调子代理", "Coordinated subagents"] },
  plan: { running: ["正在更新计划", "Updating the plan"], done: ["更新了计划", "Updated the plan"] },
  tools: { running: ["正在调用工具", "Calling tools"], done: ["已调用工具", "Called tools"] },
  analysis: { running: ["正在分析请求", "Analyzing the request"], done: ["已完成分析", "Finished analyzing"] },
};

export type ProcessMode = "concise" | "standard" | "detailed";

export type ProcessEntry =
  | { type: "item"; key: string; start: number; item: Item }
  /** 连续的多条 thinking：CLI 一次思考常被拆成好几块，界面上不该各占一行。 */
  | { type: "thinking"; key: string; start: number; items: ThinkingItem[] }
  /**
   * 连续的过程条目（≥2 条才成组；单独一步直接按行显示，省一次点击）。
   *
   * 只给「简洁」档用：组头 + 点开看每一步。**它不带开合状态**——整轮什么时候收起是
   * `TurnSpan` 的事，组级只负责「组内细节折不折」，两件事别混在一起。
   */
  | { type: "process"; key: string; start: number; items: Item[] };

/** 一轮：从一条用户消息到下一个用户消息之前。收起就作用在这个粒度上。 */
export interface TurnSpan {
  /** 起点下标（用户消息；列表开头没有用户消息时是 0）。 */
  start: number;
  /** 终点下标（不含）。 */
  end: number;
  /** 这一轮的过程条目（思考 + 工具）：收起时整批隐藏，展开时按档位还原回原位。 */
  process: Item[];
  /** 这一轮结束没有：本轮里有 `result`，或者这条会话此刻根本不在跑（转录回放）。 */
  finished: boolean;
  /** 本轮耗时（result.duration_ms）；还在跑或者历史里没有 result 时为空。 */
  durationMs?: number;
}

/** 思考与工具调用都是「过程」，正文回答与用户消息不是。 */
export function isProcessItem(item: Item): boolean {
  return item.kind === "tool" || item.kind === "thinking";
}

/**
 * 把**一轮之内**的切片折成「行」。
 *
 * 调用方（`MessageList`）已经按轮切好了，这里只管轮内怎么排：连续的过程要不要折成组。
 * `group` 决定这一点——**只有简洁档传 true**（折成一行组头，点开看每一步），标准档与
 * 详细档都传 false：标准一步一行、详细一张卡片一步，都不需要组头。
 */
export function buildProcessRows(items: Item[], group = true): ProcessEntry[] {
  const rows: ProcessEntry[] = [];
  let i = 0;

  while (i < items.length) {
    const item = items[i];

    if (isProcessItem(item)) {
      let end = i;
      while (end + 1 < items.length && isProcessItem(items[end + 1])) end += 1;
      const run = items.slice(i, end + 1);
      // 纯思考的连续块合并成一行就够了（见下面的 thinking 分支），成组只给「有工具」的过程：
      // 一整组只有「已完成分析」四个字，不如直接显示思考行 + 首行预览。
      if (group && run.length >= 2 && run.some((it) => it.kind === "tool")) {
        rows.push({ type: "process", key: `process-${item.id}`, start: i, items: run });
        i = end + 1;
        continue;
      }
    }

    if (item.kind === "thinking") {
      let end = i;
      while (end + 1 < items.length && items[end + 1].kind === "thinking") end += 1;
      if (end > i) {
        rows.push({
          type: "thinking",
          key: `thinking-${item.id}`,
          start: i,
          items: items.slice(i, end + 1) as ThinkingItem[],
        });
        i = end + 1;
        continue;
      }
    }

    rows.push({ type: "item", key: item.id, start: i, item });
    i += 1;
  }

  return rows;
}

/** 组里各类工具各出现几次：按次数降序、同次数按首次出现的先后。 */
export function groupCategories(items: Item[]): Array<{ category: ToolCategory; count: number }> {
  const counts = new Map<ToolCategory, { count: number; first: number }>();
  items.forEach((item, index) => {
    if (item.kind !== "tool") return;
    const category = toolCategory(item.name);
    const current = counts.get(category);
    if (current) current.count += 1;
    else counts.set(category, { count: 1, first: index });
  });
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first)
    .map(([category, value]) => ({ category, count: value.count }));
}

/** 组头图标用：最重要的一类；纯思考的组算作「分析」。 */
export function dominantCategory(items: Item[]): ToolCategory {
  return groupCategories(items)[0]?.category ?? "analysis";
}

/** 组里正在跑的工具（组头在「标准」模式要显示它的摘要）。 */
export function runningTool(items: Item[]): ToolItem | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === "tool" && item.result === undefined) return item;
  }
  return undefined;
}

/** 最近一段思考的首行：组头（标准/详细）与思考行的预览都用它。 */
export function reasoningPreview(items: Item[]): string {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind !== "thinking") continue;
    const line = item.text.split("\n").find((l) => l.trim()) ?? "";
    if (line.trim()) return line.trim();
  }
  return "";
}

/**
 * 组头文案。
 *
 * 进行中：取正在跑的那件事（没有就跑「正在分析请求」）——这是 DSH 的规则，
 * 比「次数最多的类别」更能说明此刻在干什么。
 * 已结束：取排序前 3 类拼一句人话（`已读取文件并运行了命令`），超过 3 类加「等」。
 */
export function groupTitle(items: Item[], phase: "running" | "done", locale: Locale | string): string {
  if (phase === "running") {
    const running = runningTool(items);
    const category = running ? toolCategory(running.name) : "analysis";
    return label(category, "running", locale);
  }

  const categories = groupCategories(items).map((entry) => entry.category);
  if (categories.length === 0) return label("analysis", "done", locale);

  const shown = categories.slice(0, 3);
  const parts = shown.map((category) => label(category, "done", locale));
  const title = joinDone(parts, locale);
  return categories.length > 3 ? (locale === "en" ? `${title}, etc.` : `${title}等`) : title;
}

function label(category: ToolCategory, phase: "running" | "done", locale: Locale | string): string {
  const [zh, en] = CATEGORY_TEXT[category][phase];
  return tr(locale, zh, en);
}

function joinDone(parts: string[], locale: Locale | string): string {
  if (parts.length === 1) return parts[0];
  if (locale === "en") {
    const [first, ...rest] = parts;
    const lowered = rest.map((part) => part.charAt(0).toLowerCase() + part.slice(1));
    if (lowered.length === 1) return `${first} and ${lowered[0]}`;
    return `${first}, ${lowered.slice(0, -1).join(", ")} and ${lowered[lowered.length - 1]}`;
  }
  if (parts.length === 2) {
    const second = parts[1].startsWith("已") ? parts[1].slice(1) : parts[1];
    return `${parts[0]}并${second}`;
  }
  return parts.join("，");
}

/**
 * 「仅最终回答」时该隐藏哪些 Assistant 回复。
 *
 * 按用户消息切轮；被折叠的轮次只留**最后一条**有正文的回复，阶段回复随过程一起收起。
 * `keepTail` 表示最新一轮的过程仍展开（运行中 / 「下次发送时收起」的保留期），这时它的
 * 回复全部保留——过程都没收，回复先消失会让人以为消息丢了。
 * 返回 Item id 集合，渲染层据此跳过整行（不是把它塞进过程组）。
 */
export function hiddenReplyIds(items: Item[], keepTail: boolean): Set<string> {
  const hidden = new Set<string>();
  const starts: number[] = [];
  items.forEach((item, index) => {
    if (item.kind === "user" && index > 0) starts.push(index);
  });
  const bounds = [0, ...starts];
  if (bounds.length === 0) return hidden;

  bounds.forEach((start, turn) => {
    const end = turn + 1 < bounds.length ? bounds[turn + 1] : items.length;
    const isTail = turn === bounds.length - 1;
    if (isTail && keepTail) return;
    const replies: Item[] = [];
    for (let i = start; i < end; i += 1) {
      const item = items[i];
      if (item.kind === "assistant" && item.text.trim()) replies.push(item);
    }
    for (const reply of replies.slice(0, -1)) hidden.add(reply.id);
  });
  return hidden;
}

/** 组头在「简洁」模式追加的实时详情：正在跑的工具摘要，没有就用思考首行。 */
export function liveDetail(items: Item[]): string {
  const running = runningTool(items);
  if (running) return toolSummary(running);
  return reasoningPreview(items);
}

/**
 * 一轮里「谁拿复制按钮」以及「复制什么」。
 *
 * 判定只认**本条是不是这一轮最后一条有正文的回答**：一轮里模型会写好几段过渡正文
 * （夹在思考与工具调用之间），每段都挂复制按钮只是噪音，复制出来的也只是半句话。
 * 真正值得复制的入口只有最终回答那一处。
 *
 * 复制内容则是**整轮的正文输出**：按顺序把这一轮所有 assistant 正文拼起来（过渡正文
 * + 最终回答）。用户要的是「这一轮说了什么」；过渡正文在收起态下多半看不见，不带上
 * 就等于复制不全。**思考过程（thinking）不进复制内容**——那是推理，不是输出；CLI 包的
 * API 错误消息也不算正文。
 *
 * 返回 `undefined` 表示「这条不给复制入口」；否则返回它该复制的文本。
 * 纯函数：`items` 传一整轮的切片（`turnSpans` 的 `[start, end)`）。
 */
export function replyCopy(items: Item[], id: string): string | undefined {
  let lastReply: AssistantItem | undefined;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind !== "assistant" || item.apiError || !item.text.trim()) continue;
    lastReply = item;
    break;
  }
  if (!lastReply || lastReply.id !== id) return undefined;
  const text = items
    .filter((item): item is AssistantItem => item.kind === "assistant" && !item.apiError && item.text.trim() !== "")
    .map((item) => item.text.trim())
    .join("\n\n");
  return text === "" ? undefined : text;
}

/**
 * 把列表切成「轮」，并标出每轮的过程条目。
 *
 * 轮 = 两条用户消息之间的一段（与 `lib/turns.turnsOf` 同一套锚点）。**收起是轮级的**：
 * 一整轮的思考与工具调用一起收进轮首那一行，只剩正文输出；点开再按档位还原。
 * 所以这里要把每轮的过程条目单独捞出来——展开后的还原与「这一轮有没有过程可收」都靠它。
 *
 * `running` 是「这条会话此刻在不在跑」：转录回放里没有 result 行，只靠扫列表会把历史
 * 轮次全判成没结束。
 */
export function turnSpans(items: Item[], running = true): TurnSpan[] {
  const spans: TurnSpan[] = [];
  let start = 0;
  // 列表开头没有用户消息（历史被窗口截断）时，这一段也算一轮，否则它的过程无处可收。
  const heads: number[] = [];
  items.forEach((item, index) => {
    if (item.kind === "user" && index > 0) heads.push(index);
  });
  const bounds = [...heads, items.length];
  for (const end of bounds) {
    const process: Item[] = [];
    let finished = !running;
    let durationMs: number | undefined;
    for (let i = start; i < end; i += 1) {
      const item = items[i];
      if (isProcessItem(item)) process.push(item);
      else if (item.kind === "result") {
        finished = true;
        if (typeof item.durationMs === "number") durationMs = item.durationMs;
      }
    }
    spans.push({ start, end, process, finished, durationMs });
    start = end;
  }
  return spans;
}
