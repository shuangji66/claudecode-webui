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

/**
 * 一行设置：左边标题 + 说明，右边控件（对齐 DSH 的 Setting-Cell）。
 *
 * 行高由 `py-4` 与两行文字决定（约 73px），比「标题 / 说明 / 控件」竖着摞三层的
 * `Section` 紧一倍；`desc` 可以是节点（字号行把预览塞在说明下面，不再单独占一块）。
 * 分隔线画在行自己身上，`last:border-b-0` 让列表末尾不留一条悬空的线。
 */
export function SettingRow({
  title,
  desc,
  stacked = false,
  children,
}: {
  title: string;
  desc?: ReactNode;
  /** 控件另起一行、占满整行宽度（输入框 + 按钮这种横向吃宽度的控件）。 */
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`flex gap-4 border-b border-line py-4 last:border-b-0 ${stacked ? "flex-col" : "items-center"}`}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink">{title}</div>
        {desc && <div className="mt-0.5 text-[11.5px] leading-relaxed text-muted">{desc}</div>}
      </div>
      <div className={stacked ? "min-w-0" : "flex shrink-0 items-center"}>{children}</div>
    </div>
  );
}

/** `SettingRow` 的容器：只在最上面画一条分隔线，行之间由行自己的下边框负责。 */
export function SettingRows({ children }: { children: ReactNode }) {
  return <div className="mt-1 border-t border-line">{children}</div>;
}
