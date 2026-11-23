import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/runtime";
import { applyCLI } from "../../lib/normalize";
import type { Item } from "../../lib/model";
import type { SubagentTranscriptPayload } from "../../transport/types";
import { MessageList } from "../chat/MessageList";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../store/useAppStore";

/**
 * 一个子代理的对话。
 *
 * 数据来自旁路转录（`<session>/subagents/agent-<id>.jsonl`）：主转录里没有 sidechain
 * 行，所以不能靠回放主对话得到子代理说过什么。
 */
export function SubagentPanel({ sessionId, agentId }: { sessionId: string; agentId: string }) {
  const t = useT();
  const [items, setItems] = useState<Item[]>([]);
  const [meta, setMeta] = useState<SubagentTranscriptPayload["meta"]>(undefined);
  const [state, setState] = useState<"loading" | "ok" | "missing">("loading");
  // 实时帧（--forward-subagent-text）优先：转录是落盘快照，会比界面慢一拍。
  const live = useAppStore((s) => s.subagentItems[sessionId]?.[agentId]);

  useEffect(() => {
    let alive = true;
    setState("loading");
    setItems([]);
    setMeta(undefined);
    void (async () => {
      try {
        const tr = await apiFetch<SubagentTranscriptPayload>(
          `/api/history/subagent?id=${encodeURIComponent(sessionId)}&agent=${encodeURIComponent(agentId)}`,
        );
        let next: Item[] = [];
        for (const line of tr.lines ?? []) {
          const rec = line as { timestamp?: unknown };
          const at = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
          // 同样是转录回放：关掉「CLI 回显去重」（子代理转录里也没有本地乐观气泡，
          // 每一条 user 行都是真的发过的）。**要打开 sidechain**：这整份文件就是
          // sidechain 行，按主消息流的规则过滤会得到一份空转录。
          next = applyCLI(next, line, Number.isFinite(at) ? at : Date.now(), undefined, {
            replay: true,
            sidechain: true,
          });
        }
        if (!alive) return;
        setMeta(tr.meta);
        setItems(next);
        setState("ok");
      } catch {
        // 子代理转录可能已被 claude 清理，或这台机器上没有那份文件。
        if (alive) setState("missing");
      }
    })();
    return () => {
      alive = false;
    };
  }, [sessionId, agentId]);

  /**
   * 面板里显示的条目：**实时流 + 转录里的派发消息**，不是二选一。
   *
   * 实时帧（`--forward-subagent-text`）只带子代理**自己说的话**：它是由主会话那条
   * Agent `tool_use` 发起的，而 `prompt` 是那次调用的入参——从来不会出现在子代理
   * 的 stdout 里。于是「优先用实时那份」会得到一个没有开头的问题面板：用户点开
   * 「查看对话」，看到的是一串没有前提的步骤（截图复现过）。
   *
   * 转录里则一定有那条派发消息（子代理 jsonl 的首条 user 行就是 prompt），所以
   * 从转录那份里**只取开头的 user 条目**接到实时流前面。不整份回落到转录：那份是
   * 落盘快照，会比界面慢一拍，正在跑的时候尾巴上缺一段。
   *
   * 实时流自己已经有 user 条目时（CLI 版本把它转发过来了）不重复补——按「实时那份
   * 从头到第一条非 user」判，避免同一条 prompt 出现两遍。
   */
  const merged = useMemo(() => {
    if (!live || live.length === 0) return items;
    // 转录那份开头的连续 user 条目 = 派发消息（子代理 jsonl 的首条 user 行）。
    let cut = 0;
    while (cut < items.length && items[cut].kind === "user") cut += 1;
    const heads = items.slice(0, cut);
    if (heads.length === 0) return live;
    // 实时那份开头已经有同样多的 user 条目时不再补（CLI 把它转发过来了）。
    let liveCut = 0;
    while (liveCut < live.length && live[liveCut].kind === "user") liveCut += 1;
    if (liveCut >= heads.length) return live;
    return [...heads, ...live.slice(liveCut)];
  }, [live, items]);

  if (state === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-muted">
        {t("正在加载子代理对话…", "Loading subagent chat…")}
      </div>
    );
  }
  if (state === "missing") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
        <p className="text-[12.5px] font-medium text-ink">{t("没有可显示的对话", "No transcript")}</p>
        <p className="text-[11px] leading-relaxed text-muted">
          {t("这个子代理的转录不在磁盘上（可能已被 claude 清理）。", "This subagent transcript is not on disk anymore.")}
        </p>
      </div>
    );
  }

  const subtitle = [
    meta?.agentType,
    typeof meta?.spawnDepth === "number" ? t(`深度 ${meta.spawnDepth}`, `depth ${meta.spawnDepth}`) : undefined,
    meta?.finished ? t("已结束", "finished") : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-line px-3 py-2">
        <p className="truncate text-[12px] font-medium text-ink">{meta?.description || agentId}</p>
        <p className="mt-0.5 truncate text-[10.5px] text-muted">{subtitle || agentId}</p>
      </div>
      <div className="min-h-0 flex-1">
        <MessageList
          items={merged}
          empty={t("子代理还没有输出", "No output from this subagent yet")}
        />
      </div>
    </div>
  );
}
