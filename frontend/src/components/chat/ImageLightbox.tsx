import { useState } from "react";
import { Dialog } from "../common/Dialog";
import { Button } from "../common/Button";
import { ZoomBar, ZoomableImage } from "../common/Zoomable";
import { IconClose, IconFolder } from "../common/Icons";
import { useT } from "../../lib/i18n";

/**
 * 正文图片的放大查看。
 *
 * 用统一的 Dialog 外壳（遮罩 / Esc / 背景滚动锁都在里面），但走 `bare` + `hideClose`：
 * 顶部要放一排自己的操作（文件名、在右侧栏打开、关闭），放在 Dialog 自带的 header
 * 里就得给公共组件加 header slot，为这一个场景不值当。
 *
 * 布局是三段：顶部栏、图片区（`flex-1 min-h-0`）、缩放栏，都 `shrink-0` 之外的两条固定，
 * 图片区自己收缩——先前把操作放 footer 时，`76dvh` 的图加上下两条栏在手机上会顶出面板。
 *
 * `rel` 存在时（来源是工作区文件）才给「在右侧栏打开」：接着往上滚思维链时，
 * 右侧栏的预览不会被新内容顶走，多张图也能来回切。
 */
export function ImageLightbox({
  src,
  alt,
  rel,
  onClose,
  onOpenSidebar,
}: {
  /** 已经可直接给 <img> 的地址；空串表示不打开。 */
  src: string | null;
  alt: string;
  /** 工作区内的相对路径；data URI 之类的内联图片没有。 */
  rel?: string | undefined;
  onClose: () => void;
  /** 未提供时不显示按钮（内联图片没有可打开的文件）。 */
  onOpenSidebar?: (() => void) | undefined;
}) {
  const t = useT();
  const [zoom, setZoom] = useState(1);
  if (!src) return null;
  const title = alt || t("图片预览", "Image preview");

  return (
    <Dialog
      open
      onClose={onClose}
      label={title}
      size="xl"
      bare
      hideClose
      centered
      bodyScroll={false}
      // 高度要确定下来，图片区才能算出 1:1 的边长（靠 cqh）。
      // 桌面尺寸对齐「设置」弹窗（md:h-[82vh] / md:max-w-[900px]）。
      panelClassName="h-full md:h-[82vh] md:max-w-[900px]"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={rel ?? title}>
          {rel ?? title}
        </span>
        {onOpenSidebar !== undefined && (
          <Button variant="secondary" size="sm" onClick={onOpenSidebar}>
            <IconFolder size={14} />
            {t("在右侧栏打开", "Open in sidebar")}
          </Button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink"
          aria-label={t("关闭", "Close")}
        >
          <IconClose size={18} />
        </button>
      </div>

      {/* 图片区铺满面板剩下的空间：不再套一个固定 1:1 的正方形。正方形在宽图上
          上下留一大片黑、竖图上左右留一大片黑，而面板本身已经够宽——把它撑满才
          看得出「这是个查看器」而不是「一个嵌在黑色里的小窗」。
          取景（缩放 + 平移）交给 `ZoomableImage` 的 `pannable`：滚轮缩放、拖动平移，
          图片区这一层 `overflow-hidden`，放大后不出现滚动条。 */}
      <div className="flex min-h-0 flex-1 overflow-hidden bg-black/90">
        <ZoomableImage
          src={src}
          alt={alt}
          zoom={zoom}
          pannable
          onZoomChange={setZoom}
        />
      </div>

      <ZoomBar zoom={zoom} onChange={setZoom} />
    </Dialog>
  );
}
