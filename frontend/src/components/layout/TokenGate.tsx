import { useState } from "react";
import { setToken } from "../../lib/runtime";
import { BrandMark } from "../common/Icons";

/** 后端启用了 CCWEB_AUTH_TOKEN 时，先要求输入访问令牌。 */
export function TokenGate({ onSaved }: { onSaved: () => void }) {
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
        <h1 className="text-[15px] font-semibold text-ink">需要访问令牌</h1>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">后端启用了 CCWEB_AUTH_TOKEN，请输入后继续。</p>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          className="mt-3 w-full rounded-[10px] border border-line-strong bg-canvas px-3 py-2 font-mono text-[13px] outline-none focus:border-brand/60"
          placeholder="CCWEB_AUTH_TOKEN"
        />
        <button
          type="submit"
          className="mt-3 w-full rounded-[10px] bg-ink py-2 text-[13px] font-medium text-canvas hover:opacity-90"
        >
          进入
        </button>
      </form>
    </div>
  );
}
