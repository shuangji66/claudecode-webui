// 技能导入的纯函数：从文件名/相对路径推断技能名、判断文件是不是技能、名字合法性。
//
// 「导入」有两条来源：浏览器里挑的文件（内容在手里）、飞牛选择器挑的 NAS 路径
// （内容由后端读）。两条都要先回答同一个问题——这条东西叫什么叫什么名，
// 所以规则放在 lib 里，组件只做展示，测试也只测这里。

/** claude 的技能文件名（大小写不敏感，与后端 skills.readSkillSource 一致）。 */
export const SKILL_FILE = "SKILL.md";

/** 一次导入的来源数量上限，与后端 skills.MaxImport 对齐。 */
export const MAX_IMPORT = 50;

/** 去掉路径末尾的分隔符（浏览器给的是 POSIX 风格相对路径）。 */
function trimPath(p: string): string {
  return p.replace(/[\\/]+$/, "");
}

function baseName(p: string): string {
  const clean = trimPath(p);
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

/** 去掉 `.md` / `.markdown` 扩展名（大小写不敏感）。 */
export function stripMarkdownExt(name: string): string {
  return name.replace(/\.(md|markdown)$/i, "");
}

/**
 * 从文件名或相对路径推断技能名。
 *
 * - `alpha/SKILL.md` → `alpha`（选中文件夹时最常见）
 * - `my-skill.md` → `my-skill`
 * - 光秃秃的 `SKILL.md`（普通文件选择，没有目录信息）→ 空串：叫不出名字，
 *   由用户在清单里自己填，不要瞎猜成 `SKILL`。
 */
export function skillNameFromPath(path: string): string {
  const clean = trimPath(path);
  const base = baseName(clean);
  if (base.toLowerCase() === SKILL_FILE.toLowerCase()) {
    const dir = clean.slice(0, clean.length - base.length).replace(/[\\/]+$/, "");
    return dir === "" ? "" : baseName(dir);
  }
  return stripMarkdownExt(base);
}

/**
 * 这个文件值不值得列进待导入清单。
 *
 * `fromFolder` 为真时（选的是文件夹）只收 SKILL.md：一个技能目录里还有
 * README、脚本、示例，全列出来会让清单没法看。直接选文件时放宽到任意
 * `.md`——用户可能把技能写在 `my-skill.md` 里。
 */
export function isSkillFile(name: string, fromFolder: boolean): boolean {
  const base = baseName(name);
  if (fromFolder) return base.toLowerCase() === SKILL_FILE.toLowerCase();
  return /\.(md|markdown)$/i.test(base);
}

/**
 * 技能名能不能当目录名。与后端 `skills.ValidName` 同一套规则（长度按字节算，
 * 后端用的是 `len(name)`）：只挡路径穿越、隐藏目录与让 claude 静默不加载的字符。
 */
export function validSkillName(name: string): boolean {
  if (name === "" || name === "." || name === "..") return false;
  if (name.startsWith(".")) return false;
  if (/[/\\<>]/.test(name)) return false;
  const bytes = new TextEncoder().encode(name).length;
  if (bytes > 64) return false;
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || code === 0x200b || code === 0xfeff) return false;
  }
  return true;
}

/** 一份待导入条目：本地文件带内容，飞牛路径只带路径。 */
export interface ImportDraft {
  /** 前端内部 key（同名条目也能分别删除）。 */
  id: string;
  name: string;
  /** 字节数，清单里显示「多大」；飞牛路径未知时是 0。 */
  size: number;
  kind: "local" | "path";
  content?: string;
  path?: string;
}
