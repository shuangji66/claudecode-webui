import { useState } from "react";
import { setToken } from "../../lib/runtime";

/** 后端启用了 CCWEB_AUTH_TOKEN 时，先要求输入访问令牌。 */
export function TokenGate({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState("");

  return (
    <div className="flex h-full items-center justify-center bg-slate-50 p-6 dark:bg-slate-950">
      <form
        className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(value.trim());
          onSaved();
        }}
      >
        <h1 className="text-sm font-semibold text-slate-700 dark:text-slate-200">需要访问令牌</h1>
        <p className="mt-1 text-xs text-slate-400">后端启用了 CCWEB_AUTH_TOKEN，请输入后继续。</p>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          placeholder="CCWEB_AUTH_TOKEN"
        />
        <button
          type="submit"
          className="mt-3 w-full rounded-lg bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          进入
        </button>
      </form>
    </div>
  );
}
