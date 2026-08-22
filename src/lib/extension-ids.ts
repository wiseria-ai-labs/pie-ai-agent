/** Chrome Web Store id — pinned by `manifest.key`. Unpacked Chrome / Edge
 *  loads of the keyed zip share this id. */
export const CHROME_STORE_EXT_ID = "gpccjhdgjkmalnepmeclooflliiocfed";

/** Edge Add-ons store id. Edge rejects `manifest.key`, so the store assigns
 *  its own stable id. Must stay in Pie Link `allowed_origins`. */
export const EDGE_STORE_EXT_ID = "gbfdgfkpglimajnjedphgakmhaplgobf";

const ALLOWLISTED = new Set<string>([CHROME_STORE_EXT_ID, EDGE_STORE_EXT_ID]);

/** True when `chrome.runtime.id` is a store-stable id Pie Link allowlists. */
export function isAllowlistedExtId(id: string | undefined): boolean {
  return typeof id === "string" && ALLOWLISTED.has(id);
}
