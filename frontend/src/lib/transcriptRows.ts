// 转录行层面的判定：哪些 user 行是「用户的提问」，哪些是 CLI 自己塞进来的。
//
// 为什么单独一个模块：`normalize.ts`（渲染）与 `usage.ts`（用量）都需要这套判断，
// 而 `normalize.ts` 已经 import 了 `usage.ts`——放在任一边都会成环。这里的依赖只有
// `continuation.ts`（压缩续接提示的文本切分），是纯函数、无副作用。
//
// 两份实现曾经各自漂移：`usage.ts` 只挡了 tool_result 与本地命令回显，`normalize.ts`
// 还挡了任务通知、附图注解、中断标记。同一条 `<task-notification>` 行在前者算「一轮的
// 开始」（把上一轮的 token 结算掉）、在后者不算——想清楚一件事要在两个文件里各看一遍。
// 现在只有这里一份。

import { isInjectedUserRow, splitContinuation } from "./continuation";

// ---------------------------------------------------------------------------
// 单行文本判定
// ---------------------------------------------------------------------------

// localCommandEchoRE 匹配「本地斜杠命令的回显」：claude CLI 把 /model、/clear 这类
// 本地命令的输入与输出当作 user 消息写进会话流，界面里会把它们渲染成用户气泡
//（例如 `<local-command-stdout>Set model to `x`</local-command-stdout>`）。
// 这些不是用户说的话，切模型在设置页已经能表达，所以整条丢弃。
//
// 只认「整条消息就是这些标签」的形态：用户正文里恰好提到 `<command-name>` 时，
// 前后还有自己的文字，不会命中。
const localCommandEchoRE =
  /^<(local-command-(?:stdout|stderr)|local-command-caveat|command-name|command-message|command-args)[\s\S]*<\/?(?:local-command-(?:stdout|stderr|caveat)|command-(?:name|message|args))>\s*$/;

/** 判断一条文本是否是本地斜杠命令的回显（应整条忽略）。 */
export function isLocalCommandEcho(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("<")) return false;
  return localCommandEchoRE.test(t);
}

// 后台命令 / 子代理结束时，CLI 会往对话里写一条**普通 user 行**：
//
//	<task-notification>
//	<task-id>…</task-id><status>killed</status><summary>…</summary>
//	…
//	</task-notification>
//
// 它是**系统注入的状态通知**，不是用户说的话：渲染成用户气泡，界面里就多出一坨
// 原始 XML（实测「停掉后台命令再重进前端」时会看到），而且它会让轮次计数多一格。
// `isMeta` 在这里是 null 而不是 true，绕过了 applyCLI 顶上那道 meta 过滤。
//
// 只认「整条消息就是这一个块」：用户正文里贴了这段 XML 时前后还有自己的文字，
// 不会命中。后端 `history.isTaskNotification` 是同一条规则的镜像（两边都要改）。
const taskNotificationRE = /^<task-notification>\s*<task-id>[\s\S]*<\/task-notification>$/;

/** 判断一条文本是否是 CLI 注入的后台任务通知。 */
export function isTaskNotification(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("<task-notification>")) return false;
  return taskNotificationRE.test(t);
}

// 附图注解：用户发图时 CLI 会额外写一行 `[Image: source: /tmp/…/1.png]`（还带
// `original 2748x1542, displayed at 2000x1122. Multiply coordinates by 1.37 …`），
// 把尺寸与换算系数告诉模型。**它只是给模型的坐标系说明，不是用户说的话。**
//
// 转录里这一行带 `isMeta: true` + `turnCompanion: true`，applyCLI 顶上那一道
// 就能挡住；但**实时流上的同一帧没有 `isMeta`**（实测 2.1.330：`{type:"user",
// message:{content:[{type:"text",text:"[Image: original 2042x1406, …]"}]}}`，
// 没有 isMeta、没有 turnCompanion），于是它被当作用户消息插了一个气泡——用户看到
// 的就是「预览图片时，图片突然变成了一串消息」。
//
// 判据只看**整条消息就是这些注解**：用户可以自己打一句以 `[Image:` 开头的话，
// 但那时后面还有他自己的正文，且不会以 `]` 恰好收在注解格式上。一条消息里可能
// 连着好几个（多图），所以用 `*` 匹配整串。
const imageAnnotationRE =
  /^(?:\[Image: (?:source: [^\]]+|original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by [\d.]+ to map to original image\.)\])+$/;

/** 判断一条文本是否只是 CLI 的附图注解。 */
export function isImageAnnotation(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("[Image:")) return false;
  return imageAnnotationRE.test(t);
}

// CLI 的「本轮被中断」标记（`[Request interrupted by user]` 之类）。
//
// 早期版本用的是宽得多的正则
//（2.1.327 的 `/^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/`），
// 只认「整条消息就是标记」的形态，用户正文里顺口提到这句话不会命中。
const interruptMarkerRE = /^\[(?:Request interrupted|Agent call interrupted)(?: by user|:)[^\]]*\]$/;

/** 判断一条用户文本是否是 CLI 的「本轮被中断」标记。 */
export function isInterruptMarker(text: string): boolean {
  return interruptMarkerRE.test(text.trim());
}

// ---------------------------------------------------------------------------
// 整行判定
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => str((b as Record<string, unknown> | undefined)?.text)).join("");
}

/**
 * 这条 user 行是用户的提问（一轮的开始），而不是工具回包 / 命令回显 / CLI 注入。
 *
 * 只发了图片或 PDF 的提问没有 text 块，但它照样是「一轮的开始」：不认的话这一轮的
 * 用量会被并进上一轮。
 */
export function isPromptRow(line: Record<string, unknown>): boolean {
  // 压缩后塞回上下文的摘要不是用户的话，不能当一轮的开始。
  if (isInjectedUserRow(line)) return false;
  const content = (line.message as Record<string, unknown> | undefined)?.content;
  if (Array.isArray(content)) {
    if (content.some((b) => (b as Record<string, unknown> | undefined)?.type === "tool_result")) return false;
    if (
      content.some((b) => {
        const type = (b as Record<string, unknown> | undefined)?.type;
        return type === "image" || type === "document";
      })
    ) {
      return true;
    }
  }
  const text = splitContinuation(contentText(content)).rest;
  if (text.trim() === "") return false;
  return (
    !isLocalCommandEcho(text) &&
    !isInterruptMarker(text) &&
    !isTaskNotification(text) &&
    !isImageAnnotation(text)
  );
}

/**
 * 一轮「还没收尾」时落下的 `stop_reason`。
 *
 * CLI 每轮收尾必定写一条带终止 stop_reason 的 assistant 行（纯思考回合也一样，
 * 实测 178 条只有 thinking 块的 `end_turn`），工具循环里的那条是 `tool_use`。
 *
 * **缺失值按「已收尾」处理**：老转录、被裁剪的片段、以及测试夹具里常没有这个字段，
 * 当成「还在跑」会让后面每一句提问都被误判成插话（一轮永远开不完）。宁可少认几个
 * 插话（退化成现在的两段），也不要把整份历史都折进一轮。
 */
const OPEN_STOP = new Set(["tool_use", "pause_turn"]);

/**
 * 转录里哪些行是**插话**（`priority=now`），返回它们在 `lines` 里的下标。
 *
 * 实时路径靠本地记的 `priority` 与后端广播的 `prompt.echo`（`interjected`）标出来，
 * 但**转录里这两样都没有**：实测 2.1.330 一份含插话的 jsonl 里，插话那行与普通提问行
 * 的字段完全一致（`origin: {kind:human}` / `turnOrigin: human` / `turnPosition`），
 * 全库 grep `priority` 一条都搜不到。于是重进前端时它被当成新一轮的起点，把整轮劈成
 * 两半——前半截收进「已完成」、后半截重新铺开，轮次刻度还多一格（截图复现过）。
 *
 * 能认的依据是**它落在哪**：一轮从用户提问开始，到某条 assistant 的终止性
 * `stop_reason` 为止。这一段之间出现的用户提问，只可能是「这一轮还没跑完就发进来的」，
 * 也就是插话。插入的位置就是它被并进当前回合的那一刻——与实时路径的观感一致。
 *
 * 注入行（任务通知 / 附图注解 / 中断标记）既不算提问，也不改变这一轮的开合状态；
 * 中断标记单独把这一轮关掉（CLI 之后要先有新的提问才重新开）。
 *
 * **窗口里第一条提问永远不算插话**：转录被截断到最近 20k 行时，开头可能正好落在某一轮
 * 的中间，那一轮的提问已经不在窗口里了——不豁免的话，窗口里出现的第一句用户提问就会被
 * 当成插话挂在上一轮后面，历史从此少一格轮次刻度。截断是既成事实，那条提问在界面上
 * 就该是一轮的开头（`seenPrompt` 就是干这个的）。
 */
export function interjectedPromptRows(lines: unknown[]): Set<number> {
  const out = new Set<number>();
  let open = false;
  /** 窗口里出现过用户的提问没有：第一次出现一定是新的一轮。 */
  let seenPrompt = false;
  lines.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const line = raw as Record<string, unknown>;
    if (line.isSidechain === true || line.isMeta === true) return;
    const type = str(line.type);
    if (type === "assistant") {
      const message = line.message as Record<string, unknown> | undefined;
      // `stop_reason` 缺失时按「已收尾」：见 OPEN_STOP 上的注释。
      open = OPEN_STOP.has(str(message?.stop_reason));
      return;
    }
    if (type === "result") {
      open = false;
      return;
    }
    if (type !== "user") return;
    if (isInterruptMarker(contentText((line.message as Record<string, unknown> | undefined)?.content))) {
      open = false;
      return;
    }
    if (!isPromptRow(line)) return;
    if (open && seenPrompt) out.add(index);
    open = true;
    seenPrompt = true;
  });
  return out;
}
