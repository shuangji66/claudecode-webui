// `/` 指令补全的匹配与排序（纯函数）。
//
// 与 `@` 文件引用分开：`/` 只在一**整条**正文都是 `/名字` 时成立（敲出空格就是
// 「我要发这条指令了」，菜单必须让位），而 `@` 是光标处的一个 token，后面还能接正文。
//
// 排序是这里唯一的判断：CLI 给的顺序带着它自己的相关性，但它不知道用户正在敲什么。
// 前缀命中一定要排在全量列表前面——`/co` 想找的是 `compact`，而 `cost-report` 这种
// 子串命中排在它前面时，用户只能一路往下翻。

import type { CommandInfo } from "../transport/types";

/** 正文是不是「一条正在输入的 `/ 指令」；是就返回去掉 `/` 的查询串。 */
export function commandQuery(text: string): string | undefined {
  // `\S*` 顺带把空格、换行、Tab 都挡掉：`/compact ` 已经是在发指令了。
  return /^\/(\S*)$/u.test(text) ? text.slice(1) : undefined;
}

/**
 * 过滤候选：前缀命中优先，其次子串命中，两组各自保持 CLI 给的顺序。
 *
 * 空查询返回**全部**指令：`+` 菜单的「指令」分组列的就是这一份，两个入口看到的
 * 集合必须一致，否则用户会以为某条指令只在其中一个地方存在（曾经 `/` 菜单截到
 * 前 8 条就是这个现象）。
 */
export function matchCommands(commands: CommandInfo[], text: string): CommandInfo[] {
  const query = commandQuery(text);
  if (query === undefined) return [];
  const q = query.toLowerCase();
  if (q === "") return commands;
  const prefix: CommandInfo[] = [];
  const substring: CommandInfo[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(command);
    else if (name.includes(q)) substring.push(command);
  }
  return [...prefix, ...substring];
}
