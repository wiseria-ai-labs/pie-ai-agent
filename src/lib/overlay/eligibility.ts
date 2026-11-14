// "Can this page host the in-page overlay?" — the restricted-page fallback.
//
// chrome:// pages, the new-tab page, the Web Store and the sealed PDF viewer
// have no content script, so the overlay document cannot be framed there. The
// same shortcut opens the side panel instead (prototype state ⑪) — an
// explained fallback, not an error.

import { isRestrictedUrl } from "@/lib/url/restricted";

export function canHostOverlay(url: string | undefined, isPdf: boolean): boolean {
  if (isPdf) return false;
  if (!url) return false;
  return !isRestrictedUrl(url);
}
