// Optional-permission helpers for the bookmarks / history line (spec §3.1).
//
// Both permissions live in manifest `optional_permissions` and are granted
// independently. Granting MUST happen inside a user gesture, which only exists
// in the panel — so the panel card calls chrome.permissions.request itself and
// reports the boolean back through panel-request. The SW tool layer only reads
// state (chrome.permissions.contains), never requests.

import type { BrowserDataDomain } from "./types";

export const BROWSER_DATA_DOMAINS: readonly BrowserDataDomain[] = ["bookmarks", "history"];

/** True when the extension currently holds the optional permission. */
export async function hasBrowserDataPermission(domain: BrowserDataDomain): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: [domain] });
  } catch {
    return false;
  }
}

/**
 * Panel-side grant. MUST be called synchronously from a click handler so the
 * user gesture survives into chrome.permissions.request (Chrome shows its own
 * confirmation dialog on top of our card).
 */
export async function grantBrowserDataPermission(domain: BrowserDataDomain): Promise<boolean> {
  try {
    return await chrome.permissions.request({ permissions: [domain] });
  } catch {
    return false;
  }
}

export async function revokeBrowserDataPermission(domain: BrowserDataDomain): Promise<boolean> {
  try {
    return await chrome.permissions.remove({ permissions: [domain] });
  } catch {
    return false;
  }
}

// ── Session-scoped denial memory ─────────────────────────────────────────────
//
// "拒绝后，这个会话里不再追问" (spec §3.1). In-memory only: a SW restart or a new
// side-panel run of the same session asks once more, which is acceptable and
// keeps stale denials from outliving the user's intent.
const deniedBySession = new Map<string, Set<BrowserDataDomain>>();

export function markBrowserPermissionDenied(sessionId: string, domain: BrowserDataDomain): void {
  const set = deniedBySession.get(sessionId) ?? new Set<BrowserDataDomain>();
  set.add(domain);
  deniedBySession.set(sessionId, set);
}

export function isBrowserPermissionDenied(sessionId: string, domain: BrowserDataDomain): boolean {
  return deniedBySession.get(sessionId)?.has(domain) ?? false;
}

/** Test-only */
export function __resetBrowserPermissionDenials(): void {
  deniedBySession.clear();
}
