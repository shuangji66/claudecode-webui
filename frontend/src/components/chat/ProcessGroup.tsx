import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  IconChevronRight,
  IconFile,
  IconFolder,
  IconGlobe,
  IconSearch,
  IconSliders,
  IconSpark,
  IconTerminal,
  IconWrench,
} from "../common/Icons";
import type { Item } from "../../lib/model";
import { useFollowGrowth } from "../../lib/scrollFollow";
import { useLocale, useT } from "../../lib/i18n";
import { dominantCategory, groupTitle, liveDetail, reasoningPreview, type ProcessMode, type ToolCategory } from "../../lib/process";

const ICONS: Record<ToolCategory, (props: { size?: number; className?: string }) => ReactNode> = {
  read: IconFile,
  search: IconSearch,
  write: IconFolder,
  edit: IconWrench,
  commands: IconTerminal,
  webSearch: IconGlobe,
  webFetch: IconGlobe,
  subagents: IconSpark,
  plan: IconSliders,
  tools: IconWrench,
  analysis: IconSpark,
};

/**
 * 过程组：同一轮内连续出现的思考与工具调用折成一块（口径对齐 DSH）。
 *
 * 三档只影响显示多少：
 *   - 简洁：只显示一行组头（人话摘要），不显示推理预览；
 *   - 标准：组头追加「正在做什么」或思考首行；
 *   - 详细：运行中不显示组头，直接把每一步铺开（卡片），回答一出现就收起。
 *
 * 收起时机有两种（对齐 DSH 的「过程收起时机」）：
 *   - 完成时收起（默认）：整轮结束（`result` 到达）才折回组头。**中途写一句过渡回复不算结束**
 *     ——按「后面出现任何内容」判断的话，任务进行中每写一句就收起、下一步再展开，全是跳跃；
 *   - 下次发送时收起：最新一轮的组在回答出现后仍然展开（详细模式保持平铺、不显示组头），
 *     等用户发出下一条消息才收起。
 * 用户手动开合过的组不再被自动逻辑改动（`touched`）；自动展开/收起的组由 `auto` 记着，
 * 只在「自己开过」的情况下才自动收，免得把用户点开的历史组一并合上。
 */
export function ProcessGroup({
  items,
  live,
  atTail,
  view,
  keepOpen = false,
  children,
}: {
  items: Item[];
  /** 这一组所属的轮次还在跑（后面没有 result）：详细模式据此平铺、收起时机也只看它。 */
  live: boolean;
  /** 这一组还是列表里最后一段内容：决定组头写「正在…／进行中」还是完成摘要。 */
  atTail: boolean;
  view: ProcessMode;
  /** 「下次发送时收起」下，这一组属于最新一轮：回合结束后仍保持展开。 */
  keepOpen?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(view === "detailed" && live);
  /** 用户手动开合过：模式切换不再改它的开合。 */
  const touched = useRef(false);
  /** 上一次是不是「运行中/保留期」：true→false 就是收起时机（完成 / 下次发送）。 */
  const active = useRef(live || keepOpen);
  /** 正文还能往哪个方向滚：只有真能滚的方向才给渐隐，否则一屏放得下也会糊一条边。 */
  const body = useRef<HTMLDivElement | null>(null);
  /** 正文内容（ResizeObserver 的观察对象）：展开里面的思考 / 工具卡片时高度就是它在变。 */
  const inner = useRef<HTMLDivElement | null>(null);
  const [fade, setFade] = useState({ top: false, bottom: false });
  // 详细模式在「运行中」与「下次发送时收起」的保留期里都平铺正文、不显示组头。
  const flat = view === "detailed" && (live || keepOpen);
  // 平铺时不设组级限高：卡片本来就要完整铺开；其余情况限高，避免一屏只有过程。
  const capped = !flat;

  useEffect(() => {
    const running = live || keepOpen;
    // 收起时机：这一段从「进行中/保留期」结束——完成时收起，或用户发出了下一条消息。
    // 这里连手动展开过的组也一起收：需求就是「回答一到就折叠过程」。
    if (active.current && !running) {
      setOpen(false);
      touched.current = false;
    }
    active.current = running;
    if (!running || touched.current) return;
    // 运行中的呈现：详细模式平铺（等价展开），简洁/标准保持收起；
    // 保留期（下次发送时收起）一律展开，否则「推迟收起」在简洁/标准下看不出区别。
    setOpen(live ? view === "detailed" : true);
  }, [live, view, keepOpen]);

  // 边缘渐隐：正文自身滚动 + 里面内容变高都要重算。
  useEffect(() => {
    const el = body.current;
    if (!el || !open) return;
    const update = () => {
      const top = el.scrollTop > 4;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 4;
      setFade((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    if (inner.current) ro?.observe(inner.current);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, [open, capped]);

  // 展开组里的某一步（思考过程 / 工具卡片）时，组正文这个限高滚动区也要贴底跟随：
  // 新露出来的内容留在视口外，等于「点了没反应」。规则与对话区一致——正文被往上
  // 划过就不跟，滑回底部自然恢复，不显示额外状态。
  useFollowGrowth(body, inner, () => true, capped && open);

  // 组头文案看的是「这一组自己有没有结束」（后面还有没有内容），不是整轮。
  const phase = atTail ? "running" : "done";
  const title = groupTitle(items, phase, locale);
  const detail = view === "concise" ? "" : live ? liveDetail(items) : reasoningPreview(items);
  const Icon = ICONS[dominantCategory(items)];

  if (flat) {
    return <div className="space-y-2">{children}</div>;
  }

  return (
    <div className="rounded-lg border border-line/70 bg-panel/25">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          touched.current = true;
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[11.5px] text-muted hover:bg-panel-strong/60 hover:text-ink"
      >
        <IconChevronRight size={12} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
        <Icon size={12} className="shrink-0" />
        <span className="shrink-0 font-medium text-ink-2">{title}</span>
        {detail && <span className="min-w-0 flex-1 truncate text-[10.5px] text-faint">{detail}</span>}
        {!detail && <span className="flex-1" />}
        {atTail && <span className="shrink-0 text-[10px] text-brand">{t("进行中", "Running")}</span>}
      </button>
      {/* 横向一律不滚：行内文字必须自己省略，绝不能把整组撑出横向滚动条。
          用 overflow-x-clip 而不是 hidden：hidden 会把元素变成滚动容器（y 轴被算成 auto），
          手机上又多一层能拦截触摸的滚动区。限高只在 md 以上生效，手机上展开的组
          跟页面一起滚，只有一个滚动上下文。 */}
      {open && (
        <div
          ref={body}
          data-testid="process-body"
          className={`dsh-scroll overflow-x-clip px-1 pb-1 ${
            capped ? "md:max-h-[min(400px,50vh)] md:overflow-y-auto" : ""
          } ${
            fade.top && fade.bottom ? "process-fade-both" : fade.bottom ? "process-fade-bottom" : fade.top ? "process-fade-top" : ""
          }`}
        >
          <div ref={inner} className={view === "detailed" ? "space-y-2" : "space-y-1"}>
            {children}
          </div>
        </div>
      )}
    </div>
  );
}
