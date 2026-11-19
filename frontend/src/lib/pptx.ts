// 前端只读 PPT 预览：把每页的文字与图片摊出来，按页连续排。
//
// 不引现成 pptx 渲染库：npm 上能用的那个（pptx-preview）是闭源混淆包，而我们要的
// 只是「能看见写了什么」。这里用 fflate 解 zip，按 presentation.xml 的页序读每页
// 的文本框与图片——版式、动画、母版继承、主题色一律不还原，保真度明确不高。
import {
  attrByLocalName,
  byTag,
  mediaTypeFor,
  normalizePartPath,
  parseXmlPart,
  readRels,
  relsPathFor,
  resolvePartTarget,
  textOf,
  unzipParts,
  type OoxmlParts,
} from "./ooxml";

/** 一次最多渲染多少页；再多的演示文稿不是「瞄一眼」能看完的。 */
export const PPTX_MAX_SLIDES = 100;
const MAX_PARAGRAPHS_PER_SLIDE = 80;
const MAX_PARAGRAPH_CHARS = 1000;

export interface PptxImage {
  name: string;
  blob: Blob;
}

export interface PptxSlide {
  /** 1 起的页码（按演示文稿顺序，不是文件名）。 */
  index: number;
  /** 文本框里的段落，按文档顺序。 */
  paragraphs: string[];
  images: PptxImage[];
}

export interface PptxDoc {
  slides: PptxSlide[];
  /** 页数超过上限。 */
  truncated: boolean;
}

/** 只解压能画的位图：视频、音频、EMF/WMF 矢量图既不显示也不该占内存。 */
const PREVIEWABLE_MEDIA = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

/**
 * 包内路径是否要解压。
 *
 * 演示文稿里挂着几十 MB 的视频/音频是常态，按扩展名把它们挡在解压之前——
 * 既省内存，也不会让一个大媒体文件触发整包的体积上限。
 */
export function isPptxPreviewPart(path: string): boolean {
  const p = normalizePartPath(path);
  if (p === "ppt/presentation.xml" || p === "ppt/_rels/presentation.xml.rels") return true;
  if (p.startsWith("ppt/slides/")) return true;
  return p.startsWith("ppt/media/") && PREVIEWABLE_MEDIA.test(p);
}

/**
 * 解析 pptx 字节。
 *
 * 解压失败（损坏的 zip）由 fflate 抛错、超出解压预算抛 `OoxmlTooLargeError`，
 * 调用方按「无法解析 / 文件过大」显示，不要让它们变成空白页。
 */
export function parsePptx(data: Uint8Array): PptxDoc {
  const parts = unzipParts(data, isPptxPreviewPart);
  const slideParts = readSlideOrder(parts);
  const truncated = slideParts.length > PPTX_MAX_SLIDES;
  const slides = slideParts.slice(0, PPTX_MAX_SLIDES).map((part, i) => readSlide(parts, part, i + 1));
  return { slides, truncated };
}

/** 按 presentation.xml 的 sldIdLst 排页；缺关系表时退回按文件名数字排序。 */
function readSlideOrder(parts: OoxmlParts): string[] {
  const presentation = parseXmlPart(parts, "ppt/presentation.xml");
  const ordered: string[] = [];
  if (presentation) {
    const rels = readRels(parts, "ppt/_rels/presentation.xml.rels");
    for (const sldId of byTag(presentation, "sldId")) {
      const relId = attrByLocalName(sldId, "id");
      const target = rels[relId] ?? "";
      if (!target) continue;
      const part = resolvePartTarget("ppt", target);
      if (parts[part] && !ordered.includes(part)) ordered.push(part);
    }
  }
  if (ordered.length > 0) return ordered;
  return Object.keys(parts)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
}

function slideNumber(part: string): number {
  const m = /slide(\d+)\.xml$/.exec(part);
  return m ? Number(m[1]) : 0;
}

function readSlide(parts: OoxmlParts, part: string, index: number): PptxSlide {
  const doc = parseXmlPart(parts, part);
  if (!doc) return { index, paragraphs: [], images: [] };
  const paragraphs: string[] = [];
  for (const body of byTag(doc, "txBody")) {
    if (paragraphs.length >= MAX_PARAGRAPHS_PER_SLIDE) break;
    for (const p of byTag(body, "p")) {
      if (paragraphs.length >= MAX_PARAGRAPHS_PER_SLIDE) break;
      const text = textOf(p).replace(/\s+/g, " ").trim();
      if (!text) continue;
      paragraphs.push(text.length > MAX_PARAGRAPH_CHARS ? `${text.slice(0, MAX_PARAGRAPH_CHARS)}…` : text);
    }
  }
  const images = readImages(parts, part, doc);
  return { index, paragraphs, images };
}

function readImages(parts: OoxmlParts, part: string, doc: Document): PptxImage[] {
  const rels = readRels(parts, relsPathFor(part));
  const out: PptxImage[] = [];
  for (const blip of byTag(doc, "blip")) {
    const relId = attrByLocalName(blip, "embed");
    const target = rels[relId] ?? "";
    if (!target) continue;
    const mediaPart = resolvePartTarget(part.slice(0, part.lastIndexOf("/")), target);
    const bytes = parts[mediaPart];
    if (!bytes) continue;
    const type = mediaTypeFor(mediaPart);
    // 只画位图；pptx 里还挂着音频/视频/图表的媒体，那些交给下载。
    if (!type.startsWith("image/")) continue;
    if (out.some((img) => img.name === mediaPart)) continue;
    out.push({ name: mediaPart, blob: new Blob([bytes as BlobPart], { type }) });
  }
  return out;
}
