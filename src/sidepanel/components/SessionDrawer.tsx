/**
 * SessionDrawer — M2-U2 overlay drawer showing the session list.
 * M2-U4: adds "Show archived" toggle, unarchive/delete-forever buttons,
 * soft-delete per active row, and real storage usage from getBytesInUse(null).
 *
 * Design spec:
 * - 296px wide, full height, left-anchored, bg var(--c-surface-deep), soft
 *   drop shadow (borderless — Vailie redesign) in place of a hairline edge
 * - Backdrop (var(--c-overlay-strong)) covers the remaining area; click closes drawer
 * - ESC keydown closes drawer
 * - Focus trap: Tab/Shift+Tab cycle within the drawer
 * - role=dialog aria-modal=true aria-label="Sessions"
 *
 * Internal sections:
 * 1. Header: logo + "Sessions" label + session count
 * 2. ACTIVE section: title search (role=searchbox) + list of non-archived
 *    sessions, grouped into 今天/昨天/更早 day buckets (display-only, Task 15)
 * 3. SHOW ARCHIVED toggle (M2-U4 — real, collapsible; flat list, no day groups)
 * 4. Storage indicator: usage bar + MB label
 *
 * R27 a11y baseline:
 * - role=dialog + aria-modal + aria-label
 * - role=list + role=listitem on rows
 * - Per-row aria-label: "${title}, ${status}, ${time}"
 * - ESC key closes
 * - Focus trap within drawer
 */

import { Fragment, useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import type { SessionIndexEntry } from "@/lib/sessions/types";
import { getTotalBytes } from "@/lib/sessions/storage";
import {
  unarchiveSession,
  hardDeleteSession,
  softDeleteSession,
} from "@/lib/sessions/lifecycle";
import { useStoreChange } from "@/sidepanel/hooks/useStoreChange";
import SessionRow from "./SessionRow";
import { useAnimatedList } from "./ui/AnimatedList";
import { Drawer } from "./ui/Drawer";

interface SessionDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  sessions: SessionIndexEntry[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onResumeSession: (id: string) => void;
}

// ── groupByDay ────────────────────────────────────────────────────────────────
// Pure display grouping (D 屏 net-new #2) — buckets the ACTIVE list into
// 今天/昨天/更早 by `lastAccessedAt` (SessionIndexEntry's real timestamp field;
// there is no `updatedAt` on this type). Archived rows are intentionally never
// passed through this — that section keeps its flat, ungrouped list.
type DayGroupLabel = "today" | "yesterday" | "earlier";

function groupByDay<T extends { lastAccessedAt: number }>(
  list: T[],
): { label: DayGroupLabel; items: T[] }[] {
  const now = new Date();
  const todayStr = now.toDateString();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  const yStr = y.toDateString();
  const buckets = { today: [] as T[], yesterday: [] as T[], earlier: [] as T[] };
  for (const s of list) {
    const d = new Date(s.lastAccessedAt).toDateString();
    (d === todayStr ? buckets.today : d === yStr ? buckets.yesterday : buckets.earlier).push(s);
  }
  return (["today", "yesterday", "earlier"] as const)
    .filter((k) => buckets[k].length)
    .map((k) => ({ label: k, items: buckets[k] }));
}

// ── StorageIndicator ──────────────────────────────────────────────────────────

function StorageIndicator() {
  const t = useT();
  const [usedBytes, setUsedBytes] = useState(0);
  const load = useCallback(async () => { setUsedBytes(await getTotalBytes()); }, []);
  useEffect(() => { void load(); }, [load]);
  useStoreChange("sessions", () => { void load(); });
  useStoreChange("config", () => { void load(); });
  useStoreChange("instances", () => { void load(); });
  const usedMB = usedBytes / (1024 * 1024);
  return (
    <div style={{ marginTop: "auto", padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <span
          aria-label={t("sessions.storage")}
          style={{
            flex: 1,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            fontWeight: 500,
            color: "var(--c-fg-3)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          {t("sessions.storage")}
        </span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            fontWeight: 500,
            color: "var(--c-fg-2)",
          }}
        >
          {usedMB.toFixed(1)} MB
        </span>
      </div>
    </div>
  );
}

// ── ArchivedRow ───────────────────────────────────────────────────────────────

interface ArchivedRowProps {
  session: SessionIndexEntry;
  onUnarchive: (id: string) => void;
  onDeleteForever: (id: string) => void;
}

function ArchivedRow({ session, onUnarchive, onDeleteForever }: ArchivedRowProps) {
  const t = useT();
  const { id, title, lastAccessedAt } = session;
  const displayTitle = title ?? t("sessions.untitled");

  const diff = Date.now() - lastAccessedAt;
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  const timeStr =
    days === 0
      ? t("sessions.today")
      : days === 1
        ? t("sessions.yesterday")
        : t("sessions.daysAgo", { days });

  return (
    <li
      role="listitem"
      aria-label={`${displayTitle}, ${t("sessions.status.archived")}, ${timeStr}`}
      style={{
        padding: "10px 16px",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      {/* Archived icon: faded circle */}
      <span
        style={{
          width: 18,
          height: 18,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="5.5" stroke="var(--c-fg-3)" strokeWidth="1" strokeDasharray="3 2" />
        </svg>
      </span>

      {/* Text */}
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 13,
            fontWeight: 500,
            color: "var(--c-fg-3)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {displayTitle}
        </span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            fontWeight: 400,
            letterSpacing: "0.08em",
            color: "var(--c-fg-4)",
            whiteSpace: "nowrap",
          }}
        >
          {timeStr}
        </span>
      </span>

      {/* Actions */}
      <span style={{ display: "flex", gap: 4, flexShrink: 0 }}>
        <button
          type="button"
          aria-label={t("sessions.unarchiveAria", { title: displayTitle })}
          onClick={() => onUnarchive(id)}
          className="rounded-chip bg-transparent px-1.5 py-0.5 text-[10px] font-medium text-fg-2 transition-colors hover:bg-field"
        >
          {t("sessions.restore")}
        </button>
        <button
          type="button"
          aria-label={t("sessions.deleteForeverAria", { title: displayTitle })}
          onClick={() => onDeleteForever(id)}
          className="rounded-chip bg-transparent px-1.5 py-0.5 text-[10px] font-medium text-danger-fg transition-colors hover:bg-field"
        >
          {t("sessions.delete")}
        </button>
      </span>
    </li>
  );
}

// ── SessionDrawer ─────────────────────────────────────────────────────────────

export default function SessionDrawer({
  isOpen,
  onClose,
  sessions,
  activeSessionId,
  onSelectSession,
  onResumeSession,
}: SessionDrawerProps) {
  const t = useT();
  const sessionListRef = useAnimatedList<HTMLUListElement>();
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");

  // Sessions split by status — archived goes to the "show archived" section
  const activeSessions = sessions.filter((s) => s.status !== "archived");
  const archivedSessions = sessions.filter((s) => s.status === "archived");

  // Title substring filter (case-insensitive) — applies to both sections
  // (reasonable default: a search box should search everything it can see).
  const matchesQuery = (s: SessionIndexEntry) =>
    (s.title ?? "").toLowerCase().includes(query.toLowerCase());
  const filteredActiveSessions = activeSessions.filter(matchesQuery);
  const filteredArchivedSessions = archivedSessions.filter(matchesQuery);
  const archivedCount = filteredArchivedSessions.length;

  // Day-grouping is display-only and ACTIVE-section-only — archived stays flat.
  const dayGroups = groupByDay(filteredActiveSessions);

  function handleSelectSession(id: string) {
    onSelectSession(id);
    onClose();
  }

  async function handleSoftDelete(id: string) {
    await softDeleteSession(id);
    // Storage onChanged in App.tsx will refresh the sessions list.
  }

  async function handleUnarchive(id: string) {
    await unarchiveSession(id);
  }

  async function handleDeleteForever(id: string) {
    await hardDeleteSession(id);
  }

  return (
    <Drawer
      open={isOpen}
      onClose={onClose}
      ariaLabel={t("sessions.header")}
      backdropTestId="drawer-backdrop"
      panelStyle={{
        background: "var(--c-surface-deep)",
        boxShadow: "0 8px 28px rgba(21, 25, 31, 0.14)",
      }}
    >
        {/* Header */}
        <div
          style={{
            padding: "14px 16px 12px 16px",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {/* Logo: V3 bite-curve mark, 18×18.
              Uses --c-fg-1 / --c-canvas tokens so the mark inverts cleanly
              between light and dark mode (deep base on light surface, light
              base on dark surface) while staying a 1:1 silhouette of the
              manifest icon. */}
          <svg
            width="18"
            height="18"
            viewBox="0 0 128 128"
            fill="none"
            aria-hidden="true"
            style={{ flexShrink: 0 }}
          >
            <rect width="128" height="128" rx="26" fill="var(--c-fg-1)" />
            <circle cx="64" cy="64" r="44" fill="var(--c-canvas)" />
            <circle cx="98" cy="30" r="22" fill="var(--c-fg-1)" />
          </svg>

          {/* Title */}
          <span
            style={{
              flex: 1,
              fontFamily: "Inter, sans-serif",
              fontSize: 14,
              fontWeight: 600,
              color: "var(--c-fg-1)",
            }}
          >
            {t("sessions.header")}
          </span>

          {/* Session count */}
          <span
            aria-label={t("sessions.sessionCount", { count: activeSessions.length })}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              fontWeight: 500,
              color: "var(--c-fg-3)",
              letterSpacing: "0.16em",
            }}
          >
            {activeSessions.length}
          </span>
        </div>

        {/* ACTIVE section divider + title search */}
        <div style={{ padding: "14px 16px 8px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              fontWeight: 500,
              color: "var(--c-fg-3)",
              letterSpacing: "0.16em",
              textTransform: "uppercase",
            }}
          >
            {t("sessions.active")} · {filteredActiveSessions.length}
          </div>
          <input
            role="searchbox"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("sessions.searchPlaceholder")}
            aria-label={t("sessions.searchPlaceholder")}
            className="rounded-field bg-field px-3 py-2 text-[13px] text-fg-1 outline-none placeholder:text-fg-3"
          />
        </div>

        {/* Session list (scrollable) — grouped 今天/昨天/更早 (ACTIVE only) */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          <ul
            ref={sessionListRef}
            role="list"
            style={{ margin: 0, padding: 0, listStyle: "none" }}
          >
            {dayGroups.map((group) => (
              <Fragment key={group.label}>
                <div className="px-4 pt-3 pb-1 text-[11px] tracking-[0.1em] text-fg-3">
                  {t(`sessions.group.${group.label}`)}
                </div>
                {group.items.map((session) => (
                  <SessionRowWithDelete
                    key={session.id}
                    session={session}
                    isActive={session.id === activeSessionId}
                    onSelect={handleSelectSession}
                    onResume={onResumeSession}
                    onDelete={handleSoftDelete}
                  />
                ))}
              </Fragment>
            ))}
          </ul>
        </div>

        {/* SHOW ARCHIVED toggle — real collapsible section */}
        <button
          type="button"
          aria-expanded={showArchived}
          aria-controls="archived-session-list"
          onClick={() => setShowArchived((v) => !v)}
          style={{
            padding: "14px 16px 6px 16px",
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "none",
            border: "none",
            cursor: "pointer",
            width: "100%",
            textAlign: "left",
          }}
        >
          <span
            style={{
              flex: 1,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              fontWeight: 500,
              color: archivedCount > 0 ? "var(--c-fg-2)" : "var(--c-fg-3)",
              letterSpacing: "0.16em",
              textTransform: "uppercase",
            }}
          >
            {showArchived ? t("sessions.hideArchived") : t("sessions.showArchived")} · {archivedCount}
          </span>
          {/* Chevron — flips when open */}
          <svg
            width="9"
            height="9"
            viewBox="0 0 9 9"
            fill="none"
            aria-hidden="true"
            style={{
              transform: showArchived ? "rotate(180deg)" : "rotate(0deg)",
              transition: "transform 0.2s ease",
            }}
          >
            <path
              d="M1.5 3 L4.5 6 L7.5 3"
              stroke="var(--c-fg-3)"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {/* Archived session list (collapsible) */}
        {showArchived && (
          <div
            id="archived-session-list"
            style={{ maxHeight: 200, overflowY: "auto" }}
          >
            <ul
              role="list"
              aria-label={t("sessions.archivedAria")}
              style={{ margin: 0, padding: 0, listStyle: "none" }}
            >
              {filteredArchivedSessions.length === 0 ? (
                <li
                  style={{
                    padding: "12px 16px",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 12,
                    color: "var(--c-fg-4)",
                  }}
                >
                  {t("sessions.noArchived")}
                </li>
              ) : (
                filteredArchivedSessions.map((session) => (
                  <ArchivedRow
                    key={session.id}
                    session={session}
                    onUnarchive={handleUnarchive}
                    onDeleteForever={handleDeleteForever}
                  />
                ))
              )}
            </ul>
          </div>
        )}

        {/* Storage indicator */}
        <StorageIndicator />
    </Drawer>
  );
}

// ── SessionRowWithDelete ──────────────────────────────────────────────────────
// Wraps SessionRow and adds a soft-delete ("Delete") button on hover-reveal.
// Uses a simple show-on-focus approach to keep the row accessible.

interface SessionRowWithDeleteProps {
  session: SessionIndexEntry;
  isActive: boolean;
  onSelect: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
}

function SessionRowWithDelete({
  session,
  isActive,
  onSelect,
  onResume,
  onDelete,
}: SessionRowWithDeleteProps) {
  const t = useT();
  const [hovered, setHovered] = useState(false);

  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <SessionRow
        session={session}
        isActive={isActive}
        onSelect={onSelect}
        onResume={onResume}
      />
      {/* Delete button — revealed on hover (not shown for archived rows) */}
      {hovered && session.status !== "archived" && (
        <button
          type="button"
          aria-label={t("sessions.archiveAria", { title: session.title ?? t("sessions.untitled") })}
          title={t("sessions.archiveSession")}
          onClick={(e) => {
            e.stopPropagation();
            void onDelete(session.id);
          }}
          // Only show when row doesn't have a Resume button (paused rows) —
          // if it's a paused row with a Resume button, skip the overlap.
          className={`absolute top-1/2 right-2 -translate-y-1/2 rounded-chip bg-surface-deep px-1.5 py-0.5 text-[10px] font-medium text-fg-3 transition-colors hover:bg-field ${
            session.status === "paused" ? "hidden" : ""
          }`}
        >
          {t("sessions.archive")}
        </button>
      )}
    </div>
  );
}
