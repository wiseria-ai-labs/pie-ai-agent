// One live Pie content script per page.
//
// Every extension reload / update re-injects this script into open tabs
// (background/content-reinject.ts), but the previous instance never goes away:
// its runtime is invalidated, yet its DOM listeners keep firing. So each
// reload stacked one more selection bar on the page — and pre-2.0 builds also
// drew their old one-icon bubble at the viewport corner for input selections.
//
// Fix, from both ends:
//   - the live instance removes any Pie host it did not create (older
//     instances, including builds that predate this guard);
//   - an instance whose runtime is gone stops observing and detaches itself,
//     so two guarded instances never fight over the DOM.
// The tag carries the extension id: another installed copy of Pie (store +
// unpacked) owns its own hosts and is left alone; untagged hosts can only come
// from pre-guard builds and are always removed.

export const INSTANCE_ATTR = "data-pie-instance";
const EXTENSION_ID = (() => {
  try {
    return chrome.runtime?.id ?? "";
  } catch {
    return "";
  }
})();
const INSTANCE_ID = `${EXTENSION_ID}:${crypto.randomUUID()}`;
const HOST_SELECTOR =
  "[data-pie-quote-bubble],[data-pie-overlay-host],[data-pie-capsule],[data-pie-quote-picker]";

/** The extension was reloaded / removed under this instance. */
export function isOrphaned(): boolean {
  try {
    return !chrome.runtime?.id;
  } catch {
    return true;
  }
}

/** Tag a host element as belonging to this instance. */
export function markOwned(el: HTMLElement): void {
  el.setAttribute(INSTANCE_ATTR, INSTANCE_ID);
}

function isForeignHost(node: Node): node is Element {
  if (!(node instanceof Element) || !node.matches(HOST_SELECTOR)) return false;
  const tag = node.getAttribute(INSTANCE_ATTR);
  if (tag === null) return true; // pre-guard build
  return tag !== INSTANCE_ID && tag.startsWith(`${EXTENSION_ID}:`);
}

/** Start guarding; `onOrphaned` runs once when this instance loses its runtime. */
export function startInstanceGuard(onOrphaned: () => void): void {
  for (const el of document.documentElement.querySelectorAll(HOST_SELECTOR)) {
    if (isForeignHost(el)) el.remove();
  }
  // Every Pie host is appended to <html>, so its direct children are enough.
  const observer = new MutationObserver((records) => {
    if (isOrphaned()) {
      observer.disconnect();
      onOrphaned();
      return;
    }
    for (const r of records) {
      for (const node of r.addedNodes) if (isForeignHost(node)) node.remove();
    }
  });
  observer.observe(document.documentElement, { childList: true });
}
