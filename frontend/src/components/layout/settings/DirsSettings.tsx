import { useEffect, useRef, useState } from "react";
import { useT } from "../../../lib/i18n";
import { runtimeBase } from "../../../lib/runtime";
import { addFnosDirAuth, fnosHostAvailable } from "../../../lib/fnos";
import { AUTH_MESSAGE, authCallbackPath, authStatusOutcome, authSucceeded, newAuthState, type AuthResult } from "../../../lib/fnosAuth";
import { useAppStore } from "../../../store/useAppStore";
import { useDirsStore } from "../../../store/useDirsStore";
import { Button } from "../../common/Button";
import { askConfirm } from "../../common/SystemDialogs";
import { IconAlert, IconFolder, IconPlus, IconRefresh, IconTrash } from "../../common/Icons";

/**
 * 「设置 → 目录」：飞牛授权给本应用的目录。
 *
 * 只有三件事——看列表、添加（走飞牛授权）、撤销。**不打开目录、不标目录徽章、不写说明**：
 * 这一页回答的只有一个问题「claude 现在能碰哪些目录」。
 *
 * 列表宽度跟着面板走（`w-full` + 路径 `truncate`）：NAS 上的路径很长，
 * 定死宽度会把删除按钮挤出屏幕；完整路径放 `title`。
 */
export function DirsSettings() {
  const t = useT();
  const info = useAppStore((s) => s.info);
  const dirs = useDirsStore((s) => s.dirs);
  const protectedDirs = useDirsStore((s) => s.protected);
  const error = useDirsStore((s) => s.error);
  const loading = useDirsStore((s) => s.loading);
  const removing = useDirsStore((s) => s.removing);
  const load = useDirsStore((s) => s.load);
  const remove = useDirsStore((s) => s.remove);

  /** 等待回调的那次授权；只认这个 state 的结果。 */
  const pending = useRef<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  // 宿主外的授权走新窗口：结果由回调页 postMessage 回来。
  // 收不到也不影响——页面上留着「刷新」，用户回到这里照样能拿到最新列表。
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; result?: AuthResult } | null;
      if (!data || data.type !== AUTH_MESSAGE || !data.result) return;
      const expected = pending.current;
      // 只认自己发起的那一次：state 是发起时生成的一次性随机串。
      if (!expected || data.result.state !== expected) return;
      pending.current = null;
      if (authSucceeded(data.result, expected)) {
        setNotice(null);
        void load();
        return;
      }
      setNotice(
        authStatusOutcome(data.result) === "cancel"
          ? t("已取消授权。", "Authorization cancelled.")
          : (data.result.error ?? t("授权没有完成，请重试。", "Authorization did not complete; try again.")),
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [load, t]);

  const add = async () => {
    if (adding) return;
    // 宿主外靠飞牛授权页（/app-auth/…）：它只在飞牛网关前缀下存在。
    // 直连端口访问（base 为空）时打开必然是 404，先说清楚而不是给一个死链。
    if (!fnosHostAvailable() && !runtimeBase()) {
      setNotice(
        t(
          "直连端口访问打不开飞牛授权页：请从飞牛桌面或 App 打开本应用。",
          "Direct port access cannot open the fnOS authorization page; open this app from the fnOS desktop or App.",
        ),
      );
      return;
    }
    setAdding(true);
    setNotice(null);
    const state = newAuthState();
    pending.current = state;
    try {
      const res = await addFnosDirAuth({
        appName: info?.trim_app || "ClaudeCode",
        state,
        redirectUri: authCallbackPath(runtimeBase()),
      });
      if (res.state === "opened") {
        setNotice(
          t(
            "已打开飞牛授权页，选好目录、确认后回到这里（或点刷新）。",
            "The fnOS authorization page is open. Pick a folder there, then come back (or hit Refresh).",
          ),
        );
        return;
      }
      if (res.state === "skipped") {
        setNotice(
          res.reason === "standalone"
            ? t("当前不在飞牛宿主中，无法发起授权。", "Not running inside fnOS, so authorization cannot start.")
            : t("飞牛宿主桥接不可用（握手超时或不在宿主内），请刷新页面重试。", "The fnOS host bridge is unavailable; reload the page and retry."),
        );
        return;
      }
      if (res.state === "denied") {
        // 取消是用户自己的选择，不当错误报红。
        setNotice(res.reason === "cancel" ? t("已取消授权。", "Authorization cancelled.") : res.message);
        return;
      }
      pending.current = null;
      await load();
    } finally {
      setAdding(false);
    }
  };

  const askRemove = async (path: string) => {
    const ok = await askConfirm({
      title: t("撤销目录授权", "Revoke folder access"),
      message: t(
        `撤销后 claude 将无法再访问 ${path}，已打开的会话需要重新授权。`,
        `Claude will lose access to ${path}; open sessions need to be authorized again.`,
      ),
      danger: true,
      confirmText: t("撤销", "Revoke"),
    });
    if (ok) await remove(path);
  };

  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{t("已授权目录", "Authorized folders")}</h3>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <IconRefresh size={14} className={loading ? "opacity-50" : ""} />
          {t("刷新", "Refresh")}
        </Button>
        <Button variant="primary" size="sm" onClick={() => void add()} disabled={adding}>
          <IconPlus size={14} />
          {t("添加目录", "Add folder")}
        </Button>
      </div>

      {notice && <p className="text-[11.5px] leading-relaxed text-muted">{notice}</p>}

      {error && (
        <p className="flex items-start gap-1.5 rounded-lg border border-line-strong bg-panel-strong px-3 py-2 text-[11.5px] leading-relaxed text-warn">
          <IconAlert size={13} className="mt-[2px] shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}

      {!error && dirs.length === 0 && !loading && (
        <p className="rounded-lg border border-dashed border-line-strong px-3 py-6 text-center text-[11.5px] text-faint">
          {t("还没有授权目录", "No authorized folders yet")}
        </p>
      )}

      {dirs.length > 0 && (
        <ul className="flex flex-col gap-1">
          {dirs.map((path) => (
            <li
              key={path}
              className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2"
            >
              <IconFolder size={14} className="shrink-0 text-muted" />
              {/* 路径是唯一内容：长路径截断显示，完整值放 title。 */}
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-2" title={path}>
                {path}
              </span>
              {/* 应用自己的安装/数据目录是安装包固有目录：撤销等于让进程读不到自己的
                  二进制，后端也会拒绝，所以这里不出按钮。 */}
              {!protectedDirs.includes(path) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void askRemove(path)}
                  disabled={removing === path}
                  aria-label={t(`撤销 ${path} 的授权`, `Revoke access to ${path}`)}
                  title={t("撤销授权", "Revoke")}
                  className="shrink-0 text-muted hover:text-danger"
                >
                  <IconTrash size={14} />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
