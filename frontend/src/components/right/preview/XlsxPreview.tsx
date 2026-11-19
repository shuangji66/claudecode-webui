// Excel 预览：只读表格，多工作表用一排标签切换。
//
// 解析放在 effect 的 setTimeout(0) 里，先让「正在解析」渲染出来——大工作簿的
// sharedStrings 解析在手机上要几百毫秒，同步跑会让点击看起来像没反应。
import { useEffect, useState } from "react";
import { useT } from "../../../lib/i18n";
import { isTooLargeError } from "../../../lib/ooxml";
import { XLSX_MAX_COLS, XLSX_MAX_ROWS, parseXlsx, type XlsxDoc } from "../../../lib/xlsx";

interface Props {
  bytes: ArrayBuffer;
  name: string;
}

type State =
  | { status: "loading" }
  | { status: "ready"; doc: XlsxDoc }
  | { status: "error"; message: string; tooLarge: boolean };

export default function XlsxPreview({ bytes, name }: Props) {
  const t = useT();
  const [state, setState] = useState<State>({ status: "loading" });
  const [active, setActive] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setActive(0);
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      try {
        const doc = parseXlsx(new Uint8Array(bytes));
        setState({ status: "ready", doc });
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

  if (state.status === "loading") {
    return <p className="px-3 py-3 text-[11.5px] text-faint">{t("正在解析表格…", "Parsing spreadsheet…")}</p>;
  }
  if (state.status === "error") {
    return (
      <div className="m-3 rounded-lg border border-danger/25 bg-danger/[0.06] px-2.5 py-2 text-[11.5px] leading-relaxed text-danger">
        {state.tooLarge
          ? t(
              "文档解压后体积过大（超过 128MB），侧栏无法预览，请下载后用桌面应用打开。",
              "This document expands beyond 128MB; download it and open it in a desktop app.",
            )
          : t(`无法解析表格：${state.message}`, `Cannot parse spreadsheet: ${state.message}`)}
      </div>
    );
  }

  const sheets = state.doc.sheets;
  if (sheets.length === 0) {
    return <p className="px-3 py-3 text-[11.5px] text-faint">{t("工作簿里没有可显示的工作表。", "No visible worksheet.")}</p>;
  }
  const sheet = sheets[Math.min(active, sheets.length - 1)];
  const rows = sheet.rows;
  const cols = rows.reduce((max, row) => Math.max(max, row.length), 0);

  return (
    <div className="min-h-full" data-name={name}>
      {sheets.length > 1 && (
        <div className="sticky top-0 z-10 flex flex-wrap gap-1 border-b border-line bg-panel px-2 py-1.5">
          {sheets.map((item, i) => (
            <button
              key={`${item.name}-${i}`}
              type="button"
              onClick={() => setActive(i)}
              aria-pressed={i === active}
              className={`max-w-[12rem] truncate rounded-md px-2 py-0.5 text-[11px] ${
                i === active ? "bg-brand/12 text-brand" : "text-muted hover:bg-black/5 hover:text-ink"
              }`}
            >
              {item.name}
            </button>
          ))}
        </div>
      )}

      {rows.length === 0 || cols === 0 ? (
        <p className="px-3 py-3 text-[11.5px] text-faint">{t("这个工作表是空的。", "This worksheet is empty.")}</p>
      ) : (
        <div className="overflow-x-auto px-2 py-2">
          <table className="border-collapse font-mono text-[11.5px] leading-[1.5]">
            <tbody>
              {rows.map((row, r) => (
                <tr key={r} className="hover:bg-black/[0.025]">
                  <th className="w-9 select-none border border-line bg-black/[0.02] px-1 text-right font-normal text-faint">
                    {r + 1}
                  </th>
                  {row.map((cell, c) => (
                    <td
                      key={c}
                      className="max-w-[16rem] whitespace-pre-wrap border border-line px-1.5 py-0.5 align-top text-ink-2 [overflow-wrap:anywhere]"
                    >
                      {cell || " "}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sheet.truncated && (
        <p className="mx-3 mb-3 mt-1 rounded-md bg-warn/10 px-2 py-1 text-[10.5px] text-warn">
          {t(
            `仅显示前 ${XLSX_MAX_ROWS} 行 / ${XLSX_MAX_COLS} 列，其余请下载查看。`,
            `Showing first ${XLSX_MAX_ROWS} rows / ${XLSX_MAX_COLS} columns; download for the rest.`,
          )}
        </p>
      )}
    </div>
  );
}
