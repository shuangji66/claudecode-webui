// 对话框附件：类型判定、大小限制与 base64 读取。
//
// 后端只接受图片 / PDF / 文本；总解码大小 10MB，与 ws 帧上限 16MB 匹配。
import type { WireAttachment } from "../transport/types";
import { tr, type Locale } from "./i18n";

export type AttachmentKind = "image" | "pdf" | "text";

export interface PendingAttachment {
  id: string;
  name: string;
  mediaType: string;
  /** 纯 base64（不含 data URL 前缀）。 */
  data: string;
  size: number;
  kind: AttachmentKind;
}

export const MAX_TOTAL_BYTES = 10 << 20;

export const ATTACHMENT_ACCEPT =
  "image/*,.pdf,.txt,.md,.markdown,.json,.yaml,.yml,.toml,.go,.ts,.tsx,.js,.jsx,.css,.html,.xml,.csv,.log,.sh,.zsh,.py,.rs,.java,.c,.h,.cpp,.sql,.ini,.conf";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_EXT = new Set([
  "txt", "md", "markdown", "json", "yaml", "yml", "toml", "go", "ts", "tsx", "js", "jsx",
  "css", "html", "htm", "xml", "csv", "log", "sh", "zsh", "py", "rs", "java", "c", "h",
  "cpp", "sql", "ini", "conf", "env", "mod", "sum", "lock",
]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function classifyAttachment(name: string, mediaType: string): AttachmentKind | null {
  const type = (mediaType || "").toLowerCase();
  const ext = extOf(name);
  if (IMAGE_TYPES.has(type) || ((!type || type === "application/octet-stream") && IMAGE_EXT.has(ext))) return "image";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (type.startsWith("text/") || TEXT_EXT.has(ext)) return "text";
  return null;
}

export function attachmentLimit(kind: AttachmentKind): number {
  switch (kind) {
    case "image":
      return 5 << 20;
    case "pdf":
      return 8 << 20;
    default:
      return 1 << 20;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function mediaTypeOf(file: File, kind: AttachmentKind): string {
  if (kind === "pdf") return "application/pdf";
  if (kind === "image") {
    if (IMAGE_TYPES.has(file.type)) return file.type;
    const ext = extOf(file.name);
    return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/png";
  }
  return file.type.startsWith("text/") ? file.type : "text/plain";
}

function newID(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function readBase64(file: File, locale: Locale): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(tr(locale, "读取文件失败", "Failed to read the file")));
    reader.onload = () => {
      const raw = typeof reader.result === "string" ? reader.result : "";
      const comma = raw.indexOf(",");
      if (comma < 0) {
        reject(new Error(tr(locale, "文件编码失败", "Failed to encode the file")));
        return;
      }
      resolve(raw.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** 读取一个文件；类型不支持或超过单文件上限时抛错。 */
export async function readAttachment(file: File, locale: Locale = "zh"): Promise<PendingAttachment> {
  const kind = classifyAttachment(file.name, file.type);
  if (!kind) throw new Error(tr(locale, `不支持的文件类型：${file.name}`, `Unsupported file type: ${file.name}`));
  const limit = attachmentLimit(kind);
  if (file.size > limit) {
    throw new Error(tr(locale, `${file.name} 超过 ${formatBytes(limit)}`, `${file.name} exceeds ${formatBytes(limit)}`));
  }
  if (file.size === 0) throw new Error(tr(locale, `${file.name} 是空文件`, `${file.name} is empty`));
  const data = await readBase64(file, locale);
  return {
    id: newID(),
    name: file.name,
    mediaType: mediaTypeOf(file, kind),
    data,
    size: file.size,
    kind,
  };
}

/**
 * 用后端读回来的字节构造附件（飞牛目录里挑中的图片/PDF）。
 *
 * 校验规则与本地文件一致：类型不认识或超过单文件上限就抛错，别把 8MB 的 PDF
 * 塞进 WS 帧。
 */
export function attachmentFromBase64(
  input: { name: string; media_type: string; size: number; data: string },
  locale: Locale = "zh",
): PendingAttachment {
  const kind = classifyAttachment(input.name, input.media_type);
  if (!kind) throw new Error(tr(locale, `不支持的文件类型：${input.name}`, `Unsupported file type: ${input.name}`));
  const limit = attachmentLimit(kind);
  if (input.size > limit) {
    throw new Error(tr(locale, `${input.name} 超过 ${formatBytes(limit)}`, `${input.name} exceeds ${formatBytes(limit)}`));
  }
  return {
    id: newID(),
    name: input.name,
    mediaType: input.media_type,
    data: input.data,
    size: input.size,
    kind,
  };
}

/**
 * 从剪贴板事件里取出文件（桌面截图直接 Ctrl+V）。
 *
 * 优先用 `items` 的 `getAsFile()`：Safari 与部分 Linux 桌面环境里 `files` 是空的，
 * 只有 items 里带图。返回空数组表示「这是一次普通文本粘贴」，调用方不要拦截默认行为。
 */
export function clipboardFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  if (fromItems.length > 0) return fromItems;
  return Array.from(data.files ?? []);
}

/** 图片 MIME → 扩展名（与 `mediaTypeOf` 的白名单同一组）。 */
function extForType(mediaType: string): string {
  switch (mediaType.toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}

/**
 * 给剪贴板里的文件补一个名字。
 *
 * 截图工具只给字节、`File.name` 常常是空串；不补的话附件芯片是一块空白，
 * 发出去后模型看到的附件名也只是后端的 `attachment` 兜底。
 */
export function withPastedName(file: File, at: Date = new Date()): File {
  if (file.name.trim() !== "") return file;
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return new File([file], `clipboard-${stamp}.${extForType(file.type)}`, { type: file.type });
}

/** 附件字节的 data URL：输入框缩略图与放大预览共用同一份拼法。 */
export function attachmentDataUrl(a: PendingAttachment): string {
  return `data:${a.mediaType};base64,${a.data}`;
}

export function toWireAttachment(a: PendingAttachment): WireAttachment {
  return { name: a.name, media_type: a.mediaType, data: a.data };
}
