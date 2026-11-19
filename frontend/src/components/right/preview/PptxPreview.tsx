// PPT 预览：把每页的文字段落与图片按页连续排出来。
//
// 不还原版式（母版继承、占位符位置、主题色、动画都不做）——目标是「看见写了什么」。
// 页面固定白底深字，模拟幻灯片本身：主题令牌在深色模式下会把内容变成浅字浅底。
import { useEffect, useMemo, useState } from "react";
import { useT } from "../../../lib/i18n";
import { isTooLargeError } from "../../../lib/ooxml";
import { PPTX_MAX_SLIDES, parsePptx, type PptxDoc } from "../../../lib/pptx";

interface Props {
  bytes: ArrayBuffer;
  name: string;
}

type State =
  | { status: "loading" }
  | { status: "ready"; doc: PptxDoc }
  | { status: "error"; message: string; tooLarge: boolean };

export default function PptxPreview({ bytes, name }: Props) {
  const t = useT();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      try {
        setState({ status: "ready", doc: parsePptx(new Uint8Array(bytes)) });
      } catch (reason) {
        setState({
          status: "error",
          message: reason instanceof Error ? reason.message : String(reason),
          tooLarge: isTooLargeError(reason),
        });
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [bytes]);

  const doc = state.status === "ready" ? state.doc : null;
  // 每页的图片 URL：解析出的 Blob 只在组件活着时有效，卸载/换文件时一并撤销。
  const urls = useMemo(
    () => (doc ? doc.slides.map((slide) => slide.images.map((img) => URL.createObjectURL(img.blob))) : []),
    [doc],
  );
  useEffect(() => () => {
    for (const list of urls) for (const url of list) URL.revokeObjectURL(url);
  }, [urls]);

  if (state.status === "loading") {
    return <p className="px-3 py-3 text-[11.5px] text-faint">{t("正在解析幻灯片…", "Parsing slides…")}</p>;
  }
  if (state.status === "error") {
    return (
      <div className="m-3 rounded-lg border border-danger/25 bg-danger/[0.06] px-2.5 py-2 text-[11.5px] leading-relaxed text-danger">
        {state.tooLarge
          ? t(
              "文档解压后体积过大（超过 128MB），侧栏无法预览，请下载后用桌面应用打开。",
              "This document expands beyond 128MB; download it and open it in a desktop app.",
            )
          : t(`无法解析幻灯片：${state.message}`, `Cannot parse slides: ${state.message}`)}
      </div>
    );
  }
  if (!doc || doc.slides.length === 0) {
    return <p className="px-3 py-3 text-[11.5px] text-faint">{t("演示文稿里没有可显示的页面。", "No slides to show.")}</p>;
  }

  return (
    <div className="flex flex-col gap-3 px-2 py-2" data-name={name}>
      {doc.slides.map((slide, i) => (
        <section
          key={slide.index}
          className="w-full rounded-lg border border-line bg-white p-5 text-[#1f2328] shadow-sm"
          aria-label={t(`第 ${slide.index} 页`, `Slide ${slide.index}`)}
        >
          <p className="mb-2 text-[10px] text-[#8b949e]">
            {t(`第 ${slide.index} 页`, `Slide ${slide.index}`)}
          </p>
          {slide.paragraphs.length === 0 && slide.images.length === 0 && (
            <p className="text-[12px] text-[#8b949e]">{t("这一页没有文字或图片。", "This slide has no text or image.")}</p>
          )}
          {slide.paragraphs.map((text, j) => (
            <p
              key={j}
              className={j === 0 ? "mb-1 text-[15px] font-semibold leading-snug" : "mb-1 text-[12.5px] leading-relaxed"}
            >
              {text}
            </p>
          ))}
          {(urls[i] ?? []).length > 0 && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(urls[i] ?? []).map((url, k) => (
                <img
                  key={k}
                  src={url}
                  alt={slide.images[k]?.name ?? ""}
                  className="max-h-56 w-full rounded border border-black/5 object-contain"
                />
              ))}
            </div>
          )}
        </section>
      ))}
      {doc.truncated && (
        <p className="mx-auto mb-2 rounded-md bg-warn/10 px-2 py-1 text-[10.5px] text-warn">
          {t(`仅显示前 ${PPTX_MAX_SLIDES} 页。`, `Showing first ${PPTX_MAX_SLIDES} slides.`)}
        </p>
      )}
    </div>
  );
}
