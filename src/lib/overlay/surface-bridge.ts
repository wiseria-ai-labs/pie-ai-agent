// Hide Pie's in-page surfaces (overlay + capsule) around operations that must
// not see them:
//
//   - screenshots: the model should never receive its own chrome, and the
//     user's complaint "你截的图里有你自己的浮层" is not fixable downstream;
//   - write-class page tools (click / type / select): a click at coordinates
//     the capsule covers would hit the capsule instead of the page.
//
// Kept dependency-free (tabs.sendMessage only) so the agent loop can use it
// without importing the SW's overlay orchestration.

import { SURFACE_HIDE, SURFACE_SHOW } from "./protocol";

async function send(tabId: number | null | undefined, type: string): Promise<void> {
  if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 0) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type });
  } catch {
    // No content script (restricted page / tab gone) — nothing to hide.
  }
}

export const hideSurfaces = (tabId: number | null | undefined): Promise<void> =>
  send(tabId, SURFACE_HIDE);

export const showSurfaces = (tabId: number | null | undefined): Promise<void> =>
  send(tabId, SURFACE_SHOW);

/** Run `fn` with the surfaces hidden, restoring them on every exit path. */
export async function withSurfaceHidden<T>(
  tabId: number | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (typeof tabId !== "number" || tabId < 0) return fn();
  await hideSurfaces(tabId);
  try {
    return await fn();
  } finally {
    await showSurfaces(tabId);
  }
}
