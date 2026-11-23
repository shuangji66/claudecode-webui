// 把当前会话导出为 Markdown（右上角「更多」菜单用）。
// 不含费用信息：对话结束的统计里已经去掉了花费，导出也保持一致。
import { wakeLabel } from "./model";
import type { Item } from "./model";
import { tr, type Locale } from "./i18n";

function fence(content: string, lang = ""): string {
  const ticks = content.includes("```") ? "````" : "```";
  return `${ticks}${lang}\n${content.replace(/\n$/, "")}\n${ticks}`;
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export interface ExportInput {
  title: string;
  cwd: string;
  items: Item[];
  locale?: Locale;
  now?: Date;
}

export function sessionToMarkdown({ title, cwd, items, locale = "zh", now = new Date() }: ExportInput): string {
  const lines: string[] = [
    `# ${title || "Claude Code"}`,
    "",
    `- ${tr(locale, "工作区", "Workspace")}: \`${cwd || "-"}\``,
    `- ${tr(locale, "导出时间", "Exported")}: ${now.toLocaleString(locale === "en" ? "en-US" : "zh-CN")}`,
    "",
  ];

  for (const item of items) {
    switch (item.kind) {
      case "user": {
        // 图片是内联 base64，塞进 Markdown 会让导出文件几十 MB：只记名字。
        const images = (item.images ?? []).map((image) =>
          tr(locale, `[图片：${image.name}]`, `[Image: ${image.name}]`),
        );
        lines.push(
          `## ${tr(locale, "用户", "User")}`,
          "",
          [item.text, images.join(" ")].filter(Boolean).join("\n\n"),
          "",
        );
        break;
      }
      case "assistant":
        lines.push(`## Claude`, "", item.text, "");
        break;
      case "thinking":
        lines.push(
          `<details>`,
          `<summary>${tr(locale, "思考过程", "Reasoning")}</summary>`,
          "",
          item.text,
          "",
          `</details>`,
          "",
        );
        break;
      case "tool": {
        lines.push(`### ${tr(locale, "工具", "Tool")}: ${item.name}`, "");
        lines.push(`**${tr(locale, "输入", "Input")}**`, "", fence(pretty(item.input), "json"), "");
        if (item.result !== undefined) {
          lines.push(`**${tr(locale, "结果", "Result")}**`, "", fence(item.result, ""), "");
        } else {
          lines.push(`> ${tr(locale, "运行中", "Running")}`, "");
        }
        break;
      }
      case "error":
        lines.push(`> ${tr(locale, "错误", "Error")}: ${item.text}`, "");
        break;
      case "system":
        lines.push(`> ${item.text}`, "");
        break;
      case "interrupt":
        lines.push(
          `> ${
            item.reason === "session"
              ? tr(locale, "会话已结束，本轮未完成", "Session ended before this turn finished")
              : tr(locale, "已中断", "Interrupted")
          }`,
          "",
        );
        break;
      case "result":
        // 刻意不导出耗时/费用。
        break;
      case "wake":
        // 后台任务唤醒了一轮：写成一行引用块，**不导出通知原文**——那里面是
        // 子代理的整份报告，塞进 Markdown 会让导出文件翻好几倍，而正文里主任务
        // 已经把它消化成结论了。要看原文的场合是界面里点开那条横条。
        lines.push(`> ${wakeLabel(item, locale)}`, "");
        break;
      default:
        break;
    }
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
