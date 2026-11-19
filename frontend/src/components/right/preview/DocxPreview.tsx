// Word 预览：交给 docx-preview 把 document.xml 还原成带样式的页面。
//
// 这是我们唯一引的 Office 解析库——段落/表格/列表/图片的排版还原度值得这份体积，
// 且它只做「解析 + 建 DOM」，不执行文档里的宏或外部关系。样式写进组件自己的容器，
// 不往 <head> 塞全局 CSS。
import { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";
import { useT } from "../../../lib/i18n";

interface Props {
  bytes: ArrayBuffer;
  name: string;
}

/**
 * 压缩页边距：docx-preview 按文档的页面边距（A4 通常左右各 3.17cm ≈ 120px）给
 * section 加内边距，右侧栏只有 380px 宽时正文会被挤成每行四五个字。
 * 版式其它部分照旧，只把四周内边距夹到 28px——窄栏里读得下去比「边距一比一」重要。
 */
const MAX_PAGE_PADDING = 28;

function clampPagePadding(host: HTMLElement): void {
  for (const node of Array.from(host.querySelectorAll("section.docx"))) {
    const page = node as HTMLElement;
    for (const side of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const) {
      const px = Number.parseFloat(page.style[side] || "");
      if (Number.isFinite(px) && px > MAX_PAGE_PADDING) page.style[side] = `${MAX_PAGE_PADDING}px`;
    }
  }
}

export default function DocxPreview({ bytes, name }: Props) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    setError("");
    host.replaceChildren();
    void renderAsync(bytes, host, host, {
      // 侧栏宽度是拖出来的：按文档页宽固定就会一直横向滚动，这里让页面跟着容器缩。
      ignoreWidth: true,
      ignoreHeight: true,
      breakPages: true,
      inWrapper: true,
      // 页眉页脚在窄栏里会把正文挤成一团，预览只保留正文。
      renderHeaders: false,
      renderFooters: false,
    })
      .then(() => {
        if (!cancelled) clampPagePadding(host);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
      host.replaceChildren();
    };
  }, [bytes]);

  if (error) {
    return (
      <div className="m-3 rounded-lg border border-danger/25 bg-danger/[0.06] px-2.5 py-2 text-[11.5px] leading-relaxed text-danger">
        {t(`无法解析 Word 文档：${error}`, `Cannot parse Word document: ${error}`)}
      </div>
    );
  }

  return (
    <div
      ref={hostRef}
      // wrapper 的灰底/内边距在 styles.css 的 .docx-preview-host 规则里抹平。
      className="docx-preview-host px-2 py-2"
      data-name={name}
    />
  );
}
