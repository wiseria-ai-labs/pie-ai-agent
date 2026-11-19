import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { onStoreChange } from "@/lib/store-bus";
import { listInbox, markAllInboxRead } from "@/lib/inbox/store";
import type { InboxEntry } from "@/lib/inbox/types";

interface Props {
  /** Open a chat session by id (schedule entries point at their run's session). */
  onOpenSession: (sessionId: string) => void;
}

type T = ReturnType<typeof useI18n>["t"];

const DAY = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 今天 / 昨天 / 具体日期 — F2's day separators. */
function dayLabel(at: number, now: number, t: T, locale: string): string {
  const today = startOfDay(now);
  if (at >= today) return t("automation.today");
  if (at >= today - DAY) return t("automation.yesterday");
  try {
    return new Date(at).toLocaleDateString(locale, { month: "short", day: "numeric" });
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

function hhmm(at: number, locale: string): string {
  try {
    return new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/**
 * F2 — 动态 feed. Reads the `inbox` store directly and stays live via the
 * store-bus. Opening the feed marks everything read ("打开过就变成普通行，不用手动
 * 标已读" — F2 notes), which is also what clears the top-bar dot.
 */
export function InboxFeed({ onOpenSession }: Props) {
  const { locale, t } = useI18n();
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  // F2 — "未读项有边框和黄铜点；打开过就变成普通行". So: snapshot which rows were
  // unread when the feed opened (they keep the highlight for this visit), then
  // mark everything read in the store (which clears the top-bar dot).
  const [unreadOnOpen, setUnreadOnOpen] = useState<ReadonlySet<string>>(new Set());

  const reload = useCallback(async () => {
    const list = await listInbox();
    // F2 — "未读项有边框和黄铜点；打开过就变成普通行". Rows that are unread at the
    // moment they appear keep the highlight for this visit; anything that
    // arrives while the feed is open is also "seen now" (otherwise the top-bar
    // dot would stay lit while the user stares at the feed).
    const unreadIds = list.filter((e) => !e.read).map((e) => e.id);
    if (unreadIds.length > 0) {
      setUnreadOnOpen((prev) => {
        const next = new Set(prev);
        for (const id of unreadIds) next.add(id);
        return next;
      });
      void markAllInboxRead();
    }
    setEntries(list);
  }, []);

  useEffect(() => {
    void reload();
    return onStoreChange("inbox", () => void reload());
  }, [reload]);

  const groups = useMemo(() => {
    const now = Date.now();
    const out: Array<{ label: string; items: InboxEntry[] }> = [];
    for (const e of entries) {
      const label = dayLabel(e.at, now, t, locale);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(e);
      else out.push({ label, items: [e] });
    }
    return out;
  }, [entries, t, locale]);

  if (entries.length === 0) {
    return (
      <div className="rounded-[10px] border border-line bg-surface px-3 py-4 text-[12px] leading-[18px] text-fg-2">
        {t("automation.emptyInbox")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="inbox-feed">
      {groups.map((g) => (
        <div key={g.label} className="flex flex-col gap-1.5">
          <div className="px-1 caps text-fg-3">{g.label}</div>
          <div className="flex flex-col overflow-hidden rounded-[14px] border border-line bg-surface">
            {g.items.map((e) => (
              <InboxRow
                key={e.id}
                entry={e}
                unread={unreadOnOpen.has(e.id)}
                locale={locale}
                onOpenSession={onOpenSession}
                monitorUrl={e.data?.url}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function InboxRow({
  entry,
  unread,
  locale,
  onOpenSession,
  monitorUrl,
}: {
  entry: InboxEntry;
  /** Snapshot from feed-open time — see unreadOnOpen in InboxFeed. */
  unread: boolean;
  locale: string;
  onOpenSession: (sessionId: string) => void;
  monitorUrl?: string;
}) {
  const { t } = useI18n();
  const sessionId = entry.data?.sessionId;

  const action = monitorUrl
    ? { label: t("automation.openPage"), run: () => void chrome.tabs.create({ url: monitorUrl }) }
    : sessionId
      ? { label: t("automation.viewSession"), run: () => onOpenSession(sessionId) }
      : null;

  const tone =
    entry.kind === "needs_action"
      ? "border-warning-line bg-warning-tint text-warning"
      : entry.kind === "triggered"
        ? "border-success/40 bg-success-tint text-success"
        : "border-line bg-surface-deep text-fg-3";

  return (
    <div
      data-testid={`inbox-row-${entry.id}`}
      className={`flex items-start gap-2.5 border-b border-line px-3 py-2.5 last:border-b-0 ${
        unread ? "bg-accent-tint/40" : ""
      }`}
    >
      <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${tone}`}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          {entry.kind === "needs_action" ? (
            <><path d="M12 8v5" /><circle cx="12" cy="16.5" r=".6" fill="currentColor" /></>
          ) : entry.kind === "triggered" ? (
            <path d="M12 3v18M3 12h18" />
          ) : (
            <path d="m5 12 4.5 4.5L19 7" />
          )}
        </svg>
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-[13px] font-medium text-fg-1" title={entry.title}>
            {entry.title}
          </span>
          {unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-pending" />}
        </div>
        {entry.body && (
          <span className="truncate text-[12px] leading-[17px] text-fg-2" title={entry.body}>
            {entry.body}
          </span>
        )}
        <div className="flex items-center gap-1.5 text-[11px] text-fg-3">
          <span className="font-mono">{hhmm(entry.at, locale)}</span>
          <span>·</span>
          <span>
            {entry.source === "monitor" ? t("automation.sourceMonitor") : t("automation.sourceSchedule")}
          </span>
          {action && (
            <>
              <span className="flex-1" />
              <button
                type="button"
                onClick={action.run}
                className="rounded-[8px] border border-line px-2 py-0.5 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
              >
                {action.label}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
