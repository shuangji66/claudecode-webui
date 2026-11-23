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
 * 转录里哪些行是**插话**，返回它们在 `lines` 里的下标。
 *
 * 数据来源是**宿主机记账**，不是推断：`--replay-user-messages` 让 CLI 把我们写进
 * stdin 的消息原样回显，帧上带 `isReplay:true` 与**我们给的那个 uuid**；后端认出
 * 命中登记的 uuid 就写进 `<session>/interjections.jsonl`（见
 * `session.KindInterjection` / `history.AppendInterjection`），回放时随转录下发
 * `interjected_uuids`。这里只做「uuid → 行下标」的映射。
 *
 * **不要退回任何启发式**。曾经按「一轮 = 提问 → 终止性 stop_reason，中间出现的提问
 * 就是插话」来认，在本机 162 份真实转录上 **14 条判定全部是误判、真插话 0 条**：
 * 排队投递（回合中按 Enter，回合结束后自动投递）的形状与插话一模一样——两者都有
 * `queue-operation enqueue/dequeue`、都有全新的 `turnPosition`、都是
 * `origin:{kind:human}`。实测 2.1.330 起一个真 `priority=now` 会话对比确认：
 * 两条 user 行的字段集合完全相同（18/18），转录里**不存在**任何区分信息。
 *
 * 误判的代价很重：两轮被折成一整轮，耗时与用量相加（实测一段变成 43 分钟），
 * 而且「仅最终回答」那一档会按合并后的轮切，把上一轮真正的结论藏掉。
 *
 * 老会话没有那份记账文件，返回空集合——那时插话会被当成新一轮。这是刻意的取舍：
 * 少认一次插话只是观感退化成两段，误判一次却会吞掉一整轮的回答。
 */
export function interjectedPromptRows(lines: unknown[], uuids?: readonly string[]): Set<number> {
  const out = new Set<number>();
  if (!uuids || uuids.length === 0) return out;
  const want = new Set(uuids);
  lines.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const uuid = str((raw as Record<string, unknown>).uuid);
    if (uuid && want.has(uuid)) out.add(index);
  });
  return out;
}
