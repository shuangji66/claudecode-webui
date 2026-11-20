// `/` 指令补全的匹配与排序（纯函数）。
//
// 与 `@` 文件引用分开：`/` 只在一**整条**正文都是 `/名字` 时成立（敲出空格就是
// 「我要发这条指令了」，菜单必须让位），而 `@` 是光标处的一个 token，后面还能接正文。
//
// 排序是这里唯一的判断：CLI 给的顺序带着它自己的相关性，但它不知道用户正在敲什么。
// 前缀命中一定要排在全量列表前面——`/co` 想找的是 `compact`，而 `cost-report` 这种
// 子串命中排在它前面时，用户只能一路往下翻。

import type { CommandInfo } from "../transport/types";

/**
 * 这份命令清单里哪些是**给用户看的**。
 *
 * CLI 的 `initialize` 回包会带上它自己 `isHidden: true` 的内部命令（2.1.329 实测：
 * `__remote-workflow`，描述写着 "server-launched sessions only"，
 * `workflow-launch-exec` 同属一类）。它们只该由服务端下发的会话调用，用户在这边
 * 敲出来要么被拒、要么做一件与当前会话无关的事。
 *
 * `__` 前缀是 CLI 自己的内部分界（它的命令注册表里带这个前缀的就是隐藏项），
 * 我们照着这条规则过滤，不维护第二份名单——那份清单随版本漂移，硬编码必然过期。
 *
 * **两个入口共用这一份**：`/` 补全与 `+ → 指令` 看到的集合必须一致，否则用户会
 * 以为某条指令只在其中一个地方存在。
 */
export function userCommands(commands: CommandInfo[]): CommandInfo[] {
  return commands.filter((c) => !c.name.startsWith("__"));
}

/** 正文是不是「一条正在输入的 `/ 指令」；是就返回去掉 `/` 的查询串。 */
export function commandQuery(text: string): string | undefined {
  // `\S*` 顺带把空格、换行、Tab 都挡掉：`/compact ` 已经是在发指令了。
  return /^\/(\S*)$/u.test(text) ? text.slice(1) : undefined;
}

/**
 * 过滤候选：前缀命中优先，其次子串命中，两组各自保持 CLI 给的顺序。
 *
 * 空查询返回**全部**（用户可见的）指令：`+` 菜单的「指令」分组列的就是这一份，
 * 两个入口看到的集合必须一致，否则用户会以为某条指令只在其中一个地方存在（曾经
 * `/` 菜单截到前 8 条就是这个现象）。
 */
export function matchCommands(commands: CommandInfo[], text: string): CommandInfo[] {
  const query = commandQuery(text);
  if (query === undefined) return [];
  const visible = userCommands(commands);
  const q = query.toLowerCase();
  if (q === "") return visible;
  const prefix: CommandInfo[] = [];
  const substring: CommandInfo[] = [];
  for (const command of visible) {
    const name = command.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(command);
    else if (name.includes(q)) substring.push(command);
  }
  return [...prefix, ...substring];
}
