// One-shot intent handed from the SW to the side panel after the panel is
// opened by a website "Subscribe" click. Stored in chrome.storage.session
// (in-memory, trusted contexts only) so it survives the gap while the panel
// mounts; the panel reads it once and clears it. Not used by content scripts.
export const DEEPLINK_KEY = "pie:deeplink";
export const DEEPLINK_MANAGED_SUBSCRIBE = "managed-subscribe";

const RESEARCH_DETAIL_PREFIX = "research-detail:";

export function researchDetailDeeplink(runId: string): string {
  return `${RESEARCH_DETAIL_PREFIX}${runId}`;
}

export function parseResearchDetailDeeplink(val: unknown): string | null {
  if (typeof val !== "string" || !val.startsWith(RESEARCH_DETAIL_PREFIX)) return null;
  const id = val.slice(RESEARCH_DETAIL_PREFIX.length);
  return id || null;
}

// ── Overlay → side panel handoff ────────────────────────────────────────────
// "转到侧栏" / the toolbar icon / a capsule "展开" all mean the same thing to
// the panel: activate this session. The restricted-page fallback and the
// omnibox fallback carry a notice / the query instead.

const OVERLAY_PANEL_PREFIX = "overlay-panel:";
const OVERLAY_PREFILL_PREFIX = "overlay-prefill:";

export const DEEPLINK_OVERLAY_RESTRICTED = "overlay-restricted";

export function overlayPanelDeeplink(sessionId: string): string {
  return `${OVERLAY_PANEL_PREFIX}${sessionId}`;
}

export function parseOverlayPanelDeeplink(val: unknown): string | null {
  if (typeof val !== "string" || !val.startsWith(OVERLAY_PANEL_PREFIX)) return null;
  const id = val.slice(OVERLAY_PANEL_PREFIX.length);
  return id || null;
}

export function overlayPrefillDeeplink(text: string): string {
  return `${OVERLAY_PREFILL_PREFIX}${text}`;
}

export function parseOverlayPrefillDeeplink(val: unknown): string | null {
  if (typeof val !== "string" || !val.startsWith(OVERLAY_PREFILL_PREFIX)) return null;
  const text = val.slice(OVERLAY_PREFILL_PREFIX.length);
  return text || null;
}
