import { NO_AUTOFILL } from "../../lib/autofill";
import { useState } from "react";
import { setToken } from "../../lib/runtime";
import { BrandMark } from "../common/Icons";
import { useT } from "../../lib/i18n";

/** 后端启用了 CCWEB_AUTH_TOKEN 时，先要求输入访问令牌。 */
export function TokenGate({ onSaved }: { onSaved: () => void }) {
  const t = useT();
  const [value, setValue] = useState("");

  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center gap-5 bg-canvas p-6">
      <BrandMark size={40} className="text-ink" />
      <form
        className="w-full max-w-sm rounded-2xl border border-line bg-canvas p-5 shadow-soft"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(value.trim());
          onSaved();
        }}
      >
        <h1 className="text-[15px] font-semibold text-ink">{t("需要访问令牌", "Access token required")}</h1>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">{t("后端启用了 CCWEB_AUTH_TOKEN，请输入后继续。", "The backend requires CCWEB_AUTH_TOKEN. Enter it to continue.")}</p>
        <input {...NO_AUTOFILL} {...NO_AUTOFILL}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          className="mt-3 w-full rounded-[10px] border border-line-strong bg-canvas px-3 py-2 font-mono text-[13px] outline-none focus:border-brand/60"
          placeholder="CCWEB_AUTH_TOKEN"
        />
        <button
          type="submit"
          className="mt-3 w-full rounded-[10px] bg-brand py-2 text-[13px] font-medium text-white hover:bg-brand-hover"
        >
          {t("进入", "Continue")}
        </button>
      </form>
    </div>
  );
}
