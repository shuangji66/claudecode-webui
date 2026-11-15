// 极简双语：组件直接传「中文 / English」两个字符串，不维护 key 字典。
// 测试或未挂 Provider 时默认中文，行为与改造前一致。
import { createContext, useCallback, useContext, type ReactNode } from "react";

export type Locale = "zh" | "en";

const LocaleContext = createContext<Locale>("zh");

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

/** 返回 t(中文, English)；英文缺失时回落到中文。 */
export function useT(): (zh: string, en?: string) => string {
  const locale = useLocale();
  return useCallback((zh: string, en?: string) => (locale === "en" && en ? en : zh), [locale]);
}

/** 非组件环境（纯函数）用。 */
export function tr(locale: Locale | string | undefined, zh: string, en: string): string {
  return locale === "en" ? en : zh;
}
