// 飞牛「已授权目录」页的纯函数。
//
// 唯一一件事：某个路径是不是「应用自己的目录」，界面据此不给撤销按钮。
// 判定规则必须与后端 `gateway.protectedConflict` 一致——命中「等于 / 是它的祖先 /
// 在它里面」都算受保护：撤销父目录同样会让应用的安装目录失去 ACL，只靠前端比对
// 相等会在这种情形下摆出一颗点了就报错的删除按钮（后端仍然会挡，但那是失败而不是
// 界面上的「这里不能删」）。

/** 去掉尾部斜杠；空串保持空（调用方据此提前返回）。 */
function trimSlash(p: string): string {
  return p.replace(/\/+$/, "");
}

/**
 * path 是否命中受保护目录（等于 / 在其下 / 在其上）。
 *
 * 只做字符串比较：受保护路径在后端是 `EvalSymlinks` 之后的真实路径，界面拿到的
 * 授权目录也是飞牛给的绝对路径，符号链接解析不在这里重复一次。
 */
export function isProtectedDir(path: string, protectedDirs: readonly string[]): boolean {
  const target = trimSlash(path.trim());
  if (!target) return false;
  return protectedDirs.some((raw) => {
    const guard = trimSlash(raw.trim());
    if (!guard) return false;
    return target === guard || target.startsWith(`${guard}/`) || guard.startsWith(`${target}/`);
  });
}
