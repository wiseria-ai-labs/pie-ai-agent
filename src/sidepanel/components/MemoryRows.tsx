import { useState } from "react";
import { Brain, Check } from "lucide-react";
import { useT } from "@/lib/i18n";
import { undoMemoryEvent } from "@/lib/memory/store";
import type { DisplayMessage } from "@/types";

/**
 * Pie 2.0 记忆层 — 对话里的两种小行（设计稿 F4 / F13）：
 *   - 「用到 N 条记忆」chip：默认折叠，点开看用了哪几条（只有标题）。
 *   - 「已更新记忆：… · 撤销」/「已删除 N 条记忆 · 撤销」事件行。
 *
 * 撤销直接改记忆库（IDB，面板与 SW 同源）。undo 记录只保留最近 1 小时，
 * 过期后按钮显示「无法撤销」；`undone` 只是当前面板内的展示状态。
 */

export function MemoryUsedChip({
  items,
}: {
  items: Array<{ id: string; title: string }>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 self-start" data-testid="memory-used-chip">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-6 w-fit items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] ${
          open
            ? "border-accent-line bg-surface text-fg-1"
            : "border-line bg-surface text-fg-2 hover:text-fg-1"
        }`}
      >
        <Brain size={13} strokeWidth={1.75} className="text-fg-3" />
        {t("chat.memory.usedChip", { count: String(items.length) })}
      </button>
      {open && (
        <div className="flex flex-col overflow-hidden rounded-card border border-line bg-surface">
          <div className="border-b border-line px-3 py-2 text-[11.5px] text-fg-3">
            {t("chat.memory.usedTitle")}
          </div>
          {items.map((it) => (
            <div key={it.id} className="border-t border-line px-3 py-2 text-[12.5px] text-fg-1 first:border-t-0">
              {it.title}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function MemoryEventRow({
  msg,
}: {
  msg: Extract<DisplayMessage, { role: "memory-event" }>;
}) {
  const t = useT();
  const [state, setState] = useState<"idle" | "busy" | "done" | "expired">(
    msg.undone ? "done" : "idle",
  );

  const undo = async () => {
    if (state !== "idle") return;
    setState("busy");
    try {
      const res = await undoMemoryEvent(msg.eventId);
      setState(res.ok ? "done" : "expired");
    } catch {
      setState("expired");
    }
  };

  const label =
    msg.kind === "deleted"
      ? t("chat.memory.deleted", { count: String(msg.count) })
      : t("chat.memory.updated", { label: msg.label });

  return (
    <div
      className="flex items-center gap-2 self-start text-[11.5px] text-fg-2"
      data-testid="memory-event-row"
    >
      <Check size={12} strokeWidth={2} className="shrink-0 text-success" />
      <span>{label}</span>
      {state === "done" ? (
        <span className="text-fg-3">{t("chat.memory.undone")}</span>
      ) : state === "expired" ? (
        <span className="text-fg-3">{t("chat.memory.undoExpired")}</span>
      ) : (
        <button
          type="button"
          onClick={() => void undo()}
          disabled={state === "busy"}
          className="text-fg-3 underline underline-offset-2 hover:text-fg-1 disabled:opacity-50"
        >
          {t("chat.memory.undo")}
        </button>
      )}
    </div>
  );
}
