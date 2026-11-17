import type { ReactNode } from "react";

/** 设置页里的分区标题 + 说明 + 内容；通用 / 代理 / 部署共用同一份，别再各写一遍。 */
export function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="border-b border-line pb-6 last:border-b-0">
      <h4 className="text-[13px] font-medium text-ink">{title}</h4>
      {desc && <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{desc}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}
