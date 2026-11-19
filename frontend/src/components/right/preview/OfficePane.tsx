// Office 预览外壳：取字节 + 懒加载对应解析器。
//
// 三个解析器各自是一个动态 import 的 chunk：docx-preview（含 jszip）与 xlsx/pptx
// 的自写解析器都不小，而多数会话根本不会打开 Office 文件——首屏包体不能为它们
// 买单。懒加载的界线放在这里（组件级），store / 后端都是普通请求。
import { Suspense, lazy, useEffect, useState } from "react";
import { useT } from "../../../lib/i18n";
import { useSidebarStore } from "../../../store/useSidebarStore";

const DocxPreview = lazy(() => import("./DocxPreview"));
const XlsxPreview = lazy(() => import("./XlsxPreview"));
const PptxPreview = lazy(() => import("./PptxPreview"));

export type OfficeKind = "docx" | "xlsx" | "pptx";

interface Props {
  path: string;
  kind: OfficeKind;
  name: string;
}

export function OfficePane({ path, kind, name }: Props) {
  const t = useT();
  const readBytes = useSidebarStore((s) => s.readBytes);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setBytes(null);
    setError("");
    readBytes(path, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setBytes(next);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => controller.abort();
  }, [path, readBytes]);

  if (error) {
    return (
      <div className="m-3 rounded-lg border border-danger/25 bg-danger/[0.06] px-2.5 py-2 text-[11.5px] leading-relaxed text-danger">
        {t(`无法预览：${error}`, `Cannot preview: ${error}`)}
      </div>
    );
  }
  if (!bytes) {
    return <p className="px-3 py-3 text-[11.5px] text-faint">{t("正在读取文件…", "Reading file…")}</p>;
  }

  const Renderer = kind === "docx" ? DocxPreview : kind === "xlsx" ? XlsxPreview : PptxPreview;
  return (
    <Suspense fallback={<p className="px-3 py-3 text-[11.5px] text-faint">{t("正在解析文档…", "Parsing document…")}</p>}>
      <Renderer bytes={bytes} name={name} />
    </Suspense>
  );
}
