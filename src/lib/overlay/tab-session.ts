// "Which conversation does this tab's overlay belong to?" (decideOverlaySession)
//
//   1. a task of that conversation is still running → always back to it;
//   2. opened from the selection bar (explain / translate / rewrite / ask on a
//      selection) → a fresh conversation: a one-shot task on new text gains
//      nothing from old history and gets confused by it;
//   3. shortcut / omnibox → continue only on the same site and within the
//      retention window counted from the last ACTIVITY (a turn started or
//      finished), not from the last open;
//   4. anything else → fresh. ＋ / ⌘K always start fresh.
//
// Kept in chrome.storage.session (memory-only): the mapping is meaningless
// after a browser restart, and it must survive SW idle-outs. The side panel
// never writes here.

import type { OverlayRetentionMinutes } from "./settings";

const STORAGE_KEY = "overlay_tab_sessions";

interface TabSessionRecord {
  sessionId: string;
  /** Last activity: created, or a turn started / finished. */
  at: number;
  /** Site the conversation belongs to (location.host). */
  host?: string;
}

type TabSessionMap = Record<string, TabSessionRecord>;

/** Pure decision used by resolveTabSession (and unit tests). */
export function isWithinRetention(
  at: number,
  retentionMinutes: OverlayRetentionMinutes,
  now = Date.now(),
): boolean {
  if (!Number.isFinite(at)) return false;
  const age = now - at;
  return age >= 0 && age <= retentionMinutes * 60_000;
}

export function decideOverlaySession(input: {
  remembered: TabSessionRecord | null;
  /** The remembered conversation has a task in flight. */
  live: boolean;
  /** Opened from the selection bar. */
  fromSelectionBar: boolean;
  host: string;
  retentionMinutes: OverlayRetentionMinutes;
  now?: number;
}): "resume" | "new" {
  const { remembered } = input;
  if (!remembered) return "new";
  if (input.live) return "resume";
  if (input.fromSelectionBar) return "new";
  if (!remembered.host || remembered.host !== input.host) return "new";
  return isWithinRetention(remembered.at, input.retentionMinutes, input.now) ? "resume" : "new";
}

/** Site key for the same-site rule; empty for URLs without a host. */
export function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
}

async function readMap(): Promise<TabSessionMap> {
  try {
    const got = await chrome.storage.session.get(STORAGE_KEY);
    const raw = got?.[STORAGE_KEY];
    return raw && typeof raw === "object" ? (raw as TabSessionMap) : {};
  } catch {
    return {};
  }
}

async function writeMap(map: TabSessionMap): Promise<void> {
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: map });
  } catch {
    // storage.session unavailable (test stub / browser shutdown) — the resume
    // rule degrades to "new conversation", never to an error.
  }
}

export async function rememberOverlaySession(
  tabId: number,
  sessionId: string,
  host: string,
): Promise<void> {
  const map = await readMap();
  map[String(tabId)] = { sessionId, at: Date.now(), host };
  await writeMap(map);
}

/** A turn started / finished: restart the retention clock (same record only). */
export async function touchOverlaySession(tabId: number, sessionId: string): Promise<void> {
  const map = await readMap();
  const rec = map[String(tabId)];
  if (!rec || rec.sessionId !== sessionId) return;
  map[String(tabId)] = { ...rec, at: Date.now() };
  await writeMap(map);
}

export async function recallOverlaySession(tabId: number): Promise<TabSessionRecord | null> {
  const map = await readMap();
  return map[String(tabId)] ?? null;
}

export async function forgetOverlaySession(tabId: number): Promise<void> {
  const map = await readMap();
  if (!(String(tabId) in map)) return;
  delete map[String(tabId)];
  await writeMap(map);
}
