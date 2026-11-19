// 前端只读 Excel 预览：把 xlsx / xlsm 的单元格值摊成二维表。
//
// 为什么不引 SheetJS：npm 上的 `xlsx` 停在 0.18.5（0.19.3 才修的原型污染漏洞），
// 包体 7.5MB，而我们只需要「把看得见的值读出来」——不写回、不求值公式、不画图表。
// 这里用 fflate 解 zip + DOMParser 读 XML，几百行就够，也没有把工作区文件交给
// 一个带未修复漏洞的解析器的风险。
//
// 保真度取舍：列宽、字体、颜色、条件格式、图表、合并单元格一律不还原；
// 日期按内置格式编号与自定义格式粗略识别。目的是「能看见内容」，不是还原表格。
import {
  attrByLocalName,
  byTag,
  normalizePartPath,
  parseXmlPart,
  readRels,
  resolvePartTarget,
  textOf,
  unzipParts,
  type OoxmlParts,
} from "./ooxml";

/** 单个工作表最大渲染行/列数：再大就不是「看一眼」了，交给下载。 */
export const XLSX_MAX_ROWS = 200;
export const XLSX_MAX_COLS = 50;
/** 单元格文本上限，防止一格塞进几万字符把表格撑爆。 */
const MAX_CELL_CHARS = 300;

export interface XlsxSheet {
  /** 工作表名（tab 标签）。 */
  name: string;
  /** 行优先的单元格文本；短行用空串补齐。 */
  rows: string[][];
  /** 因行列上限被截断（还有内容没显示）。 */
  truncated: boolean;
}

export interface XlsxDoc {
  sheets: XlsxSheet[];
}

/** 内置的日期/时间数字格式编号（ECMA-376 的隐式表）。 */
const BUILTIN_DATE_FORMATS = new Set<number>([
  14, 15, 16, 17, 18, 19, 20, 21, 22,
  27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47,
  50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

interface SheetRef {
  name: string;
  part: string;
}

/**
 * 解析 xlsx 字节。
 *
 * 解析失败（不是 zip、缺 workbook.xml）返回空表数据，由调用方显示「无法解析」。
 * 解压本身会抛错：损坏的 zip 由 fflate 报，超出解压预算抛 `OoxmlTooLargeError`。
 */
export function parseXlsx(data: Uint8Array): XlsxDoc {
  const parts = unzipParts(data, (name) => {
    const p = normalizePartPath(name);
    return p === "xl/workbook.xml" || p === "xl/_rels/workbook.xml.rels" ||
      p === "xl/sharedStrings.xml" || p === "xl/styles.xml" || p.startsWith("xl/worksheets/");
  });
  const sheets = readSheetRefs(parts);
  const shared = readSharedStrings(parts);
  const dateStyles = readDateStyles(parts);
  return {
    sheets: sheets.map((ref) => readSheet(parts, ref, shared, dateStyles)),
  };
}

function readSheetRefs(parts: OoxmlParts): SheetRef[] {
  const workbook = parseXmlPart(parts, "xl/workbook.xml");
  if (!workbook) return [];
  const rels = readRels(parts, "xl/_rels/workbook.xml.rels");
  const out: SheetRef[] = [];
  for (const sheet of byTag(workbook, "sheet")) {
    const name = sheet.getAttribute("name") ?? "";
    // 隐藏工作表（state=hidden / veryHidden）不列出来：用户在 Excel 里看不到它，
    // 预览也不该多一页。veryHidden 只能从 VBA 改回来，同样是「不该出现在界面上」。
    const state = sheet.getAttribute("state") ?? "";
    if (state === "hidden" || state === "veryHidden") continue;
    const relId = attrByLocalName(sheet, "id");
    const target = rels[relId] ?? "";
    const part = target ? resolvePartTarget("xl", target) : "";
    if (!part) continue;
    out.push({ name: name || `Sheet${out.length + 1}`, part });
  }
  return out;
}

function readSharedStrings(parts: OoxmlParts): string[] {
  const doc = parseXmlPart(parts, "xl/sharedStrings.xml");
  if (!doc) return [];
  const out: string[] = [];
  for (const si of byTag(doc, "si")) {
    // 富文本是多个 <r><t>；<rPh> 是日文注音，拼进去会让正文重复一遍读音。
    let text = "";
    for (const node of Array.from(si.getElementsByTagName("*"))) {
      if (node.localName !== "t") continue;
      if (hasPhoneticAncestor(node, si)) continue;
      text += node.textContent ?? "";
    }
    out.push(text);
  }
  return out;
}

function hasPhoneticAncestor(node: Element, stop: Element): boolean {
  for (let el = node.parentElement; el && el !== stop; el = el.parentElement) {
    if (el.localName === "rPh") return true;
  }
  return false;
}

/** 每个样式索引（cellXfs 的 s 属性）是否按日期渲染。 */
function readDateStyles(parts: OoxmlParts): boolean[] {
  const doc = parseXmlPart(parts, "xl/styles.xml");
  if (!doc) return [];
  const custom: Record<number, string> = {};
  for (const fmt of byTag(doc, "numFmt")) {
    const id = Number(fmt.getAttribute("numFmtId") ?? "");
    const code = fmt.getAttribute("formatCode") ?? "";
    if (Number.isFinite(id)) custom[id] = code;
  }
  const xfs = byTag(doc, "cellXfs")[0];
  if (!xfs) return [];
  return byTag(xfs, "xf").map((xf) => {
    const id = Number(xf.getAttribute("numFmtId") ?? "0");
    if (!Number.isFinite(id)) return false;
    if (BUILTIN_DATE_FORMATS.has(id)) return true;
    const code = custom[id];
    return code ? looksLikeDateFormat(code) : false;
  });
}

/** 自定义格式串是否在表达日期/时间（去掉字面量与 `[Red]` 之类的修饰后看字母）。 */
function looksLikeDateFormat(code: string): boolean {
  const cleaned = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "")
    .toLowerCase();
  return /[ymdhs]/.test(cleaned);
}

function readSheet(parts: OoxmlParts, ref: SheetRef, shared: string[], dateStyles: boolean[]): XlsxSheet {
  const doc = parseXmlPart(parts, ref.part);
  if (!doc) return { name: ref.name, rows: [], truncated: false };
  const rows: string[][] = [];
  let truncated = false;

  // 直接遍历 live 的 HTMLCollection，不先 Array.from：十万行的 sheet 会白建一个
  // 十万个元素的数组，而我们只取前 XLSX_MAX_ROWS 行。
  const rowNodes = doc.getElementsByTagName("row");
  if (rowNodes.length > 0) {
    for (let i = 0; i < rowNodes.length; i += 1) {
      if (rows.length >= XLSX_MAX_ROWS) {
        truncated = true;
        break;
      }
      const row = readRow(rowNodes[i], shared, dateStyles);
      if (row.truncated) truncated = true;
      rows.push(row.cells);
    }
  } else {
    // 带前缀的生成器（`<x:row>`）：只能按本地名扫，文件不多见。
    for (const node of byTag(doc, "row")) {
      if (rows.length >= XLSX_MAX_ROWS) {
        truncated = true;
        break;
      }
      const row = readRow(node, shared, dateStyles);
      if (row.truncated) truncated = true;
      rows.push(row.cells);
    }
  }

  // 尾部空行（Excel 常留一堆格式化过的空行）不占预览空间。
  while (rows.length > 0 && rows[rows.length - 1].every((v) => v === "")) rows.pop();
  return { name: ref.name, rows, truncated };
}

/** 读一行单元格。缺 `r` 引用的格按上一格的下一列放，不让整行错位。 */
function readRow(row: Element, shared: string[], dateStyles: boolean[]): { cells: string[]; truncated: boolean } {
  const cells: string[] = [];
  let truncated = false;
  let nextIndex = 0;
  for (const cell of byTag(row, "c")) {
    const ref = attrByLocalName(cell, "r").replace(/[0-9]/g, "");
    // 部分生成器（以及手写测试数据）会省略 r：按顺序排，比整格丢掉好。
    const index = ref ? columnIndex(ref) : nextIndex;
    if (index < 0) continue;
    nextIndex = index + 1;
    if (index >= XLSX_MAX_COLS) {
      truncated = true;
      continue;
    }
    while (cells.length < index) cells.push("");
    cells[index] = cellValue(cell, shared, dateStyles);
  }
  while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return { cells, truncated };
}

function cellValue(cell: Element, shared: string[], dateStyles: boolean[]): string {
  const type = cell.getAttribute("t") ?? "n";
  if (type === "inlineStr") {
    const is = byTag(cell, "is")[0];
    return clip(is ? textOf(is) : "");
  }
  const v = byTag(cell, "v")[0];
  const raw = v ? (v.textContent ?? "") : "";
  if (!raw) {
    // 只存了公式、没有缓存值（openpyxl / 未重算的文件就是这样）：显示公式本身，
    // 比给用户一个空格子有用，也说明「这里原本有内容」。
    const formula = byTag(cell, "f")[0];
    const expr = formula ? (formula.textContent ?? "").trim() : "";
    return expr ? clip(`=${expr}`) : "";
  }
  switch (type) {
    case "s": {
      const idx = Number(raw);
      return clip(Number.isInteger(idx) ? shared[idx] ?? "" : "");
    }
    case "b":
      return raw === "1" ? "TRUE" : "FALSE";
    case "str":
    case "e":
      return clip(raw);
    default: {
      const num = Number(raw);
      if (!Number.isFinite(num)) return clip(raw);
      const style = Number(cell.getAttribute("s") ?? "");
      if (Number.isFinite(style) && dateStyles[style]) return formatExcelDate(num);
      return clip(formatNumber(num));
    }
  }
}

function clip(text: string): string {
  const oneLine = text.replace(/\r\n?/g, "\n");
  if (oneLine.length <= MAX_CELL_CHARS) return oneLine;
  return `${oneLine.slice(0, MAX_CELL_CHARS)}…`;
}

/**
 * 数字去掉浮点噪声（0.30000000000000004）。
 *
 * 只对 1e10 以下的小数做 round：`num * 1e10` 超过 2^53 后会把自己的精度吃掉，
 * 大数原样交给 `String()`（>=1e21 时是科学计数法，可接受）。
 */
function formatNumber(num: number): string {
  if (Number.isInteger(num)) return String(num);
  if (Math.abs(num) >= 1e10) return String(num);
  return String(Math.round(num * 1e10) / 1e10);
}

/**
 * Excel 序列号 → 文本。
 *
 * 基准是 1899-12-30（Excel 把 1900-02-29 当成存在的日期，这个基准已经把偏差吃掉）。
 * 序列号小于 1 表示只有时间。
 */
export function formatExcelDate(serial: number): string {
  if (!Number.isFinite(serial)) return "";
  const ms = Math.round(serial * 86400000);
  const date = new Date(Date.UTC(1899, 11, 30) + ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const ymd = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const hms = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  if (serial < 1) return hms;
  const hasTime = date.getUTCHours() !== 0 || date.getUTCMinutes() !== 0 || date.getUTCSeconds() !== 0;
  return hasTime ? `${ymd} ${hms}` : ymd;
}

/** 列字母（A、AB）→ 0 起索引；认不出来返回 -1。 */
export function columnIndex(letters: string): number {
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0) - 65;
    if (code < 0 || code > 25) return -1;
    n = n * 26 + code + 1;
  }
  return n - 1;
}
