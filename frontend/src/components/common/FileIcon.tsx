// 文件类型图标：按扩展名给不同的图形与配色。
//
// 参考 DSH 的文件树（dsh-client-ui-sidebar-files 用 FileTypeIcon + classifyFileType）
// 与常见编辑器图标主题的观感：**颜色区分语言、形状区分类别**。全部自绘 SVG，
// 不引图标库（本项目的 common/Icons 也只有手写路径）。
//
// 图标只做装饰，一律 aria-hidden：文件名本身已经在旁边，屏幕阅读器不需要再念一遍。

export type FileKind =
  | "code"
  | "data"
  | "doc"
  | "style"
  | "markup"
  | "image"
  | "media"
  | "archive"
  | "pdf"
  | "db"
  | "shell"
  | "git"
  | "docker"
  | "make"
  | "file";

export interface FileType {
  kind: FileKind;
  color: string;
}

const code = (color: string): FileType => ({ kind: "code", color });
const data = (color: string): FileType => ({ kind: "data", color });
const doc = (color: string): FileType => ({ kind: "doc", color });

/** 扩展名 → 类型。查表一律用小写。 */
const BY_EXT: Record<string, FileType> = {
  ts: code("#3B82F6"),
  tsx: code("#3B82F6"),
  mts: code("#3B82F6"),
  cts: code("#3B82F6"),
  js: code("#EAB308"),
  jsx: code("#EAB308"),
  mjs: code("#EAB308"),
  cjs: code("#EAB308"),
  vue: code("#22C55E"),
  svelte: code("#F97316"),
  astro: code("#F97316"),
  go: code("#06B6D4"),
  rs: code("#D97757"),
  java: code("#EF4444"),
  kt: code("#A855F7"),
  c: code("#60A5FA"),
  h: code("#60A5FA"),
  cpp: code("#60A5FA"),
  cc: code("#60A5FA"),
  hpp: code("#60A5FA"),
  cs: code("#22C55E"),
  swift: code("#F97316"),
  rb: code("#EF4444"),
  php: code("#8B5CF6"),
  py: code("#3B82F6"),
  lua: code("#3B82F6"),
  dart: code("#06B6D4"),
  json: data("#EAB308"),
  jsonc: data("#EAB308"),
  yaml: data("#EF4444"),
  yml: data("#EF4444"),
  toml: data("#F97316"),
  ini: data("#94A3B8"),
  env: data("#EAB308"),
  conf: data("#94A3B8"),
  lock: data("#94A3B8"),
  md: doc("#60A5FA"),
  mdx: doc("#60A5FA"),
  rst: doc("#94A3B8"),
  adoc: doc("#94A3B8"),
  txt: doc("#94A3B8"),
  log: doc("#94A3B8"),
  css: { kind: "style", color: "#60A5FA" },
  scss: { kind: "style", color: "#EC4899" },
  sass: { kind: "style", color: "#EC4899" },
  less: { kind: "style", color: "#8B5CF6" },
  html: { kind: "markup", color: "#F97316" },
  htm: { kind: "markup", color: "#F97316" },
  xml: { kind: "markup", color: "#94A3B8" },
  svg: { kind: "image", color: "#F59E0B" },
  png: { kind: "image", color: "#22C55E" },
  jpg: { kind: "image", color: "#22C55E" },
  jpeg: { kind: "image", color: "#22C55E" },
  gif: { kind: "image", color: "#22C55E" },
  webp: { kind: "image", color: "#22C55E" },
  avif: { kind: "image", color: "#22C55E" },
  ico: { kind: "image", color: "#22C55E" },
  bmp: { kind: "image", color: "#22C55E" },
  mp4: { kind: "media", color: "#A855F7" },
  mov: { kind: "media", color: "#A855F7" },
  webm: { kind: "media", color: "#A855F7" },
  mp3: { kind: "media", color: "#A855F7" },
  wav: { kind: "media", color: "#A855F7" },
  flac: { kind: "media", color: "#A855F7" },
  m4a: { kind: "media", color: "#A855F7" },
  ogg: { kind: "media", color: "#A855F7" },
  zip: { kind: "archive", color: "#D97706" },
  tar: { kind: "archive", color: "#D97706" },
  gz: { kind: "archive", color: "#D97706" },
  tgz: { kind: "archive", color: "#D97706" },
  "7z": { kind: "archive", color: "#D97706" },
  rar: { kind: "archive", color: "#D97706" },
  zst: { kind: "archive", color: "#D97706" },
  xz: { kind: "archive", color: "#D97706" },
  pdf: { kind: "pdf", color: "#EF4444" },
  sql: { kind: "db", color: "#06B6D4" },
  sqlite: { kind: "db", color: "#06B6D4" },
  db: { kind: "db", color: "#06B6D4" },
  sh: { kind: "shell", color: "#22C55E" },
  bash: { kind: "shell", color: "#22C55E" },
  zsh: { kind: "shell", color: "#22C55E" },
  fish: { kind: "shell", color: "#22C55E" },
  ps1: { kind: "shell", color: "#22C55E" },
  mk: { kind: "make", color: "#94A3B8" },
};

const BY_NAME: Record<string, FileType> = {
  dockerfile: { kind: "docker", color: "#3B82F6" },
  ".dockerignore": { kind: "docker", color: "#3B82F6" },
  makefile: { kind: "make", color: "#94A3B8" },
  ".gitignore": { kind: "git", color: "#F97316" },
  ".gitattributes": { kind: "git", color: "#F97316" },
  ".gitmodules": { kind: "git", color: "#F97316" },
  ".gitkeep": { kind: "git", color: "#F97316" },
  "go.mod": code("#06B6D4"),
  "go.sum": code("#06B6D4"),
  "package.json": data("#EAB308"),
  "package-lock.json": data("#94A3B8"),
  "tsconfig.json": data("#3B82F6"),
};

/** 按文件名判断类型：特殊文件名优先，其次扩展名，最后回落通用文件。 */
export function classifyFile(name: string): FileType {
  const lower = name.toLowerCase();
  const named = BY_NAME[lower];
  if (named) return named;

  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : "";
  const byExt = ext ? BY_EXT[ext] : undefined;
  if (byExt) return byExt;

  // 没有扩展名但一眼能认出来的：README / LICENSE / .env.* / Dockerfile.*
  if (lower.startsWith("readme")) return doc("#60A5FA");
  if (lower.startsWith("license") || lower.startsWith("copying")) return doc("#EAB308");
  if (lower.startsWith(".env")) return data("#EAB308");
  if (lower.startsWith("dockerfile")) return { kind: "docker", color: "#3B82F6" };
  return { kind: "file", color: "#94A3B8" };
}

function glyph(kind: FileKind, color: string) {
  const line = {
    fill: "none",
    stroke: color,
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (kind) {
    case "code":
      return <path {...line} d="M5.5 4.5 2.5 8l3 3.5M10.5 4.5 13.5 8l-3 3.5" />;
    case "data":
      return (
        <path
          {...line}
          d="M6 2.6c-1.4 0-1.4 1.3-1.4 2.7S4 8 2.6 8c1.4 0 2 .7 2 2.7s0 2.7 1.4 2.7M10 2.6c1.4 0 1.4 1.3 1.4 2.7S12 8 13.4 8c-1.4 0-2 .7-2 2.7s0 2.7-1.4 2.7"
        />
      );
    case "doc":
      return (
        <>
          <path {...line} d="M4 2.5h5l3 3v8H4z" />
          <path {...line} d="M9 2.5v3h3M5.8 8h4.4M5.8 10.4h4.4" />
        </>
      );
    case "style":
      return <path {...line} d="M6 2.5 4.5 13.5M11.5 2.5 10 13.5M2.5 6h11M2 10h11" />;
    case "markup":
      return <path {...line} d="M6 4 2.5 8 6 12M10 4l3.5 4L10 12M9.2 3 6.8 13" />;
    case "image":
      return (
        <>
          <rect {...line} x="2" y="3" width="12" height="10" rx="1.6" />
          <circle {...line} cx="5.6" cy="6.4" r="1.1" />
          <path {...line} d="M3 11.6 6.4 8l2.4 2.4L11 8.6l2.2 2.6" />
        </>
      );
    case "media":
      return (
        <>
          <rect {...line} x="2" y="3.2" width="12" height="9.6" rx="2" />
          <path d="M6.6 6.2 10.2 8 6.6 9.8Z" fill={color} />
        </>
      );
    case "archive":
      return (
        <>
          <path {...line} d="M2.5 5.5h11v7.5h-11z" />
          <path {...line} d="M2.5 5.5 4 2.8h8l1.5 2.7M7 8.2h2" />
        </>
      );
    case "pdf":
      return (
        <>
          <path {...line} d="M4 2.5h5l3 3v8H4z" />
          <path {...line} d="M9 2.5v3h3M5.6 11.6c1.6-1.1 3.2-1.1 4.8 0" />
        </>
      );
    case "db":
      return (
        <>
          <ellipse {...line} cx="8" cy="4.2" rx="5" ry="1.9" />
          <path {...line} d="M3 4.2v7.6c0 1 2.2 1.9 5 1.9s5-.9 5-1.9V4.2" />
        </>
      );
    case "shell":
      return (
        <>
          <rect {...line} x="2" y="3" width="12" height="10" rx="2" />
          <path {...line} d="M4.6 6.6 6.6 8.2l-2 1.6M8.4 10h3" />
        </>
      );
    case "git":
      return (
        <>
          <circle {...line} cx="5" cy="4" r="1.5" />
          <circle {...line} cx="5" cy="12" r="1.5" />
          <circle {...line} cx="11" cy="7" r="1.5" />
          <path {...line} d="M5 5.5v5M9.6 7.8C8.4 9.2 7 10 5 10.5" />
        </>
      );
    case "docker":
      return (
        <>
          <path {...line} d="M2.5 9.5h11c0 2.2-2 3.5-5.5 3.5S2.5 11.7 2.5 9.5Z" />
          <path {...line} d="M4 6.2h2.6v2.6H4zM7.2 6.2h2.6v2.6H7.2zM7.2 3.4h2.6v2.4H7.2z" />
        </>
      );
    case "make":
      // 14px 下 8 齿的齿轮会糊成一团雪花，只留 4 个方向。
      return (
        <>
          <circle {...line} cx="8" cy="8" r="2.6" />
          <path {...line} d="M8 2.2v2.6M8 11.2v2.6M2.2 8h2.6M11.2 8h2.6" />
        </>
      );
    default:
      return (
        <>
          <path {...line} d="M4 2.5h5l3 3v8H4z" />
          <path {...line} d="M9 2.5v3h3" />
        </>
      );
  }
}

/** 文件图标：按名字自动选图形与颜色。 */
export function FileIcon({
  name,
  size = 14,
  className = "",
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const { kind, color } = classifyFile(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {glyph(kind, color)}
    </svg>
  );
}

/** 文件夹图标：展开时用开口版本，和文件树里的箭头状态对得上。 */
export function FolderIcon({
  open = false,
  size = 14,
  className = "",
}: {
  open?: boolean;
  size?: number;
  className?: string;
}) {
  const color = "#E8B65A";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {open ? (
        <>
          <path
            d="M1.6 12.2V4.7a1 1 0 0 1 1-1h3.1l1.2 1.5h6.4a1 1 0 0 1 1 1v1.1"
            fill="none"
            stroke={color}
            strokeWidth={1.3}
            strokeLinejoin="round"
          />
          <path
            d="M1.6 12.2 3.4 7.1a1 1 0 0 1 .95-.7h9.1a.6.6 0 0 1 .57.8l-1.3 4.2a1 1 0 0 1-.95.7H2.2a.6.6 0 0 1-.6-.7Z"
            fill={color}
            fillOpacity="0.3"
            stroke={color}
            strokeWidth={1.2}
            strokeLinejoin="round"
          />
        </>
      ) : (
        <path
          d="M1.6 12.2V4.7a1 1 0 0 1 1-1h3.1l1.2 1.5h6.4a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1Z"
          fill={color}
          fillOpacity="0.3"
          stroke={color}
          strokeWidth={1.3}
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
