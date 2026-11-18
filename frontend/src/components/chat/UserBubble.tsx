import { useState } from "react";
import { clockTime } from "../../lib/labels";
import { imageDataUrl } from "../../lib/attachments";
import type { UserImage } from "../../lib/model";
import { useLocale, useT } from "../../lib/i18n";
import { CopyButton } from "./CopyButton";
import { ImageLightbox } from "./ImageLightbox";

/**
 * 用户消息气泡。
 *
 * 图片附件直接画在气泡里（不是在正文里写「附件：a.png」）：截图/图片就是内容本身，
 * 缩略图可点开看大图——与 DSH 一样。文本文件、PDF 仍以正文那一行出现。
 */
export function UserBubble({ text, ts, images = [] }: { text: string; ts?: number; images?: UserImage[] }) {
  const t = useT();
  const locale = useLocale();
  const [preview, setPreview] = useState<UserImage | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="chat-text max-w-[86%] rounded-[18px] rounded-br-[6px] bg-bubble px-4 py-2.5 text-ink">
        {images.length > 0 && (
          <div className={`flex flex-wrap justify-end gap-1.5 ${text ? "mb-2" : ""}`}>
            {images.map((image, index) => (
              <button
                key={`${image.name}-${index}`}
                type="button"
                onClick={() => setPreview(image)}
                className="shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-line/60"
                aria-label={t(`预览图片 ${image.name}`, `Preview image ${image.name}`)}
                title={t("点开看大图", "Open a larger view")}
              >
                <img
                  src={imageDataUrl(image.mediaType, image.data)}
                  alt={image.name}
                  className="max-h-40 max-w-[16rem] object-cover"
                />
              </button>
            ))}
          </div>
        )}
        {text && <div className="whitespace-pre-wrap break-words">{text}</div>}
      </div>
      <div className="flex items-center gap-1.5 pr-1 text-[10.5px] text-faint">
        {typeof ts === "number" && ts > 0 && <span className="tabular-nums">{clockTime(ts, locale)}</span>}
        <CopyButton text={text} label={t("复制消息", "Copy message")} />
      </div>

      {preview && (
        <ImageLightbox
          key={preview.name}
          src={imageDataUrl(preview.mediaType, preview.data)}
          alt={preview.name}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
