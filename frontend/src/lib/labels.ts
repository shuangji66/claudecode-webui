// 展示层的小型纯函数：会话标题、相对时间、模式名。
import type { Item } from "./model";
import { tr } from "./i18n";
import type { Locale } from "./i18n";

export function baseName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function truncate(s: string, n: number): string {
  const r = Array.from(s.replace(/\s+/g, " ").trim());
  return r.length > n ? `${r.slice(0, n).join("")}…` : r.join("");
}

/** 会话标题：优先用第一条用户消息，没有就用工作区目录名。 */
export function sessionTitle(cwd: string, items: Item[] | undefined, locale: Locale = "zh"): string {
  const first = items?.find((i) => i.kind === "user" && i.text.trim());
  if (first && first.kind === "user") return truncate(first.text, 48);
  return baseName(cwd) || tr(locale, "新会话", "New session");
}

/** 对话标题：自定义标题 > 首条用户消息 > “新对话”。 */
export function conversationTitle(
  title: string | undefined,
  items: Item[] | undefined,
  locale: Locale = "zh",
): string {
  const custom = title?.trim();
  if (custom) return custom;
  const first = items?.find((i) => i.kind === "user" && i.text.trim());
  if (first && first.kind === "user") return truncate(first.text, 48);
  return tr(locale, "新对话", "New chat");
}

/** 相对时间；传 now 便于测试。 */
export function relativeTime(iso: string | undefined, now = Date.now(), locale: Locale = "zh"): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return tr(locale, "刚刚", "just now");
  if (min < 60) return tr(locale, `${min} 分钟前`, `${min} min ago`);
  const hours = Math.floor(min / 60);
  if (hours < 24) return tr(locale, `${hours} 小时前`, `${hours} h ago`);
  const days = Math.floor(hours / 24);
  if (days < 7) return tr(locale, `${days} 天前`, `${days} d ago`);
  return new Date(t).toLocaleDateString(locale === "en" ? "en-US" : "zh-CN", { month: "numeric", day: "numeric" });
}

/** 消息时间 HH:mm。 */
export function clockTime(ts: number, locale: Locale = "zh"): string {
  if (!Number.isFinite(ts)) return "";
  return new Date(ts).toLocaleTimeString(locale === "en" ? "en-US" : "zh-CN", { hour: "2-digit", minute: "2-digit" });
}

const MODE_LABELS: Record<string, string> = {
  default: "默认模式",
  acceptEdits: "接受编辑",
  plan: "计划模式",
  dontAsk: "不询问",
  bypassPermissions: "跳过权限",
};

export function permissionLabel(mode: string | undefined, locale: Locale = "zh"): string {
  // 空值表示「没显式指定」，CLI 的行为就是 default：菜单里不再单列一项，
  // 显示上也统一成「默认模式」，免得出现「标准模式 / 默认模式」两个同义词。
  const key = mode || "default";
  if (locale === "en") {
    const en: Record<string, string> = {
      default: "Default",
      acceptEdits: "Accept edits",
      plan: "Plan",
      dontAsk: "Don't ask",
      bypassPermissions: "Bypass permissions",
    };
    return en[key] ?? key;
  }
  return MODE_LABELS[key] ?? key;
}

export function stateLabel(state: string | undefined, locale: Locale = "zh"): string {
  switch (state) {
    case "busy":
      return tr(locale, "运行中", "Running");
    case "starting":
      return tr(locale, "启动中", "Starting");
    case "ready":
      return tr(locale, "空闲", "Idle");
    case "closed":
      return tr(locale, "已关闭", "Closed");
    default:
      return tr(locale, "未连接", "Disconnected");
  }
}

/**
 * 内置斜杠命令（含 Claude Code 自带的 skill）的简短中文说明。
 *
 * CLI 自带的 description 是英文长句（有些还带参数说明），塞进菜单里只能看到
 * 「Use this skill wheneve…」。这里给一句中文短说明，**没收录的回落到 CLI 原文**
 * （用户自己写的 skill / 插件 / MCP 命令本来就没有中文，英文环境下也该用原文）。
 *
 * 名字清单随 claude 版本漂移（会新增、也会下线），所以这张表只是「尽力覆盖」，
 * 不要为了补全去猜某个命令的语义——不确定就留空，让它回落原文。
 */
const COMMAND_LABELS: Record<string, string> = {
  // 会话与上下文
  clear: "清空当前会话",
  new: "清空当前会话",
  reset: "清空当前会话",
  compact: "压缩对话上下文",
  autocompact: "配置自动压缩上下文",
  context: "查看上下文占用",
  rename: "重命名当前会话",
  branch: "从当前对话分出新分支",
  fork: "复制到后台新会话继续",
  btw: "旁路提问，不进主对话",
  recap: "一句话回顾当前会话",
  resume: "恢复历史对话",
  continue: "恢复历史对话",
  rewind: "回退到之前的状态",
  undo: "回退到之前的状态",
  export: "导出对话",
  copy: "复制上一条回复",
  exit: "退出会话",
  help: "查看帮助",
  status: "查看会话状态",
  usage: "查看用量",
  cost: "查看用量与花费",
  stats: "查看用量统计",
  "release-notes": "查看更新日志",
  bug: "反馈问题",
  feedback: "发送产品反馈",
  insights: "生成使用报告",
  "team-onboarding": "生成团队上手指南",

  // 模型与渲染
  model: "切换本会话模型",
  effort: "设置推理强度",
  fast: "切换快速模式",
  plan: "切换计划模式",
  "output-style": "切换输出风格",
  statusline: "配置状态栏",
  keybindings: "配置快捷键",
  vim: "切换 vim 编辑模式",

  // 配置与扩展
  config: "打开配置",
  settings: "打开设置",
  init: "生成项目说明文件",
  memory: "编辑记忆文件",
  permissions: "管理权限规则",
  hooks: "管理钩子",
  mcp: "管理 MCP 服务",
  plugin: "管理插件",
  skills: "管理技能",
  "reload-plugins": "重新加载插件",
  "reload-skills": "重新加载技能",
  "add-dir": "添加可访问目录",
  cd: "切换会话工作目录",
  sandbox: "配置沙箱",
  import: "导入其他工具的配置",
  "privacy-settings": "隐私设置",
  upgrade: "升级 Claude Code",
  "setup-bedrock": "配置 Bedrock 接入",
  "setup-vertex": "配置 Vertex 接入",

  // 账号、宿主与设备
  login: "登录账号",
  logout: "退出登录",
  ide: "管理 IDE 集成",
  chrome: "配置浏览器集成",
  "claude-in-chrome": "在浏览器里执行任务",
  desktop: "在桌面端继续会话",
  mobile: "在手机端继续会话",
  "install-github-app": "安装 GitHub App",
  "install-slack-app": "安装 Slack App",

  // 子代理与后台
  agents: "管理子代理",
  "list-agents": "列出子代理",
  subtask: "派一个子任务给子代理",
  tasks: "查看后台任务",
  goal: "设置持续目标",
  doctor: "环境自检",
  checkup: "环境自检",

  // 代码改动
  review: "审查改动",
  "code-review": "审查改动，找真 bug",
  "security-review": "审查改动的安全问题",
  simplify: "精简改动过的代码",
  verify: "跑起来确认改动生效",
  run: "启动项目实际跑一遍",
  "run-skill-generator": "生成项目启动/验证技能",
  diff: "查看工作区改动",
  // 2.1.91 已下线，老版本还会列出来
  "pr-comments": "拉取 PR 评论",
  batch: "拆成多份并行改造",
  loop: "按间隔重复跑同一指令",
  proactive: "按间隔重复跑同一指令",
  "fewer-permission-prompts": "生成权限白名单，少弹审批",
  debug: "打开调试日志排查问题",
  "skill-doctor": "查看技能上下文开销",
  todos: "查看待办",

  // 自带 skill 与工作流
  "deep-research": "多路检索并出带引用的报告",
  dataviz: "图表与看板设计指导",
  design: "出界面草图和流程图",
  "design-login": "授权设计系统访问",
  "design-sync": "把设计系统同步给 Claude Design",
  slides: "生成演示文稿",
  "claude-api": "Claude API 参考资料",
  "plugin-authoring": "插件开发参考",
  "workflow-authoring": "动态工作流编写参考",
  "artifact-capabilities": "成果页可用能力参考",
  "artifact-diagramming": "成果页画图指导",
};

/** 命令在菜单里的一句说明：中文优先，没收录的用 CLI 自带描述（由 UI 截断）。 */
export function commandDescription(name: string, description: string | undefined, locale: Locale = "zh"): string {
  if (locale !== "en") {
    const zh = COMMAND_LABELS[name];
    if (zh) return zh;
  }
  return description ?? "";
}
