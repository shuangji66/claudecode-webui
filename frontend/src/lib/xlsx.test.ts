import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { columnIndex, formatExcelDate, parseXlsx, XLSX_MAX_ROWS } from "./xlsx";

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';

function zip(parts: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, text] of Object.entries(parts)) entries[name] = new TextEncoder().encode(text);
  return zipSync(entries);
}

function workbook(rows: string, sheets = `<sheet name="数据" sheetId="1" r:id="rId1"/>`): Uint8Array {
  return zip({
    "xl/workbook.xml": `<?xml version="1.0"?><workbook ${NS} ${R_NS}><sheets>${sheets}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships ${REL_NS}>
      <Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/>
    </Relationships>`,
    "xl/sharedStrings.xml": `<?xml version="1.0"?><sst ${NS} count="4">
      <si><t>姓名</t></si>
      <si><t>张三</t></si>
      <si><r><t>富</t></r><r><t>文本</t></r></si>
      <si><t>读音</t><rPh sb="0" eb="1"><t>よみ</t></rPh></si>
    </sst>`,
    "xl/styles.xml": `<?xml version="1.0"?><styleSheet ${NS}>
      <numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/></numFmts>
      <cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs>
    </styleSheet>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet ${NS}><sheetData>${rows}</sheetData></worksheet>`,
  });
}

describe("parseXlsx", () => {
  it("把共享字符串、数字、日期、布尔与内联字符串摊成表格", () => {
    const doc = parseXlsx(workbook(`
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2"><v>42</v></c><c r="B2" s="1"><v>45000</v></c></row>
      <row r="3"><c r="A3" t="inlineStr"><is><t>内联</t></is></c><c r="C3" t="b"><v>1</v></c><c r="D3" t="s"><v>2</v></c></row>
    `));
    expect(doc.sheets).toHaveLength(1);
    expect(doc.sheets[0].name).toBe("数据");
    expect(doc.sheets[0].rows).toEqual([
      ["姓名", "张三"],
      ["42", "2023-03-15"],
      // B3 空着但 C3 要留在第 3 列：中间补空串，不能把值挤到左边。
      ["内联", "", "TRUE", "富文本"],
    ]);
    expect(doc.sheets[0].truncated).toBe(false);
  });

  it("自定义日期格式按日期渲染，注音不拼进正文", () => {
    const doc = parseXlsx(workbook(`
      <row r="1"><c r="A1" s="2"><v>45000</v></c><c r="B1" t="s"><v>3</v></c></row>
    `));
    expect(doc.sheets[0].rows[0]).toEqual(["2023-03-15", "读音"]);
  });

  it("隐藏工作表不列出来", () => {
    const doc = parseXlsx(workbook(
      `<row r="1"><c r="A1"><v>1</v></c></row>`,
      `<sheet name="数据" sheetId="1" r:id="rId1"/><sheet name="隐藏" sheetId="2" state="hidden" r:id="rId2"/>`,
    ));
    expect(doc.sheets.map((s) => s.name)).toEqual(["数据"]);
  });

  it("超过行上限时截断并标记", () => {
    const rows = Array.from({ length: XLSX_MAX_ROWS + 20 }, (_, i) =>
      `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join("");
    const doc = parseXlsx(workbook(rows));
    expect(doc.sheets[0].rows).toHaveLength(XLSX_MAX_ROWS);
    expect(doc.sheets[0].truncated).toBe(true);
  });

  it("尾部空行不入表", () => {
    const doc = parseXlsx(workbook(`<row r="1"><c r="A1"><v>1</v></c></row><row r="2"/><row r="3"><c r="A3" s="0"/></row>`));
    expect(doc.sheets[0].rows).toEqual([["1"]]);
  });

  it("不是 zip 的字节会抛错（由调用方显示无法解析）", () => {
    expect(() => parseXlsx(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });
});

describe("columnIndex / formatExcelDate", () => {
  it("列字母折成 0 起索引", () => {
    expect(columnIndex("A")).toBe(0);
    expect(columnIndex("B")).toBe(1);
    expect(columnIndex("Z")).toBe(25);
    expect(columnIndex("AA")).toBe(26);
    expect(columnIndex("AB")).toBe(27);
    expect(columnIndex("")).toBe(-1);
    expect(columnIndex("1")).toBe(-1);
  });

  it("Excel 序列号转日期：整数为日期，小数带时间", () => {
    expect(formatExcelDate(45000)).toBe("2023-03-15");
    expect(formatExcelDate(45000.5)).toBe("2023-03-15 12:00");
    expect(formatExcelDate(0.25)).toBe("06:00");
  });
});
