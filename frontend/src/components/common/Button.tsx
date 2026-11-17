// 统一按钮：颜色/圆角/尺寸只在这里定义，避免各处复制 Tailwind 串导致
// 主按钮深浅、圆角、hover 各写一套（改主题时容易漏）。

import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  className?: string;
  children?: ReactNode;
}

// BASE 里的 shrink-0 / whitespace-nowrap 是必需的：按钮常放在
// `flex justify-between` 的表头行里，左边是可收缩的说明文字（min-w-0），
// 默认 flex-shrink:1 会让按钮被文字挤窄、中文标签在按钮内部折成两行
// （「添加」「已启用」曾被压成竖排）。要换行的是说明文字，不是按钮标签。
const BASE =
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[10px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-40";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-brand text-white hover:bg-brand-hover",
  secondary: "border border-line-strong text-ink hover:bg-panel-strong",
  ghost: "text-muted hover:bg-black/5 hover:text-ink",
  danger: "bg-danger text-white hover:brightness-95",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1.5 text-[11.5px]",
  md: "px-4 py-2 text-[12px]",
};

export function Button({ variant = "secondary", size = "md", icon, className = "", children, ...rest }: Props) {
  return (
    <button type="button" {...rest} className={`${BASE} ${VARIANT[variant]} ${SIZE[size]} ${className}`}>
      {icon}
      {children}
    </button>
  );
}
