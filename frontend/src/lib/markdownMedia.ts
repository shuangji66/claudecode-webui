// 正文媒体地址解析。
//
// 模型在正文里写的图片地址有三种实际形态（2026-11 实测 claude 2.1.326）：
//   1. `![x](probe/quad.png)`            —— 相对**会话 cwd**，不是相对当前页面；
//   2. `![x](/vol1/.../probe/quad.png)`    —— 绝对路径，cwd 与工作区不一致时会给；
//   3. `![x](data:image/svg+xml,...)`      —— 让它「直接给张图」时的产物。
//
// 三种都不能原样交给浏览器：相对地址会被 `<base href>` 解析成 SPA 路径（点开 404），
// 绝对路径后端不认（fsapi.cleanRel 明确拒绝绝对路径），data URI 不在 safeHref 白名单里。
// 所以统一在这里归一化：能落到工作区内的转成「相对 cwd 的路径」，交给 /api/fs/raw。

/** data URI 里允许内联的位图。SVG 被排除：同源页面里 SVG 能带脚本，而正文内容来自模型。 */
const INLINE_IMAGE_RE = /^data:image\/(?:png|jpeg|gif|webp|bmp|x-icon);base64,[A-Za-z0-9+/=\s]+$/i;

/** 可内嵌预览的图片扩展名，与后端 allowedRawTypes 对齐（后端还会按字节复核类型）。 */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);

export type MediaTarget =
  /** http(s)：不在应用内加载（会向第三方暴露「用户看了这条消息」），交给链接。 */
  | { kind: "remote"; url: string }
  /** 位图 data URI：直接内联。 */
  | { kind: "inline"; url: string }
  /** 工作区内文件：相对 cwd 的路径，用于拼 /api/fs/raw。 */
  | { kind: "workspace"; rel: string }
  /** 无法安全解析：调用方退回纯文本，保持旧行为。 */
  | { kind: "reject"; reason: string };

function reject(reason: string): MediaTarget {
  return { kind: "reject", reason };
}

/**
 * 把路径拆成段并消掉 `.` / `..`。
 * @returns 段列表；`..` 越过根时返回 null（不许逃出解析基准）。
 */
function normalizeSegments(input: string): string[] | null {
  const out: string[] = [];
  for (const seg of input.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out;
}

/** 去掉末尾斜杠的绝对路径（只处理 POSIX；服务端只有 Linux）。 */
function trimRoot(dir: string): string {
  return dir.replace(/\/+$/, "");
}

/**
 * 解析正文里一个图片 / 文件地址。
 *
 * 相对路径按**会话 cwd** 解析——这是实测出来的行为：模型在 cwd 等于工作区时
 * 写 `probe/quad.png`，cwd 在工作区外时写绝对路径。
 *
 * @param src - 正文里写的地址（`![alt](src)` 的 src）。
 * @param cwd - 会话工作目录的绝对路径；空串表示没有可用基准（一律拒绝）。
 * @returns 归一化结果；不能安全渲染时返回 reject，调用方退回纯文本。
 */
export function resolveMedia(src: string, cwd: string): MediaTarget {
  const raw = src.trim();
  if (!raw) return reject("empty");
  // 控制字符会让 URL 拼装与文件系统解析产生歧义。
  if (/[\u0000-\u001f\u007f]/.test(raw)) return reject("control-char");

  if (/^https?:/i.test(raw)) return { kind: "remote", url: raw };
  if (/^data:/i.test(raw)) {
    return INLINE_IMAGE_RE.test(raw) ? { kind: "inline", url: raw } : reject("data-uri-not-bitmap");
  }
  // 其它协议（file: / javascript: / blob: / C:\）一律不认。
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return reject("unsupported-scheme");

  const root = trimRoot(cwd);
  if (!root) return reject("no-cwd");

  let rest: string;
  if (raw.startsWith("/")) {
    // 绝对路径必须落在 cwd 内：后端 cleanRel 拒绝绝对路径，只能换算成相对写法。
    if (raw !== root && !raw.startsWith(`${root}/`)) return reject("outside-workspace");
    rest = raw.slice(root.length);
  } else {
    rest = `/${raw}`;
  }

  const segs = normalizeSegments(rest);
  if (!segs || segs.length === 0) return reject("empty-path");
  return { kind: "workspace", rel: segs.join("/") };
}

/** 路径是否落在可内嵌预览的图片扩展名里（后端仍会按字节复核）。 */
export function isPreviewableImage(rel: string): boolean {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return false;
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
