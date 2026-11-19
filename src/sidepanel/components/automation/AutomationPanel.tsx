import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { onStoreChange } from "@/lib/store-bus";
import { listInbox, unreadInboxCount } from "@/lib/inbox/store";
import { listMonitors } from "@/lib/monitors/store";
import { listSchedules } from "@/lib/schedules/store";
import SchedulesPanel from "../Schedules/SchedulesPanel";
import { InboxFeed } from "./InboxFeed";
import { MonitorsPanel } from "./MonitorsPanel";

type Segment = "inbox" | "monitors" | "schedules";

interface Props {
  onOpenSession: (sessionId: string) => void;
  onCreateViaChat: (template: string) => void;
}

/**
 * Pie 2.0 §1 — 「自动化」 replaces the old 定时任务 view. Three segments:
 * 动态 · 监控 · 定时 (F2/F10). AppView stays `schedules` (no new member), so
 * the top bar and the back-navigation stack are untouched.
 */
export default function AutomationPanel({ onOpenSession, onCreateViaChat }: Props) {
  const { t } = useI18n();
  const [segment, setSegment] = useState<Segment>("inbox");
  const [counts, setCounts] = useState({ inbox: 0, unread: 0, monitors: 0, schedules: 0 });

  const reloadCounts = useCallback(async () => {
    const [inbox, unread, monitors, schedules] = await Promise.all([
      listInbox(),
      unreadInboxCount(),
      listMonitors(),
      listSchedules(),
    ]);
    setCounts({
      inbox: inbox.length,
      unread,
      monitors: monitors.length,
      schedules: schedules.length,
    });
  }, []);

  useEffect(() => {
    void reloadCounts();
    const offs = [
      onStoreChange("inbox", () => void reloadCounts()),
      onStoreChange("monitors", () => void reloadCounts()),
      onStoreChange("schedules", () => void reloadCounts()),
    ];
    return () => offs.forEach((off) => off());
  }, [reloadCounts]);

  const seg = (id: Segment, label: string, count: number, dot: boolean) => (
    <button
      key={id}
      type="button"
      data-testid={`automation-seg-${id}`}
      onClick={() => setSegment(id)}
      aria-pressed={segment === id}
      className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] ${
        segment === id
          ? "bg-surface text-fg-1 shadow-[0_1px_2px_rgba(20,24,29,0.08)]"
          : "text-fg-2 hover:text-fg-1"
      }`}
    >
      {label}
      {count > 0 && <em className="not-italic font-mono text-[10px] text-fg-3">{count}</em>}
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-pending" />}
    </button>
  );

  return (
    <div className="flex h-full flex-col" data-testid="automation-page">
      <div className="flex items-center gap-1 px-4 pt-4">
        <div className="flex items-center gap-1 rounded-full border border-line bg-field p-0.5">
          {seg("inbox", t("automation.tabInbox"), counts.inbox, counts.unread > 0)}
          {seg("monitors", t("automation.tabMonitors"), counts.monitors, false)}
          {seg("schedules", t("automation.tabSchedules"), counts.schedules, false)}
        </div>
      </div>

      {/* SchedulesPanel owns its own scroll container; the two new segments
          are plain lists, so they get one here. Nesting scroll areas inside
          each other makes the wheel behave unpredictably. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {segment === "inbox" ? (
          <div className="h-full overflow-y-auto px-4 py-4">
            <InboxFeed onOpenSession={onOpenSession} />
          </div>
        ) : segment === "monitors" ? (
          <div className="h-full overflow-y-auto px-4 py-4">
            <MonitorsPanel />
          </div>
        ) : (
          <SchedulesPanel
            onOpenSession={onOpenSession}
            onCreateViaChat={onCreateViaChat}
          />
        )}
      </div>
    </div>
  );
}
