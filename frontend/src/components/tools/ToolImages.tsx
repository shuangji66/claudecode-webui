import type { ToolItem } from "../../lib/model";
import { useT } from "../../lib/i18n";

/**
 * tool_result 里的图片缩略图。
 *
 * normalize 会把 image 内容块拆成「文本占位 + ToolItem.images」，占位只是给人看的
 * 一句话，图片本体必须由卡片画出来——原先只有兜底卡片画，注册过卡片的工具
 * （Bash / Edit / Write / Agent）带图片时用户只能看到「[图片 image/png，约 12 KB]」。
 */
export function ToolImages({ item }: { item: ToolItem }) {
  const t = useT();
  if (!item.images || item.images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {item.images.map((img, i) => (
        <img
          key={`${i}-${img.mediaType}`}
          src={`data:${img.mediaType};base64,${img.data}`}
          alt={t("工具结果图片", "Tool result image")}
          className="max-h-80 w-auto rounded-lg border border-line"
        />
      ))}
    </div>
  );
}
