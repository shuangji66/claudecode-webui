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
import { isTurnHead } from "./model";
import type { AssistantItem, Item, ThinkingItem, ToolItem } from "./model";

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
  | "ask"
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
  // 模型中途的提问也算「用户在做的事」：和人话组头「执行了命令并向你提出了问题」
  // 对齐 DSH，不要落进「调用工具」那一类。
  AskUserQuestion: "ask",
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
  ask: { running: ["正在向你提问", "Asking you"], done: ["向你提出了问题", "Asked you"] },
  tools: { running: ["正在调用工具", "Calling tools"], done: ["已调用工具", "Called tools"] },
  analysis: { running: ["正在分析请求", "Analyzing the request"], done: ["已完成分析", "Finished analyzing"] },
};

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
  /**
   * 这一轮结束没有：`result` 之后**本段里再没有过程**，或者这条会话此刻根本不在跑
   * （转录回放）。
   *
   * 不能只看「本段里有 result」：插话有时赶不上当前回合，CLI 会先把这一轮收尾
   * （发 `result`）、再开一轮把插话跑完。那两条 result 之间还夹着正在产生的思考与
   * 工具，按「有 result 就算结束」会把它们一起收进「已完成」那一行——用户看到的
   * 就是「插了一句，后面的思考突然折起来了」。
   */
  finished: boolean;
  /**
   * 这一轮是怎么结束的（只在 `finished` 时成立）。
   *
   * **「结束」不等于「做完了」**：用户按停止、上游报错、进程被结束都会让这一轮收尾，
   * 但它们不该被同一句话说成「已完成」。中断/失败时收起行写「已停止 / 本轮失败」，
   * 也不报用时——那个数在两种情况下都只描述「跑了多久然后被打断」，读起来像完成耗时。
   * 文案对齐 DSH 的 `message.stopped` / `message.turnProcess.failed`。
   */
  outcome: TurnOutcome;
  /**
   * 本轮耗时：本段各条 `result.duration_ms` 之和（一段里可能有多条：插话把一轮
   * 拆成了多个子回合）。
   *
   * 转录回放没有 result 行，这时按本段首尾两条活动条目的时间戳推出来——否则重进
   * 前端之后「已完成右边的用时」全丢（只有实时那一轮有数字）。还在跑、或者连时间戳
   * 都不可用时为空。
   */
  durationMs?: number;
}

/** 一轮的结局：正常收尾 / 被中断 / 出错。见 `TurnSpan.outcome`。 */
export type TurnOutcome = "ok" | "stopped" | "failed";

/**
 * 这条 `result` 是不是「本轮被中断」（用户按停止、进程被结束、子代理被中断）。
 *
 * `normalize.applyResult` 已经把中断的诊断 result 改写成 `subtype: "interrupt"` 且
 * `isError: false`（见那里的注释），所以这里只认 subtype，**不要**再按 isError 猜：
 * 上游真报错的 result 也带 isError，两者必须分开。
 */
export function isStopResult(result: Item): boolean {
  if (result.kind !== "result") return false;
  const sub = (result.subtype ?? "").toLowerCase();
  return sub.includes("interrupt") || sub.includes("abort") || sub.includes("cancel");
}

/**
 * 思考与工具调用都是「过程」，正文回答与用户消息不是。
 *
 * 已作答的模型提问**两层都要**：步骤留在过程里（「提问 · 已回答」，点开是完整的选项
 * 卡片——那是「模型问过什么」的记录），同时在正文流里再挂一枚问答气泡
 * （`AskReplyBubble`，那是「我答了什么」）。所以这条判断对提问照常返回 true，
 * 气泡由 `MessageList` 另外从同一个 Item 派生，**别为了气泡把它从过程里摘出去**。
 */
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
  // **只看本回合**（最后一条 result 之后）：一轮被中断时，它的工具永远等不到
  // tool_result，`result` 就一直是 undefined。不划边界的话，从那一刻起每一轮都会
  // 被判成「有工具在跑」——组头一直显示一个早就不会返回的命令，而 ChatPane 用
  // 这个判定来决定要不要提示「上游多久没出声」，于是沉默提示也永久失效（实测
  // 中断过一个 Bash 之后，后面所有会话的沉默提示都不再出现）。
  //
  // 中断前那些工具卡片本身照旧显示（它们确实没返回，那是事实），这里只回答
  // 「现在还有东西在跑吗」。
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === "result") return undefined;
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
 * 一轮之内，**最终回答**前面要不要加一条分隔线。
 *
 * 场景：模型说完一段过渡正文（「我先看一下这个文件」），接着又是思考与工具调用，
 * 最后给出真正的回答。两者之间没有任何视觉边界，读起来像同一段话被截成两截，
 * 也看不出后半截才是结论。
 *
 * **只给最后一段画，而且只画一条**。过程收起之后，一轮里的过渡正文会全部连在一起
 * （思考与工具被折成了上面那一行「已完成」），逐段加线就是满屏横线——那是噪音，
 * 不是分界。真正需要分开的只有「过程之前说的话」和「过程之后得出的结论」。
 *
 * 规则（只看轮内**可见的正文段**）：
 *   - 只有一段正文 → 不画（纯问答不需要边界）；
 *   - 最后一段前面**没有跨过过程** → 不画（上游把一条回复拆成多个 text 块很常见，
 *     凭空多一道线会显得像另起了一轮）；
 *   - 否则给**最后一段**画一条。
 *
 * `hidden` 是「仅最终回答」档下被藏掉的回复 id：它们不占渲染位置，也不该参与
 * 判断——否则会算出一段看不见的「前文」，给真正的那一段多挂一条线。
 *
 * `settled` 是「这一轮已经结束了」（见 `TurnSpan.finished`）。**没结束就一条都不画**：
 * 跑到一半时，最后一段正文只是「此刻说到哪」，模型随时会接着说下去。按当前最后一段
 * 画线，线就会挂在过渡正文上（截图复现过：思考过程上方那条横线），等真正的结论来了
 * 又跳下去——看起来像凭空多了一轮，比没有线更乱。最终回答只在一轮收尾之后才成立。
 *
 * 返回需要加线的正文 item id 集合（至多一个元素）。
 */
export function replyDividerIds(done: Item[], hidden?: Set<string>, settled = true): Set<string> {
  // 这一轮还在跑：没有「最终回答」可言，不画。
  if (!settled) return new Set();
  // 先挑出这一轮可见的正文段：只留非空 assistant，且跳过被「仅最终回答」藏掉的。
  const replies: string[] = [];
  // 每一段正文之前「有没有出现过过程」——与 replies 一一对应。
  const hadProcessBefore: boolean[] = [];
  let crossed = false;
  for (const item of done) {
    if (isProcessItem(item)) {
      crossed = true;
      continue;
    }
    if (item.kind !== "assistant" || !item.text.trim()) continue;
    if (hidden?.has(item.id)) continue;
    replies.push(item.id);
    hadProcessBefore.push(crossed);
    crossed = false;
  }
  const out = new Set<string>();
  const last = replies[replies.length - 1];
  // 至少两段才有「过渡正文 / 最终回答」之分；最后一段之前跨过过程才画那一条。
  if (replies.length >= 2 && last && hadProcessBefore[hadProcessBefore.length - 1]) {
    out.add(last);
  }
  return out;
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
    // 轮锚点统一走 `isTurnHead`（插话不切轮；后台任务的唤醒通知**要**切轮，见 WakeItem）。
    if (isTurnHead(item) && index > 0) starts.push(index);
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

/**
 * 一轮里「谁拿复制按钮」以及「复制什么」。
 *
 * 判定只认**本条是不是这一轮最后一条有正文的回答**，并且**这一轮已经结束**：
 * 一轮跑着的时候最后一条正文只是半句话，给它一个复制按钮既没意义，又会跟着正文一起
 * 出现在过程中间（用户看到的就是「思考过程下面冒出一个复制按钮」）。
 *
 * 复制内容则是**整轮的正文输出**：按顺序把这一轮所有 assistant 正文拼起来（过渡正文
 * + 最终回答）。用户要的是「这一轮说了什么」；过渡正文在收起态下多半看不见，不带上
 * 就等于复制不全。**思考过程（thinking）不进复制内容**——那是推理，不是输出；CLI 包的
 * API 错误消息也不算正文。
 *
 * 返回 `undefined` 表示「这条不给复制入口」；否则返回它该复制的文本。
 * 纯函数：`items` 传一整轮的切片（`turnSpans` 的 `[start, end)`）。
 */
export function replyCopy(items: Item[], id: string, finished = true): string | undefined {
  if (!finished) return undefined;
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
 * 这条 `result` 是不是「插话交棒」留下的那条（不是这一轮真的结束）。
 *
 * **插话没赶上当前回合时，CLI 会把它留到下一轮**：先把被打断的这一段收尾（发 `result`），
 * 紧接着开新一轮跑插话。前端看到的顺序是「插话气泡（本地先落地）→ result → 新一轮的
 * init 与思考」，中间那条 result 就成了「最后一条内容之后有 result」——按它判结束的话，
 * 收起行会先闪一下「已完成」再被推翻（实测约 1 秒）。
 *
 * 判据：这条 `result` 之前**紧挨着**一条插话，中间什么内容都没有。插话之后还有回答 /
 * 思考 / 工具，就说明那一段真的跑完了（那一轮的活干完了），该收就收。
 *
 * **出错 / 被中断的 `result` 不算交棒**：那种情况下这一轮是真的停了，收起行该出来，
 * 耗时也该报。
 *
 * 纯函数，`resultIndex` 是这条 result 在同一个 `items` 里的下标。
 */
export function handoffResult(items: Item[], resultIndex: number): boolean {
  const result = items[resultIndex];
  if (result?.kind !== "result") return false;
  if (result.isError === true) return false;
  const sub = (result.subtype ?? "").toLowerCase();
  if (sub.includes("interrupt") || sub.includes("abort") || sub.includes("cancel")) return false;
  // 从 result 往前找第一条「有内容」的条目：必须是插话，中间隔着思考/工具/回答都不算。
  for (let i = resultIndex - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (isProcessItem(item) || item.kind === "assistant" || item.kind === "result") return false;
    if (item.kind === "user") return item.interjected === true;
  }
  return false;
}

/**
 * 把列表切成「轮」，并标出每轮的过程条目。
 *
 * 轮 = 两条用户消息之间的一段（与 `lib/turns.turnsOf` 同一套锚点）。**收起是轮级的**：
 * 一整轮的思考与工具调用一起收进轮首那一行，只剩正文输出；点开再按档位还原。
 * 所以这里要把每轮的过程条目单独捞出来——展开后的还原与「这一轮有没有过程可收」都靠它。
 *
 * **插话（`interjected`）不切轮**：它并进当前回合，不是新的一轮。按它切的话，一句话
 * 就把这一轮的思考与工具调用劈成两半，前半截被当成「已完成」收起来、后半截重新铺开。
 *
 * **插话可能落在 result 之后**：它没赶上当前回合时，CLI 会先把这一轮收尾（发 result）、
 * 再开一轮把它跑完。所以一段里的 result 不是「结束」的充分条件——result 之后还有过程，
 * 就说明这一段又跑起来了（见 `finished`）。
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
    if (isTurnHead(item) && index > 0) heads.push(index);
  });
  const bounds = [...heads, items.length];
  for (const end of bounds) {
    const process: Item[] = [];
    /** 最后一条「有内容的」条目与最后一条 result 的下标：判断收尾之后有没有再跑起来。 */
    let lastActivity = -1;
    /** 第一条「有内容」的条目：拿不到 result 时长时按它和 lastActivity 的时间戳算耗时。 */
    let firstActivity = -1;
    let lastResult = -1;
    let durationMs: number | undefined;
    /**
     * 本段最后一条 result 给出的结局（正常 / 被中断 / 出错）。
     *
     * 一段里可能有多条 result（插话把它拆成几个子回合），**最后一条**决定这一轮怎么
     * 收场——前面几条只是子回合的收尾，后面还在继续跑。
     */
    let ending: TurnOutcome = "ok";
    for (let i = start; i < end; i += 1) {
      const item = items[i];
      if (isProcessItem(item)) {
        process.push(item);
        lastActivity = i;
      } else if (item.kind === "assistant" && item.text.trim() !== "") {
        lastActivity = i;
      } else if (item.kind === "user") {
        // 段内只剩插话这一种 user（非插话的都已切轮）：它也算「有内容」，
        // 后面紧跟的 result 属于交棒，见 handoffResult。
        lastActivity = i;
      } else if (item.kind === "wake") {
        // 轮首那条唤醒通知：它是这一段的起点，也算「有内容」——不然只有通知、
        // 还没吐出正文的那一瞬会被判成「最后一条内容之后没有 result」的空段。
        lastActivity = i;
      } else if (item.kind === "result") {
        lastResult = i;
        ending = isStopResult(item) ? "stopped" : item.isError ? "failed" : "ok";
        // 一段里可能有多条 result（插话把它拆成了几个子回合），整轮耗时按它们累加。
        if (typeof item.durationMs === "number") durationMs = (durationMs ?? 0) + item.durationMs;
      }
      if (lastActivity === i && firstActivity < 0) firstActivity = i;
    }
    // 只有**最后一轮**才可能还在跑：前面的轮次后面已经开了新一轮，必然结束。
    // 转录回放里没有 result 行，按「会话在不在跑」一刀切的话，历史轮次会全被判成
    // 进行中——整段历史的思考与工具都摊在外面，而会话明明正在跑最新那一轮。
    const isTail = end === items.length;
    // 结束的判据是「**最后一条内容之后**有 result」，不是「本段里有 result」：插话
    // 没赶上当前回合时，CLI 先发 result 收尾、再开一轮跑插话，那之后的内容属于仍在
    // 进行的部分。按「有 result 就算结束」的话，插话之后的思考与工具会连同前半截
    // 一起被收进「已完成」那一行（用户看到的是「插了一句，后面的思考突然折起来了」）。
    //
    // 而「插话之后**没有**任何回答就来了一条 result」是交棒，不是收尾：CLI 把插话留到
    // 下一轮了，那条 result 只是给被插话打断的这一段作个了结。按结束处理的话，收起行
    // 会先闪一下「已完成」再被新一轮的内容推翻（实测约 1 秒）。
    const handoff = lastResult > lastActivity && handoffResult(items, lastResult);
    const settledByResult = !handoff && lastResult >= 0 && lastResult > lastActivity;
    // 一条 result 都没有（转录回放）时才看会话状态。
    const settledByState = lastResult < 0 && !running;
    // **交棒只在尾轮才作数**：交棒说的是「这一轮没完，CLI 接着把插话当下一轮跑」，
    // 而后面已经开了新的一轮（`!isTail`）就说明这一段确实收尾了——再判成「还在跑」
    // 会让它永远收起不了，界面上那一段的过程一直摊着。实测：插话交棒之后用户又发了
    // 一句，前面那段的「已完成」就再也不出现。
    const finished = !isTail ? true : handoff ? false : settledByResult || settledByState;
    // **转录回放没有 result 行**（claude 只把 result 写 stdout），`durationMs` 在那里
    // 永远是 undefined——「重进前端，已完成右边的用时全丢了」就是这么来的。回放的条目
    // 带着转录里的时间戳，所以退一步按这一轮的首尾两条活动消息自己算：
    //   - 只给**已结束**的轮：还在跑的那一轮的耗时是「此刻说到哪」，没有意义；
    //   - 差值不足 1 秒不报（同一条消息被拆成多行时时间戳会撞在一起，显示「用时 0 秒」
    //     像 bug）。真·结果里 `result.duration_ms` 是 CLI 的权威口径，有就优先用它。
    if (finished && durationMs === undefined && firstActivity >= 0 && lastActivity > firstActivity) {
      const from = items[firstActivity].ts;
      const to = items[lastActivity].ts;
      if (Number.isFinite(from) && Number.isFinite(to) && to - from >= 1000) durationMs = to - from;
    }
    spans.push({
      start,
      end,
      process,
      finished,
      outcome: finished ? ending : "ok",
      durationMs,
    });
    start = end;
  }
  return spans;
}
