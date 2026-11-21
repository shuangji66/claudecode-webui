import { NO_AUTOFILL } from "../../lib/autofill";
import { useState } from "react";
import { AccessError, loginAccess, setToken } from "../../lib/runtime";
import { cachedLocale } from "../../lib/theme";
import { tr } from "../../lib/i18n";
import { BrandMark, IconEye, IconEyeOff } from "../common/Icons";
import { Button } from "../common/Button";

/**
 * 访问鉴权页（覆盖整页）。
 *
 * 什么时候出现：后端回答 auth_required=true 且本地没有凭据时。典型场景是经
 * TCP 端口（默认 3141）从局域网打开——unix socket 走前置网关，是本机可信入口，
 * 不要求这里输入的密码。
 *
 * 设计跟随主题：底色/文字/边框全部用语义令牌（bg-canvas / text-ink / border-line），
 * 强调色是全局陶土色 brand。文案按浏览器缓存的语言（与设置页同源），
 * 因为此时还拿不到 /api/settings。
 */
export function TokenGate({ onSaved, stale = false }: { onSaved: () => void; stale?: boolean }) {
  const t = (zh: string, en: string) => tr(cachedLocale(), zh, en);
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const secret = value; // 不去空格：密码里可能本来就带空格
    if (!secret.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // 只发送这一次密码：后端校验摘要后回一个随机会话令牌，本地只存令牌。
      const token = await loginAccess(secret);
      setToken(token);
      onSaved();
    } catch (e) {
      if (e instanceof AccessError && e.status === 401) {
        setError(t("密码不正确，请重试。", "Wrong password. Try again."));
      } else if (e instanceof AccessError) {
        setError(t(`登录失败：${e.message}`, `Sign-in failed: ${e.message}`));
      } else {
        setError(t("无法连接服务，请检查网络后重试。", "Cannot reach the server. Check the network and try again."));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-y-auto bg-canvas px-5 py-10">
      {/* 顶部一层强调色柔光：让鉴权页和主界面共用同一套品牌感，而不是一张白纸。 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-linear-to-b from-brand-soft to-transparent"
      />

      <div className="relative w-full max-w-[380px]">
        <div className="mb-5 flex flex-col items-center gap-3 text-center">
          {/* 与左侧栏共用同一个品牌图标（claude-code.svg），不再套色块：
              logo 本身就是陶土色，叠在 brand 底上会糊成一块。 */}
          <BrandMark size={42} />
          <div>
            <h1 className="text-[17px] font-semibold tracking-tight text-ink">
              {t("访问受密码保护", "Password protected")}
            </h1>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">
              {t(
                "这个端口启用了访问鉴权。请输入访问密码后继续。",
                "This port requires authentication. Enter the access password to continue.",
              )}
            </p>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="rounded-2xl border border-line bg-panel/60 p-5 shadow-soft backdrop-blur"
        >
          <label htmlFor="ccweb-access-password" className="text-[12px] font-medium text-ink">
            {t("访问密码", "Access password")}
          </label>
          <div className="relative mt-1.5">
            <input
              {...NO_AUTOFILL}
              id="ccweb-access-password"
              type={show ? "text" : "password"}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              autoFocus
              autoComplete="current-password"
              className="w-full rounded-[10px] border border-line-strong bg-canvas py-2 pl-3 pr-10 font-mono text-[13px] text-ink outline-none placeholder:text-faint focus:border-brand/60"
              placeholder={t("请输入访问密码", "Enter the access password")}
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? t("隐藏密码", "Hide password") : t("显示密码", "Show password")}
              title={show ? t("隐藏密码", "Hide password") : t("显示密码", "Show password")}
              className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted transition hover:bg-black/5 hover:text-ink dark:hover:bg-white/5"
            >
              {show ? <IconEyeOff size={15} /> : <IconEye size={15} />}
            </button>
          </div>

          {error && (
            <p className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[11.5px] leading-relaxed text-danger">
              {error}
            </p>
          )}
          {!error && stale && (
            <p className="mt-3 text-[11px] leading-relaxed text-muted">
              {t("本地登录已失效（改过密码或已过期），请重新输入访问密码。", "Your session is no longer valid (password changed or expired). Enter the access password again.")}
            </p>
          )}

          <Button type="submit" variant="primary" disabled={busy || !value.trim()} className="mt-4 w-full py-2.5 text-[13px]">
            {busy ? t("正在验证…", "Verifying…") : t("进入", "Continue")}
          </Button>
        </form>

      </div>
    </div>
  );
}
