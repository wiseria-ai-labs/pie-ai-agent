// Shared types for the bookmarks / history line (Pie 2.0 spec §3).
//
// Kept chrome-free so the panel bundle (cards + settings page) and the SW tool
// layer can both import it. Every "external data" value that reaches the LLM is
// rendered through the untrusted_* wrappers by the tool layer, never here.
//
// i18n rule: nothing in this file is user-facing prose. The SW stores only
// structured fields (kind / count / domain / from / to / title); the panel
// builds every visible sentence through the dictionary.

/** The two optional permissions, granted independently (spec §3.1). */
export type BrowserDataDomain = "bookmarks" | "history";

// ── Bookmark plan (propose_bookmark_plan) ────────────────────────────────────

/**
 * Ops a plan can carry. There is deliberately NO delete op: a plan may create
 * folders, move and rename, but never removes a bookmark (F7 — "不会删除任何
 * 书签"). Deletion is a different product decision and would need its own card.
 */
export type BookmarkPlanOp =
  | { op: "create_folder"; title: string; parentId?: string }
  | { op: "move"; id: string; parentId: string }
  | { op: "rename"; id: string; title: string };

export interface BookmarkPlanCounts {
  folders: number;
  moves: number;
  renames: number;
}

/** One diff row on the plan card (F7 tree). Text is bookmark data, not prose. */
export interface BookmarkPlanLine {
  kind: "add" | "move" | "rename";
  /** Bookmark or folder title / rename arrow — user data. */
  text: string;
  /** Extra count badge (`+ 23`); 0 means no badge. */
  count: number;
  /** Secondary detail, e.g. `书签栏 → 工作` (folder paths — user data). */
  note?: string;
}

/** panel-request payload: bookmark-plan. Titles/descriptions are localized by the card. */
export interface BookmarkPlanRequest {
  counts: BookmarkPlanCounts;
  lines: BookmarkPlanLine[];
  totalAffected: number;
}

// ── History deletion (propose_history_deletion) ──────────────────────────────

export interface HistoryDeletionSite {
  domain: string;
  count: number;
}

/** panel-request payload: history-deletion (F8). No prose — the card localizes. */
export interface HistoryDeletionRequest {
  count: number;
  /** Actual matched range (epoch ms) — narrower than what the model asked for. */
  from: number;
  to: number;
  /** Top domains, already aggregated + sorted desc. */
  sites: HistoryDeletionSite[];
}

// ── Change log + bookmark snapshots (IDB `bookmark_snapshots`) ───────────────

/**
 * One applied bookmark mutation, recorded with its inverse so a later restore
 * can withdraw exactly this change and leave any newer user edit alone.
 * `before` fields are absent for creation ops.
 */
export type BookmarkChangeOp =
  | { op: "create_folder"; id: string; parentId: string; title: string }
  | { op: "create_bookmark"; id: string; parentId: string; title: string; url: string }
  | { op: "move"; id: string; fromParentId: string; toParentId: string }
  | { op: "rename"; id: string; fromTitle: string; toTitle: string };

export type BrowserChangeKind =
  | "bookmark_plan"
  | "bookmark_create"
  | "bookmark_update"
  | "history_delete";

/**
 * One row on Settings → 书签与历史 (F17) and in the in-conversation undo row.
 * Bookmark rows carry the ops needed to restore; history deletions are listed
 * but permanently irreversible (no snapshot — Chrome cannot restore original
 * visit times, spec §3.2).
 *
 * Display fields are DATA only. `describeChange()` in ./labels.ts turns them
 * into a localized sentence at render time — the SW never stores prose.
 */
export interface BrowserChangeRecord {
  id: string;
  kind: BrowserChangeKind;
  at: number;
  restorable: boolean;
  restoredAt?: number;
  /** Bookmark mutations only. */
  ops?: BookmarkChangeOp[];
  /** bookmark_create / bookmark_update: the affected bookmark's title. */
  title?: string;
  /** bookmark_plan: how many of each op were applied. */
  changeCounts?: BookmarkPlanCounts;
  /** history_delete: how many URLs were removed. */
  count?: number;
  /** history_delete: up to 3 site names that were affected. */
  domains?: string[];
}

export interface RestoreResult {
  ok: boolean;
  restored: number;
  /** Ops left alone because the user has changed that node since. */
  skipped: number;
  error?: string;
}

// ── Dead-link check (check_bookmark_links) ───────────────────────────────────

export type DeadLinkReason = "404" | "410" | "timeout" | "network";

export interface DeadBookmarkLink {
  id: string;
  title: string;
  url: string;
  reason: DeadLinkReason;
}
