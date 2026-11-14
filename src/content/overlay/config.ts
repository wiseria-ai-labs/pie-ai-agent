// Cached overlay config for the page side.
//
// Content scripts can't read the extension's IndexedDB, so the SW pushes the
// settings + localized labels here. The cache is refreshed on demand and on an
// explicit SW broadcast (settings changed while the tab stays open).

import type { OverlayConfigReply } from "@/lib/overlay/protocol";
import { OVERLAY_CONFIG } from "@/lib/overlay/protocol";

let cache: OverlayConfigReply | null = null;
let inflight: Promise<OverlayConfigReply | null> | null = null;

export function getCachedOverlayConfig(): OverlayConfigReply | null {
  return cache;
}

export function setOverlayConfig(next: OverlayConfigReply | null): void {
  cache = next;
}

/** Fetch once (deduped); `force` refetches but keeps serving the old copy
 *  meanwhile. Resolves null when the SW is unreachable. */
export async function loadOverlayConfig(force = false): Promise<OverlayConfigReply | null> {
  if (cache && !force) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const reply = (await chrome.runtime.sendMessage({
        type: OVERLAY_CONFIG,
        // The SW's own getUILanguage() reports the OS locale, not the browser
        // UI locale — send the document's language so the bar matches the app.
        language: navigator.language,
      })) as OverlayConfigReply | undefined;
      if (reply && reply.settings && reply.strings) cache = reply;
      return cache;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
