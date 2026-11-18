import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { runtimeBase } from "../../lib/runtime";
import { AUTH_MESSAGE, authStatusOutcome, readAuthResult, type AuthResult } from "../../lib/fnosAuth";

/**
 * 飞牛路由授权的回调页（宿主外添加授权目录的最后一步）。
 *
 * 页面跑在独立浏览器里时，`openAppAuth` 会另开一个窗口打开飞牛授权页；用户确认后
 * 系统带着 `?status=…&path=…&state=…` 跳回这里。这一页只做两件事：
 *
 *  1. 把结果 **postMessage 给原页面**（同源校验由两边的 `event.origin` 完成），
 *     原页面据此刷新「设置 → 目录」；
 *  2. 关掉自己。浏览器不让关（独立标签、没有 opener）时给一句结论和一个回应用的按钮。
 *
 * 它**不挂应用壳层**：没有令牌门、没有侧栏、没有 WS。授权回来时用户不该被丢进
 * 一个半初始化的应用里；`main.tsx` 按路径直接渲染这一页。
 */
export function AuthCallbackPage() {
  const t = useT();
  const [result] = useState<AuthResult>(() => readAuthResult(window.location.search));
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    // 原页面的 state 由它自己校验：这里只转交结果，不替它下结论。
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: AUTH_MESSAGE, result }, window.location.origin);
      window.close();
      // 关不掉（多数浏览器对「非脚本打开的窗口」不允许）就留在本页显示结论。
      setClosed(true);
    }
  }, [result]);

  // state 的比对在原页面做（这里拿不到它生成的那串），本页只转交 + 给一句话结论。
  const outcome = authStatusOutcome(result);
  const title =
    outcome === "ok"
      ? t("已完成授权", "Authorization finished")
      : outcome === "cancel"
        ? t("已取消授权", "Authorization cancelled")
        : t("授权没有完成", "Authorization did not complete");
  // 回应用时走裸前缀：飞牛网关按入口逐字匹配（带尾斜杠的 url 在 App WebView 里会被
  // 当成「另一个入口」，凭据续期跟不上，见根 AGENTS.md 的 fpk 入口约定）。
  const backTo = runtimeBase() || "/";

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-canvas px-6">
      <div className="w-full max-w-sm space-y-4 text-center">
        <p className="text-[15px] font-semibold text-ink">{title}</p>
        {outcome === "ok" && result.paths.length > 0 && (
          <ul className="space-y-1 rounded-lg border border-line bg-panel px-3 py-2 text-left">
            {result.paths.map((p) => (
              <li key={p} className="truncate text-[11.5px] text-ink-2" title={p}>
                {p}
              </li>
            ))}
          </ul>
        )}
        {outcome === "error" && (result.error || result.status) && (
          <p className="text-[11.5px] break-words text-warn">{result.error ?? result.status}</p>
        )}
        <p className="text-[11.5px] leading-relaxed text-muted">
          {closed
            ? t("可以关掉这个页面，回到原页面点「刷新」查看结果。", "You can close this tab and press Refresh in the app.")
            : t("正在通知原页面…", "Notifying the original page…")}
        </p>
        <a
          href={backTo}
          className="inline-flex items-center justify-center rounded-[10px] bg-brand px-4 py-2 text-[12px] font-medium text-white transition hover:bg-brand-hover"
        >
          {t("回到 Claude Code", "Back to Claude Code")}
        </a>
      </div>
    </div>
  );
}
