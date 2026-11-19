// Hide Pie's in-page surfaces (overlay + capsule) around operations that must
// not see them:
//
//   - screenshots: the model should never receive its own chrome, and the
//     user's complaint "你截的图里有你自己的浮层" is not fixable downstream.
//     Visibility-only for exactly that frame — the card keeps its layout, so
//     restoring it is imperceptible.
//   - page-DOM tools (click / type / select / hover / press / scroll): the
//     page decides whether the target rectangle overlaps the card and, only
//     then, hides it for that call. Tools that never touch the page (bookmarks,
//     history, memory, monitors, PDFs, cross-tab reads) never reach this file,
//     so they cannot collapse the overlay.
//
// Kept dependency-free (tabs.sendMessage only) so the agent loop can use it
// without importing the SW's overlay orchestration.

import {
  SURFACE_HIDE,
  SURFACE_PAGE_GUARD,
  SURFACE_PEEK_HIDE,
  SURFACE_PEEK_SHOW,
  SURFACE_SHOW,
  type PageOperationTarget,
} from "./protocol";

async function send(tabId: number | null | undefined, message: unknown): Promise<void> {
  if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 0) return;
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // No content script (restricted page / tab gone) — nothing to hide.
  }
}

export const hideSurfaces = (tabId: number | null | undefined): Promise<void> =>
  send(tabId, { type: SURFACE_HIDE });

export const showSurfaces = (tabId: number | null | undefined): Promise<void> =>
  send(tabId, { type: SURFACE_SHOW });

/** Screenshot: hide one frame's worth of pixels, then restore. */
export const peekHideSurfaces = (tabId: number | null | undefined): Promise<void> =>
  send(tabId, { type: SURFACE_PEEK_HIDE });

export const peekShowSurfaces = (tabId: number | null | undefined): Promise<void> =>
  send(tabId, { type: SURFACE_PEEK_SHOW });

export async function withSurfacePeekHidden<T>(
  tabId: number | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (typeof tabId !== "number" || tabId < 0) return fn();
  await peekHideSurfaces(tabId);
  try {
    return await fn();
  } finally {
    await peekShowSurfaces(tabId);
  }
}

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

/** Page operation: the page hides the card iff the target overlaps it. */
export const beginPageOperation = (
  tabId: number | null | undefined,
  target: PageOperationTarget,
): Promise<void> => send(tabId, { type: SURFACE_PAGE_GUARD, phase: "begin", target });

export const endPageOperation = (tabId: number | null | undefined): Promise<void> =>
  send(tabId, { type: SURFACE_PAGE_GUARD, phase: "end" });
