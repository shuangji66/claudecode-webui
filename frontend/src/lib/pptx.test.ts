import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parsePptx, PPTX_MAX_SLIDES } from "./pptx";

const P_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';

function zip(parts: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, body] of Object.entries(parts)) {
    entries[name] = typeof body === "string" ? new TextEncoder().encode(body) : body;
  }
  return zipSync(entries);
}

function slideShape(paragraphs: string): string {
  return `<p:sp><p:txBody>${paragraphs
    .split("|")
    .map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`)
    .join("")}</p:txBody></p:sp>`;
}

function buildPptx(slideCount = 2): Uint8Array {
  // 页序：slide2 排在最前（真实文件里 sldIdLst 顺序与文件名无关）。
  const order: number[] = [];
  if (slideCount >= 2) order.push(2);
  if (slideCount >= 1) order.push(1);
  for (let i = 3; i <= slideCount; i += 1) order.push(i);

  const slideXml = (n: number) => {
    const body = n === 1 ? slideShape("封面|副标题")
      : n === 2 ? `${slideShape("第二页")}<p:pic><p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic>`
      : slideShape(`第 ${n} 页`);
    return `<?xml version="1.0"?><p:sld ${P_NS} ${A_NS} ${R_NS}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
  };

  const parts: Record<string, string | Uint8Array> = {
    "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation ${P_NS} ${R_NS}>
      <p:sldIdLst>${order.map((n, i) => `<p:sldId id="${256 + i}" r:id="rId${n}"/>`).join("")}</p:sldIdLst>
    </p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<?xml version="1.0"?><Relationships ${REL_NS}>${order
      .map((n) => `<Relationship Id="rId${n}" Type="slide" Target="slides/slide${n}.xml"/>`)
      .join("")}</Relationships>`,
  };
  for (const n of order) parts[`ppt/slides/slide${n}.xml`] = slideXml(n);
  parts["ppt/slides/_rels/slide2.xml.rels"] = `<?xml version="1.0"?><Relationships ${REL_NS}>
      <Relationship Id="rId1" Type="image" Target="../media/image1.png"/>
    </Relationships>`;
  parts["ppt/media/image1.png"] = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  return zip(parts);
}

describe("parsePptx", () => {
  it("按 presentation.xml 的页序读文本与图片", () => {
    const doc = parsePptx(buildPptx());
    expect(doc.slides.map((s) => s.index)).toEqual([1, 2]);
    expect(doc.slides[0].paragraphs).toEqual(["第二页"]);
    expect(doc.slides[0].images).toHaveLength(1);
    expect(doc.slides[0].images[0].name).toBe("ppt/media/image1.png");
    expect(doc.slides[0].images[0].blob.type).toBe("image/png");
    expect(doc.slides[1].paragraphs).toEqual(["封面", "副标题"]);
    expect(doc.slides[1].images).toHaveLength(0);
    expect(doc.truncated).toBe(false);
  });

  it("页数超过上限时截断并标记", () => {
    const doc = parsePptx(buildPptx(PPTX_MAX_SLIDES + 5));
    expect(doc.slides).toHaveLength(PPTX_MAX_SLIDES);
    expect(doc.truncated).toBe(true);
  });

  it("缺 presentation.xml 时按文件名数字排页", () => {
    const bytes = zip({
      "ppt/slides/slide10.xml": `<?xml version="1.0"?><p:sld ${P_NS} ${A_NS}><p:cSld><p:spTree>${slideShape("十")}</p:spTree></p:cSld></p:sld>`,
      "ppt/slides/slide2.xml": `<?xml version="1.0"?><p:sld ${P_NS} ${A_NS}><p:cSld><p:spTree>${slideShape("二")}</p:spTree></p:cSld></p:sld>`,
    });
    const doc = parsePptx(bytes);
    expect(doc.slides.map((s) => s.paragraphs[0])).toEqual(["二", "十"]);
  });

  it("不是 zip 的字节会抛错", () => {
    expect(() => parsePptx(new Uint8Array([0, 1, 2]))).toThrow();
  });
});
