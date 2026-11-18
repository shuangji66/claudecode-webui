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

      {/* 预览窗口固定 1:1：边长取容器的短边（min(100cqw, 100cqh)）——
          宽图上下留黑、竖图左右留黑，都比"按图片比例撑开"更容易比较两张图。
          `container-type: size` 让 cqw/cqh 参考这一层，而不是视口。
          缩放发生在正方形内部（内层 overflow-auto），所以放大了也还是在这块窗口里滚。 */}
      <div
        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/90"
        style={{ containerType: "size" }}
      >
        <div
          className="shrink-0 overflow-auto"
          style={{ width: "min(100cqw, 100cqh)", aspectRatio: "1 / 1" }}
        >
          <ZoomableImage src={src} alt={alt} zoom={zoom} />
        </div>
      </div>

      <ZoomBar zoom={zoom} onChange={setZoom} />
    </Dialog>
  );
}
