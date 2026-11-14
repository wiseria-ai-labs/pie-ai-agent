// "Which conversation does this tab's overlay belong to?" — the 30-minute
// resume rule from the prototype:
//
//   same tab + within retention → reopen the previous conversation (with a
//   time divider); another tab or past retention → a fresh conversation.
//
// Kept in chrome.storage.session (memory-only): the mapping is meaningless
// after a browser restart, and it must survive SW idle-outs. The side panel
// never writes here.

import type { OverlayRetentionMinutes } from "./settings";

const STORAGE_KEY = "overlay_tab_sessions";

interface TabSessionRecord {
  sessionId: string;
  at: number;
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

export async function rememberOverlaySession(tabId: number, sessionId: string): Promise<void> {
  const map = await readMap();
  map[String(tabId)] = { sessionId, at: Date.now() };
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
