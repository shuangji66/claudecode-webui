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

const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-[10px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-40";

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
