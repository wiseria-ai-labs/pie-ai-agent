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
