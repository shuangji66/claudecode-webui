// 自绘线性图标：不引图标库，保持内嵌体积与视觉一致。
import type { SVGProps } from "react";
import claudeCodeMark from "../../assets/claude-code.svg";

type Props = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconPanel(props: Props) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9 4v16" />
    </Svg>
  );
}

export function IconPlus(props: Props) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

/** 信息圆点：设置页「关于」用。 */
export function IconInfo(props: Props) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.6v.1" />
    </Svg>
  );
}

/** GitHub 标记（外链图标，指向仓库）。 */
export function IconGitHub({ size = 18, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
    </svg>
  );
}

/** 三条滑杆：视图/筛选菜单的触发器（对齐 DSH 的 sliders 图标）。 */
export function IconSliders(props: Props) {
  return (
    <Svg {...props}>
      <path d="M4 8h6M14 8h6M4 16h10M18 16h2" />
      <circle cx="12" cy="8" r="2" />
      <circle cx="16" cy="16" r="2" />
    </Svg>
  );
}

/** 上移：菜单里的「上移」用。 */
export function IconChevronUp(props: Props) {
  return (
    <Svg {...props}>
      <path d="m6 14.5 6-6 6 6" />
    </Svg>
  );
}

export function IconSearch(props: Props) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m16.5 16.5 4 4" />
    </Svg>
  );
}

export function IconFolder(props: Props) {
  return (
    <Svg {...props}>
      <path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3l1.6 2H18a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5z" />
    </Svg>
  );
}

export function IconFolderPlus(props: Props) {
  return (
    <Svg {...props}>
      <path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3l1.6 2H18a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5z" />
      <path d="M12 10.5v5M9.5 13h5" />
    </Svg>
  );
}

export function IconSettings(props: Props) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 14.4a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.88 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.88.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.88V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.4z" />
    </Svg>
  );
}

export function IconSend(props: Props) {
  return (
    <Svg {...props}>
      <path d="M12 19V5M6.5 10.5 12 5l5.5 5.5" />
    </Svg>
  );
}

export function IconStop(props: Props) {
  return (
    <Svg {...props}>
      <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconChevronRight(props: Props) {
  return (
    <Svg {...props}>
      <path d="m9.5 6 6 6-6 6" />
    </Svg>
  );
}

export function IconChevronDown(props: Props) {
  return (
    <Svg {...props}>
      <path d="m6 9.5 6 6 6-6" />
    </Svg>
  );
}

export function IconClose(props: Props) {
  return (
    <Svg {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Svg>
  );
}

export function IconClock(props: Props) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </Svg>
  );
}

export function IconTrash(props: Props) {
  return (
    <Svg {...props}>
      <path d="M4.5 7h15M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7M7 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L17 7" />
    </Svg>
  );
}

export function IconRetry(props: Props) {
  return (
    <Svg {...props}>
      <path d="M20 11a8 8 0 1 0-2.4 5.7" />
      <path d="M20 4v7h-7" />
    </Svg>
  );
}

export function IconCopy(props: Props) {
  return (
    <Svg {...props}>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
    </Svg>
  );
}

export function IconChat(props: Props) {
  return (
    <Svg {...props}>
      <path d="M20 12a7.5 7.5 0 0 1-11 6.6L4 20l1.4-4.4A7.5 7.5 0 1 1 20 12z" />
      <path d="M8.5 11h7M8.5 14h4.5" />
    </Svg>
  );
}

export function IconMore(props: Props) {
  return (
    <Svg {...props}>
      <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconAlert(props: Props) {
  return (
    <Svg {...props}>
      <path d="M10.3 4.5 2.8 18a2 2 0 0 0 1.8 3h14.8a2 2 0 0 0 1.8-3L13.7 4.5a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </Svg>
  );
}

export function IconWrench(props: Props) {
  return (
    <Svg {...props}>
      <path d="M14.7 6.3a4.5 4.5 0 0 0-5.9 5.8L3 17.9V21h3.1l5.8-5.8a4.5 4.5 0 0 0 5.8-5.9l-2.8 2.8-2.8-2.8z" />
    </Svg>
  );
}

export function IconTerminal(props: Props) {
  return (
    <Svg {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </Svg>
  );
}

export function IconSpark(props: Props) {
  return (
    <Svg {...props}>
      <path d="M12 3.5c.5 4.2 2.3 6 6.5 6.5-4.2.5-6 2.3-6.5 6.5-.5-4.2-2.3-6-6.5-6.5 4.2-.5 6-2.3 6.5-6.5z" />
      <path d="M18.5 16.5c.2 1.5.8 2.1 2.3 2.3-1.5.2-2.1.8-2.3 2.3-.2-1.5-.8-2.1-2.3-2.3 1.5-.2 2.1-.8 2.3-2.3z" />
    </Svg>
  );
}

export function IconShield(props: Props) {
  return (
    <Svg {...props}>
      <path d="M12 3.5 19 6v5.4c0 4.3-3 7.2-7 9.1-4-1.9-7-4.8-7-9.1V6z" />
      <path d="m9 12 2 2 4-4" />
    </Svg>
  );
}

export function IconSun(props: Props) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
    </Svg>
  );
}

export function IconMoon(props: Props) {
  return (
    <Svg {...props}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" />
    </Svg>
  );
}

export function IconMonitor(props: Props) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="13" rx="2.5" />
      <path d="M8 21h8M12 17v4" />
    </Svg>
  );
}

export function IconFile(props: Props) {
  return (
    <Svg {...props}>
      <path d="M6 3.5h7l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1-1.5z" />
      <path d="M13 3.5V9h5" />
    </Svg>
  );
}

export function IconImage(props: Props) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m5 17 5-5 4 4 2-2 3 3" />
    </Svg>
  );
}

export function IconGlobe(props: Props) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.2 3.3 8.5S14.2 18.1 12 20.5C9.8 18.1 8.7 15.3 8.7 12S9.8 5.9 12 3.5z" />
    </Svg>
  );
}

export function IconType(props: Props) {
  return (
    <Svg {...props}>
      <path d="M4 6h16M12 6v13M8 19h8" />
    </Svg>
  );
}

export function IconGauge(props: Props) {
  return (
    <Svg {...props}>
      <path d="M4.5 17a8.5 8.5 0 1 1 15 0" />
      <path d="m12 13 3.5-4" />
      <circle cx="12" cy="13" r="1.2" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconCheck(props: Props) {
  return (
    <Svg {...props}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </Svg>
  );
}

export function IconHistory(props: Props) {
  return (
    <Svg {...props}>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5" />
      <path d="M3.5 4v4.5H8" />
      <path d="M12 8v4.5l3 2" />
    </Svg>
  );
}

/** 品牌标记：使用项目提供的 Claude Code 像素图标（256×161）。 */
export function BrandMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <img
      src={claudeCodeMark}
      alt=""
      aria-hidden="true"
      className={className}
      style={{ height: size, width: (size * 256) / 161 }}
    />
  );
}

/** 打开/收起右侧栏：与左侧 IconPanel 镜像。 */
export function IconSidebarRight(props: Props) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M15 4v16" />
    </Svg>
  );
}

export function IconChevronLeft(props: Props) {
  return (
    <Svg {...props}>
      <path d="m14.5 5-7 7 7 7" />
    </Svg>
  );
}

export function IconGitBranch(props: Props) {
  return (
    <Svg {...props}>
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="7" r="2.2" />
      <path d="M6 7.2v9.6M18 9.2c0 3.2-3 4.3-6 4.8" />
    </Svg>
  );
}

export function IconGitCommit(props: Props) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M3 12h5.5M15.5 12H21" />
    </Svg>
  );
}

/** 取消暂存：与 IconPlus 配对的横线。 */
export function IconMinus(props: Props) {
  return (
    <Svg {...props}>
      <path d="M5 12h14" />
    </Svg>
  );
}

export function IconExternal(props: Props) {
  return (
    <Svg {...props}>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4" />
    </Svg>
  );
}

export function IconFileText(props: Props) {
  return (
    <Svg {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </Svg>
  );
}

export function IconEye(props: Props) {
  return (
    <Svg {...props}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.6" />
    </Svg>
  );
}

export function IconEyeOff(props: Props) {
  return (
    <Svg {...props}>
      <path d="M3 3l18 18" />
      <path d="M10.6 6.2A9.6 9.6 0 0 1 12 6.1c6 0 9.5 5.9 9.5 5.9a17 17 0 0 1-2.7 3.3M6.2 7.7A16.7 16.7 0 0 0 2.5 12S6 18.5 12 18.5c1.2 0 2.3-.2 3.3-.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </Svg>
  );
}

export function IconSync(props: Props) {
  return (
    <Svg {...props}>
      <path d="M20 8h-6a4 4 0 0 0-4 4v1M4 16h6a4 4 0 0 0 4-4v-1" />
      <path d="m17 5 3 3-3 3M7 19l-3-3 3-3" />
    </Svg>
  );
}

export function IconPin(props: Props) {
  return (
    <Svg {...props}>
      <path d="M9 4h6l-1 6 3 3v1H7v-1l3-3-1-6z" />
      <path d="M12 14v6" />
    </Svg>
  );
}

export function IconArchive(props: Props) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="4" rx="1.5" />
      <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4" />
    </Svg>
  );
}

export function IconPencil(props: Props) {
  return (
    <Svg {...props}>
      <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
      <path d="m13.5 6.5 3 3" />
    </Svg>
  );
}

export function IconDownload(props: Props) {
  return (
    <Svg {...props}>
      <path d="M12 4v10" />
      <path d="m8 10 4 4 4-4" />
      <path d="M5 18h14" />
    </Svg>
  );
}

export function IconRefresh(props: Props) {
  return (
    <Svg {...props}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4h-4" />
    </Svg>
  );
}

// 插件：拼图块。中间一个圆点是插头，与「MCP 用的地球」区分开。
export function IconPlugin(props: Props) {
  return (
    <Svg {...props}>
      <path d="M10 4a2 2 0 0 1 4 0v1h2.5A1.5 1.5 0 0 1 18 6.5V9h1a2 2 0 0 1 0 4h-1v3.5A1.5 1.5 0 0 1 16.5 18H14v1a2 2 0 0 1-4 0v-1H7.5A1.5 1.5 0 0 1 6 16.5V14H5a2 2 0 0 1 0-4h1V6.5A1.5 1.5 0 0 1 7.5 5H10z" />
    </Svg>
  );
}
