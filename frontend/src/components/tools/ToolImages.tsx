import { useState } from "react";
import type { ToolItem } from "../../lib/model";
import { useT } from "../../lib/i18n";
import { ImageLightbox } from "../chat/ImageLightbox";

/**
 * tool_result 里的图片缩略图。
 *
 * normalize 会把 image 内容块拆成「文本占位 + ToolItem.images」，占位只是给人看的
 * 一句话，图片本体必须由卡片画出来——原先只有兜底卡片画，注册过卡片的工具
 * （Bash / Edit / Write / Agent）带图片时用户只能看到「[图片 image/png，约 12 KB]」。
 *
 * 缩略图可点开放大（与用户气泡里的图片同一条路，复用 `ImageLightbox`）：
 * 模型读进来的截图往往只有一两百像素宽，`max-h-80` 的缩略图在手机上根本看不清。
 * 灯箱只做缩放，不给「在右侧栏打开」——工具结果没有「工作区相对路径」这个概念
 * （`file_path` 是绝对路径，图片也可能来自截图工具而不落在磁盘上）。
 */
export function ToolImages({ item }: { item: ToolItem }) {
  const t = useT();
  const [preview, setPreview] = useState<number | null>(null);
  const images = item.images ?? [];
  if (images.length === 0) return null;
  const shown = preview !== null ? images[preview] : undefined;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {images.map((img, i) => (
          <button
            key={`${i}-${img.mediaType}`}
            type="button"
            onClick={() => setPreview(i)}
            className="shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-line"
            aria-label={t("预览图片", "Preview image")}
            title={t("点开看大图", "Open a larger view")}
          >
            <img
              src={`data:${img.mediaType};base64,${img.data}`}
              alt={t("工具结果图片", "Tool result image")}
              className="max-h-80 w-auto"
            />
          </button>
        ))}
      </div>
      {shown && (
        <ImageLightbox
          // 换图时重置缩放：组件在 src 为空时只 return null，state 还留着。
          key={preview}
          src={`data:${shown.mediaType};base64,${shown.data}`}
          alt={imageLabel(item, t)}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

/** 灯箱标题：Read 类工具用入参里的文件路径，其它工具给一句泛称。 */
function imageLabel(item: ToolItem, t: (zh: string, en?: string) => string): string {
  const path = (item.input as { file_path?: unknown } | null | undefined)?.file_path;
  if (typeof path === "string" && path !== "") return path;
  return t("工具结果图片", "Tool result image");
}
