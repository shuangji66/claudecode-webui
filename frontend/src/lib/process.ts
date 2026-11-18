// 过程分组：决定「思考过程 / 工具调用」在对话里怎么排。
//
// 口径对齐 DSH 的「工作步骤展示」：
//   - 同一轮内相邻的过程内容（思考 + 工具）合成一个「过程组」；
//   - 一条 Assistant 回复结束前面的组（回复本身不进组，始终可见）；
//   - 组头用**人话摘要**（已读取文件并运行了命令），不是工具名计数；
//   - 组是否还在跑由「组尾是不是整条列表的末尾」判断——回答一出现，组就结束。
//
// 三档只是「显示多少」：简洁/标准把过程收成组头一行，详细在运行中直接铺开每一行；
// 分组本身对三档完全一致，所以切换档位不会重建内容、也不会改变信息的归属。
//
// 分组只影响渲染：Item 本身、seq、id、转录回放都不动。
import { tr, type Locale } from "./i18n";
import type { Item, ThinkingItem, ToolItem } from "./model";
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
   * `live` = 这一组所属的**轮次**还没结束（后面没有 result）：收起时机只看它，
   * 中途写一句过渡回复不算结束，否则任务进行中会反复折叠/展开。
   * `tail` = 这一组还是列表里最后一段内容：组头的「正在…」文案与「进行中」标记只看它。
   */
  | { type: "process"; key: string; start: number; items: Item[]; live: boolean; tail: boolean };

/** 思考与工具调用都是「过程」，正文回答与用户消息不是。 */
export function isProcessItem(item: Item): boolean {
  return item.kind === "tool" || item.kind === "thinking";
}

/**
 * 这一条目之后还有没有 result，**并且**这条会话此刻真的在跑。
 *
 * 只看 result 在实时流里够用，但**转录回放里没有 result 行**（claude 只把它写 stdout）：
 * 重开一个早就结束的对话时，最后一个 result 之后的所有过程组都会被判成「还在跑」，
 * 详细模式下整段历史被平铺展开、组头永远写「进行中」。所以「会话在不在跑」必须由
 * 调用方显式给（store 的 `states[sid]`），不能靠扫 result 猜。
 */
export function turnRunning(items: Item[], index: number, running = true): boolean {
  if (!running) return false;
  for (let i = index + 1; i < items.length; i += 1) {
    if (items[i].kind === "result") return false;
  }
  return true;
}

/**
 * 把渲染切片折成「行」。
 *
 * 「这一轮结束了没有」看的是后面有没有 `result`，不是「组尾是不是列表末尾」：
 * 一轮里模型会写好几段过渡回复，按位置判断的话每写一句就把过程收起来、下一步再展开，
 * 任务进行中全是跳跃。`result` 才是这一轮真正结束的信号（中断/失败也发 result）。
 *
 * `running` 是「这条会话此刻在不在跑」（store 的会话状态）：转录回放里没有 result 行，
 * 只靠扫描列表会把所有历史轮次当成在跑。默认 true 只给「拿不准」的调用方，
 * 界面上必须传真实状态。
 */
export function buildProcessRows(items: Item[], running = true): ProcessEntry[] {
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
      if (run.length >= 2 && run.some((it) => it.kind === "tool")) {
        rows.push({
          type: "process",
          key: `process-${item.id}`,
          start: i,
          items: run,
          live: turnRunning(items, end, running),
          tail: running && end === items.length - 1,
        });
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

/** 组头在「标准」模式追加的实时详情：正在跑的工具摘要，没有就用思考首行。 */
export function liveDetail(items: Item[]): string {
  const running = runningTool(items);
  if (running) return toolSummary(running);
  return reasoningPreview(items);
}
