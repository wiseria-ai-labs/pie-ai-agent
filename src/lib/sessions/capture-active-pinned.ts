// Issue #231 follow-up — shared active-tab pin capture (panel + SW).
//
// Single source of truth for "what pin does a chat-start capture from the
// active tab", mirroring the loop's resolveStartupPin contract (loop.ts):
//
//   - Operable tab (real id, non-restricted, resolvable origin)
//       → { tabId, origin }
//   - file://*.pdf → { tabId, origin: full URL } (sealed PDF viewer: the URL
//     itself is the pin identity, mirrors isFilePdfUrl handling elsewhere)
//   - Restricted / unresolvable-origin tab that still has a real id
//     (chrome://, new-tab page, settings, …)
//       → { tabId, origin: "" } — a LEGITIMATE pin. #231 removed the loop's
//         start-time hard stop for these pages; this capture must persist the
//         pin too, or the pin bar has nothing to show while streaming and R7
//         cross-session locking never sees the tab. interpretPinnedTabUrl
//         checks isRestrictedUrl before comparing origins, so the empty
//         origin is never consulted on the restricted branch.
//   - No active tab at all (or query throws) → null (loop falls back to
//     NO_PAGE_SENTINEL internally; nothing to persist).
//
// Replaces the two near-identical private copies that drifted after #231
// (panel useSession captureActivePinned + SW captureSwActivePinned — both
// still returned null for restricted URLs).

import { isRestrictedUrl } from "@/lib/url/restricted";
import { isFilePdfUrl } from "@/lib/pdf/detect";
import { queryActiveHostTab } from "@/lib/panel-host/host-window";

export interface PinEntry {
  tabId: number;
  origin: string;
}

/** The pin for a tab: restricted / opaque pages pin with an empty origin. */
export function pinFromTab(tab: chrome.tabs.Tab | undefined): PinEntry | null {
  if (!tab?.id || !tab.url) return null;
  // Chrome can return tab.id === -1 for session-restore / detached tabs;
  // chrome.tabs.get(-1) throws synchronously downstream. Only pin real,
  // addressable tabs.
  if (!Number.isInteger(tab.id) || tab.id < 0) return null;
  if (isFilePdfUrl(tab.url)) {
    return { tabId: tab.id, origin: tab.url };
  }
  if (isRestrictedUrl(tab.url)) {
    return { tabId: tab.id, origin: "" };
  }
  let origin: string;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    return { tabId: tab.id, origin: "" };
  }
  if (!origin || origin === "null") return { tabId: tab.id, origin: "" };
  return { tabId: tab.id, origin };
}

export async function captureActivePinnedTab(): Promise<PinEntry | null> {
  try {
    // queryActiveHostTab, not a bare currentWindow query: this module runs in
    // BOTH the panel and the SW, and on a fallback panel (Arc) `currentWindow`
    // is the panel's own popup — capturing it would pin Pie to itself.
    return pinFromTab(await queryActiveHostTab());
  } catch {
    return null;
  }
}

/** The tab a task is anchored to, as captured by the panel at send time. */
export interface AnchorTab extends PinEntry {
  windowId: number;
}

/**
 * PANEL-side: the active tab of the panel's OWN window, captured the moment
 * the user presses send. A side panel belongs to one window, so this answer
 * doesn't change when the user then switches to another window or
 * workspace — unlike the service worker, whose "current window" is simply
 * whichever window was focused last.
 */
export async function captureAnchorTab(): Promise<AnchorTab | null> {
  try {
    const tab = await queryActiveHostTab();
    const pin = pinFromTab(tab);
    if (!pin || typeof tab?.windowId !== "number") return null;
    return { ...pin, windowId: tab.windowId };
  } catch {
    return null;
  }
}

/**
 * SW-side: the pin for a specific tab (the panel's anchor). Null when the tab
 * no longer exists — callers must NOT fall back to "the active tab", which in
 * the SW means the last-focused window, i.e. possibly another window.
 */
export async function capturePinnedTabById(tabId: number): Promise<PinEntry | null> {
  try {
    return pinFromTab(await chrome.tabs.get(tabId));
  } catch {
    return null;
  }
}
