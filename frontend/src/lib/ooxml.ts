// OOXML（docx / xlsx / pptx）的公共读取工具。
//
// 这三类文件都是 zip + 一堆 XML 部件。前端就地预览只解析**值**，不执行任何宏、
// 不解析外部关系（remoteRelationship），也不为公式求值——文件来自工作区，
// 解析器只需要回答「里面写了什么」。
import { unzipSync } from "fflate";

/** 按包内路径索引的部件字节表。 */
export type OoxmlParts = Record<string, Uint8Array>;

/**
 * 解压预算。
 *
 * OOXML 是 zip，压缩比可以做到 1000:1：一个 32MB 的 xlsx 能解出几十 GB 的 XML
 * （zip bomb），浏览器标签页会直接 OOM。请求侧的上限（`/api/fs/blob` 的 32MB）
 * 管不到解压后的体积，所以这里必须自己设一道。
 */
export interface UnzipBudget {
  /** 保留部件的解压后总量上限。 */
  totalBytes: number;
  /** 单个部件的解压后上限。 */
  entryBytes: number;
}

/** 默认预算：正常的 Office 文档远在下面，zip bomb 会远超。 */
export const DEFAULT_UNZIP_BUDGET: UnzipBudget = {
  // 32MB 的 pptx 里几张 4K 图通常解出几十 MB，128MB 留了余量。
  totalBytes: 128 << 20,
  // 单张图/单个 sheet XML 超过这个数基本不是「看一眼」的场景。
  entryBytes: 48 << 20,
};

/** 解压超出预算。消息直接展示给用户，说明「请下载后打开」。 */
export class OoxmlTooLargeError extends Error {
  /** 触发上限的部件路径（总量超限时是压垮预算的那一个）。 */
  readonly part: string;

  constructor(part: string) {
    super(`解压后超过预览上限（${part}）`);
    this.name = "OoxmlTooLargeError";
    this.part = part;
  }
}

/**
 * 是否「解压后体积超限」。
 *
 * 不能只靠 `instanceof`：三个渲染器各自是一个懒加载 chunk，`ooxml` 是共享
 * chunk——将来打包策略一变、它被内联成两份，两个 class 副本会让 instanceof
 * 静默失败，用户又看到内部部件路径。类名是字符串字面量，跟着实例走。
 */
export function isTooLargeError(err: unknown): boolean {
  return err instanceof OoxmlTooLargeError || (err instanceof Error && err.name === "OoxmlTooLargeError");
}

/**
 * 解压 OOXML 包，只保留 `keep` 认可的部件。
 *
 * 带过滤是必须的：pptx 里 `ppt/media/*` 常常是几十 MB 的原图/视频，
 * 全解压会让一次预览吃掉双倍内存。`filter` 在解压前就能拿到解压后大小，
 * 所以预算检查不额外花代价——超限的条目**不再解压**，跑完后整包报错。
 */
export function unzipParts(
  data: Uint8Array,
  keep: (name: string) => boolean,
  budget: UnzipBudget = DEFAULT_UNZIP_BUDGET,
): OoxmlParts {
  const out: OoxmlParts = {};
  let total = 0;
  let over: string | null = null;
  // fflate 的 filter 拿到的是条目信息；不支持 zip64 之外的奇怪压缩法时它会抛错，
  // 由调用方包成「无法解析」。
  const entries = unzipSync(data, {
    filter: (file) => {
      if (!keep(file.name)) return false;
      // 已经超限就一个字节都别再解，OOM 只看峰值。
      if (over) return false;
      if (file.originalSize > budget.entryBytes) {
        over = file.name;
        return false;
      }
      total += file.originalSize;
      if (total > budget.totalBytes) {
        over = file.name;
        return false;
      }
      return true;
    },
  });
  if (over) throw new OoxmlTooLargeError(normalizePartPath(over));
  for (const [name, bytes] of Object.entries(entries)) out[normalizePartPath(name)] = bytes;
  return out;
}

/** 包内路径统一成不带前导 `/`、`..` 已折叠的写法。 */
export function normalizePartPath(path: string): string {
  const parts: string[] = [];
  for (const seg of path.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

/** 解析一个 XML 部件；不存在或不是合法 XML 时返回 null。 */
export function parseXmlPart(parts: OoxmlParts, path: string): Document | null {
  const raw = parts[normalizePartPath(path)];
  if (!raw || raw.length === 0) return null;
  const text = new TextDecoder("utf-8").decode(raw);
  if (!text.trim()) return null;
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  return doc;
}

/**
 * 按本地名取后代元素。
 *
 * OOXML 主文档通常不写前缀，`getElementsByTagName` 够用；但第三方生成器
 * 经常写成 `<x:row>`，那时只能按 localName 逐个比。先走快路径，空了再扫一遍。
 */
export function byTag(root: Document | Element, name: string): Element[] {
  const direct = root.getElementsByTagName(name);
  if (direct.length > 0) return Array.from(direct);
  const out: Element[] = [];
  const all = root.getElementsByTagName("*");
  for (let i = 0; i < all.length; i += 1) {
    if (all[i].localName === name) out.push(all[i]);
  }
  return out;
}

/**
 * 按本地名取属性：`r:id` 这类带前缀的键在 DOM 里只有 localName 稳定。
 *
 * 优先取**带命名空间**的那个：`<p:sldId id="256" r:id="rId2">` 两个属性的
 * localName 都是 `id`，只有关系 id 指向幻灯片，`id="256"` 是编辑器的序号。
 * 没有带命名空间的匹配时才退回无前缀属性（`<c r="A1">` 的单元格引用走这条）。
 */
export function attrByLocalName(el: Element, localName: string): string {
  let fallback = "";
  for (const attr of Array.from(el.attributes)) {
    if (attr.localName !== localName) continue;
    if (attr.namespaceURI) return attr.value;
    if (!fallback) fallback = attr.value;
  }
  return fallback;
}

/** 读取 `_rels/*.rels`，返回 Id → 已归一的包内路径。 */
export function readRels(parts: OoxmlParts, relsPath: string): Record<string, string> {
  const doc = parseXmlPart(parts, relsPath);
  const out: Record<string, string> = {};
  if (!doc) return out;
  for (const rel of byTag(doc, "Relationship")) {
    const id = rel.getAttribute("Id") ?? "";
    const target = rel.getAttribute("Target") ?? "";
    // 外部链接（http/mailto）不解析：预览不访问网络。
    if (!id || !target || rel.getAttribute("TargetMode") === "External") continue;
    out[id] = target;
  }
  return out;
}

/** 把 rels 里的相对 Target 折算成包内路径。 */
export function resolvePartTarget(baseDir: string, target: string): string {
  if (target.startsWith("/")) return normalizePartPath(target);
  return normalizePartPath(`${baseDir}/${target}`);
}

/** 从 `…/_rels/name.xml.rels` 推出该部件的 rels 路径。 */
export function relsPathFor(partPath: string): string {
  const idx = partPath.lastIndexOf("/");
  const dir = idx >= 0 ? partPath.slice(0, idx) : "";
  const name = idx >= 0 ? partPath.slice(idx + 1) : partPath;
  return normalizePartPath(`${dir}/_rels/${name}.rels`);
}

/** 元素下所有文本节点（含 CDATA），按文档顺序拼接。 */
export function textOf(el: Element | null | undefined): string {
  if (!el) return "";
  return (el.textContent ?? "").replace(/\r\n?/g, "\n");
}

/** 单个扩展名 → MIME（只覆盖 Office 包里会出现的位图）。 */
export function mediaTypeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
