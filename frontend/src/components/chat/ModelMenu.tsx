// 输入框里的模型 / 推理等级菜单。
//
// 参照 DSH 的两级菜单：一级只有「模型」「推理等级」两行（值 + 右箭头），
// 点进去分别是按提供商分组的模型列表和档位列表。这样模型很多时仍然好找，
// 也避免在工具条上并排放两个下拉把输入区挤窄。
//
// 档位列表是「默认 / 关闭 / 模型声明的档位」：「默认」不向 API 声明推理等级，
// 「关闭」关掉思考（后端改用 MAX_THINKING_TOKENS=0，见 lib/providerForm 的 effortChoices）。
//
// 菜单只负责选择；模型能力（图片、上下文窗口）不在这里展示。

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EFFORT_OFF, effortChoices, type ModelOption } from "../../lib/providerForm";
import { useT } from "../../lib/i18n";
import { POPUP_PANEL, PORTAL_ATTR, useAnchoredPanel, useDismiss } from "../common/Menu";
import { IconCheck, IconChevronDown, IconChevronLeft, IconChevronRight, IconSpark } from "../common/Icons";

interface Props {
  options: ModelOption[];
  /** `${provider}/${model}`；空表示尚未选择。 */
  selectedKey: string;
  selectedEffort: string;
  disabled: boolean;
  onSelectModel: (provider: string, model: string) => void;
  onSelectEffort: (effort: string) => void;
}

type Pane = "root" | "model" | "effort";

interface ProviderGroup {
  id: string;
  name: string;
  models: ModelOption[];
}

/** 档位值保持小写传给后端，展示时首字母大写；xhigh 写成可读的 Extra high。 */
function effortName(effort: string): string {
  if (!effort) return effort;
  if (effort === "xhigh") return "Extra high";
  return effort[0].toUpperCase() + effort.slice(1);
}

/** 按提供商分组，保持设置里的提供商顺序。 */
export function groupModelOptions(options: ModelOption[]): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>();
  for (const option of options) {
    const group = groups.get(option.provider) ?? { id: option.provider, name: option.providerName, models: [] };
    group.models.push(option);
    groups.set(option.provider, group);
  }
  return [...groups.values()];
}

export function ModelMenu({ options, selectedKey, selectedEffort, disabled, onSelectModel, onSelectEffort }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<Pane>("root");
  const [query, setQuery] = useState("");
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => `${o.provider}/${o.model}` === selectedKey);
  const modelLabel = selected ? selected.spec.name || selected.model : t("未添加模型", "No models");
  const efforts = effortChoices(selected?.spec);
  /** 「默认」「关闭」两档是界面自己的词，其余档位沿用设置里声明的值。 */
  const effortLabel = (effort: string) => {
    if (!effort) return t("默认", "Default");
    if (effort === EFFORT_OFF) return t("关闭", "Off");
    return effortName(effort);
  };
  const groups = useMemo(() => groupModelOptions(options), [options]);
  const showSearch = options.length > 4;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((group) => ({
        ...group,
        models: group.models.filter(
          (o) => o.model.toLowerCase().includes(q) || (o.spec.name ?? "").toLowerCase().includes(q),
        ),
      }))
      .filter((group) => group.models.length > 0);
  }, [groups, query]);

  const width = Math.min(300, Math.max(220, typeof window === "undefined" ? 300 : window.innerWidth - 24));
  // 固定按二级菜单的最大高度决定展开方向；否则从一级切到二级时会翻边/上移。
  const pos = useAnchoredPanel(anchorRef.current, open, width, 420, "start");

  const close = (restoreFocus = false) => {
    setOpen(false);
    setPane("root");
    setQuery("");
    if (restoreFocus) queueMicrotask(() => anchorRef.current?.focus());
  };

  useDismiss(open, menuRef, anchorRef.current, () => close(), () => {
    // Esc 先从二级页退回一级，再按一次才关闭。
    if (pane === "root") return false;
    setPane("root");
    setQuery("");
    return true;
  });

  // 切换页签后把焦点放进菜单，键盘用户不会掉到页面背景上。
  useEffect(() => {
    if (!open) return;
    if (pane === "model" && showSearch) {
      searchRef.current?.focus();
      return;
    }
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')?.focus();
  }, [open, pane, showSearch]);

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled])',
      ) ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const active = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = active < 0 ? (step > 0 ? 0 : items.length - 1) : (active + step + items.length) % items.length;
    items[next]?.focus();
  };

  const show = () => {
    setPane("root");
    setQuery("");
    setOpen(true);
  };

  const header = (title: string) => (
    <div className="flex items-center gap-1 px-1 pb-1">
      <button
        type="button"
        onClick={() => {
          setPane("root");
          setQuery("");
        }}
        className="rounded-md p-1 text-muted hover:bg-panel-strong hover:text-ink"
        aria-label={t("返回", "Back")}
      >
        <IconChevronLeft size={14} />
      </button>
      <span className="text-[10.5px] font-medium text-muted">{title}</span>
    </div>
  );

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        disabled={disabled || options.length === 0}
        onClick={() => (open ? close() : show())}
        aria-label={t("模型与推理等级", "Model and reasoning level")}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${modelLabel}${efforts.length > 0 ? ` · ${effortLabel(selectedEffort)}` : ""}`}
        className="flex min-w-0 flex-1 items-center gap-1 rounded-full px-2 py-1 text-[11px] text-muted outline-none hover:bg-panel-strong hover:text-ink focus-visible:bg-panel-strong disabled:cursor-not-allowed disabled:opacity-40"
      >
        <IconSpark size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">{options.length === 0 ? t("未添加模型", "No models") : modelLabel}</span>
        {efforts.length > 0 && <span className="shrink-0 text-[10.5px] text-faint">{effortLabel(selectedEffort)}</span>}
        <IconChevronDown size={11} className={`shrink-0 opacity-60 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && pos
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label={t("模型与推理等级", "Model and reasoning level")}
              {...{ [PORTAL_ATTR]: "" }}
              style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width, maxHeight: pos.maxHeight }}
              onKeyDown={onMenuKeyDown}
              className={`${POPUP_PANEL} overflow-y-auto dsh-scroll`}
            >
              {pane === "root" && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => setPane("model")}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-panel-strong"
                  >
                    <span className="shrink-0 text-[11.5px] text-muted">{t("模型", "Model")}</span>
                    <span className="min-w-0 flex-1 truncate text-right text-[12px] font-medium text-ink">{modelLabel}</span>
                    <IconChevronRight size={13} className="shrink-0 text-faint" />
                  </button>
                  {efforts.length > 0 && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => setPane("effort")}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-panel-strong"
                    >
                      <span className="shrink-0 text-[11.5px] text-muted">{t("推理等级", "Reasoning level")}</span>
                      <span className="min-w-0 flex-1 truncate text-right text-[12px] font-medium text-ink">{effortLabel(selectedEffort)}</span>
                      <IconChevronRight size={13} className="shrink-0 text-faint" />
                    </button>
                  )}
                </>
              )}

              {pane === "model" && (
                <>
                  {header(t("模型", "Model"))}
                  {showSearch && (
                    <input
                      ref={searchRef}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={t("搜索模型…", "Search models…")}
                      aria-label={t("搜索模型", "Search models")}
                      className="mb-1 w-full rounded-lg border border-line-strong bg-canvas px-2 py-1.5 text-[11.5px] outline-none placeholder:text-faint focus:border-brand/60"
                    />
                  )}
                  {filtered.length === 0 && (
                    <p className="px-2 py-4 text-center text-[11px] text-faint">{t("没有匹配的模型。", "No matching models.")}</p>
                  )}
                  {filtered.map((group) => (
                    <div key={group.id}>
                      <div className="sticky top-0 z-10 bg-canvas px-2.5 py-1 text-[10px] font-medium text-faint">{group.name}</div>
                      {group.models.map((option) => {
                        const value = `${option.provider}/${option.model}`;
                        const active = value === selectedKey;
                        return (
                          <button
                            key={value}
                            type="button"
                            role="menuitemradio"
                            aria-checked={active}
                            onClick={() => {
                              // 选中的就是当前值：只收起菜单，不重复提交设置。
                              if (!active) onSelectModel(option.provider, option.model);
                              close(true);
                            }}
                            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-panel-strong ${
                              active ? "bg-panel-strong" : ""
                            }`}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[12px] text-ink">{option.spec.name || option.model}</span>
                              {option.spec.name && option.spec.name !== option.model && (
                                <span className="block truncate font-mono text-[9.5px] text-faint">{option.model}</span>
                              )}
                            </span>
                            {active && <IconCheck size={13} className="shrink-0 text-brand" />}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </>
              )}

              {pane === "effort" && (
                <>
                  {header(t("推理等级", "Reasoning level"))}
                  {efforts.map((effort) => {
                    const active = effort === selectedEffort;
                    return (
                      <button
                        key={effort}
                        type="button"
                        role="menuitemradio"
                        aria-checked={active}
                        onClick={() => {
                          if (!active) onSelectEffort(effort);
                          close(true);
                        }}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] hover:bg-panel-strong ${
                          active ? "bg-panel-strong text-ink" : "text-ink-2"
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate">{effortLabel(effort)}</span>
                        {active && <IconCheck size={13} className="shrink-0 text-brand" />}
                      </button>
                    );
                  })}
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
