// The overlay surface in the page: an extension page inside a shadow host,
// promoted to the top layer with the Popover API.
//
// Why an iframe and not DOM built by the content script: the conversation must
// be invisible to page scripts and immune to page CSS, and the document needs
// its own extension-privileged JS (session storage, ports). Shadow DOM alone
// solves only the second half.
//
// Hiding vs destroying matters: hiding keeps the overlay document alive, which
// keeps its chat-stream port alive, which keeps a running agent task alive. We
// only tear the document down when the SW says no task is running.

import { OVERLAY_CARD_PAD, type OverlayOpenPayload } from "@/lib/overlay/protocol";

const HOST_ATTR = "data-pie-overlay-host";
/** Wrapper width: the ~420px card plus that margin on both sides. */
const OVERLAY_WIDTH = 420 + OVERLAY_CARD_PAD * 2;
const EDGE = 12;
const BELOW_SELECTION_GAP = 14;
const MIN_SPACE_BELOW = 280;
const MAX_HEIGHT_EDGE = 16;
/** Visible gap between the card and the viewport bottom (bottom placement). */
const BOTTOM_GAP = 28;
const MIN_HEIGHT = 120;
/** Cap on the overlay's height, as a share of the page viewport. */
const MAX_HEIGHT_RATIO = 0.7;

let host: HTMLDivElement | null = null;
let iframe: HTMLIFrameElement | null = null;
let hidden = false;
let surfaceHidden = false;
/** Screenshot frame: pixels hidden, layout intact. */
let peekHidden = false;
/** One page-DOM operation is executing under the card. */
let operationHidden = false;
let mountedSessionId: string | null = null;

/** Recompute the non-layout hiding flags (`display` is owned by show/conceal). */
function applyVisibilityFlags(): void {
  if (!host) return;
  host.style.visibility = peekHidden || operationHidden ? "hidden" : "";
  host.style.pointerEvents = operationHidden ? "none" : "";
}

export function isOverlayMounted(): boolean {
  return host !== null;
}

export function isOverlayVisible(): boolean {
  return host !== null && !hidden && !surfaceHidden;
}

function buildUrl(payload: OverlayOpenPayload): string {
  const params = new URLSearchParams({
    sessionId: payload.sessionId,
    tabId: String(payload.tabId),
    intent: payload.intent,
  });
  return `${chrome.runtime.getURL("src/overlay/index.html")}?${params.toString()}`;
}

function createHost(payload: OverlayOpenPayload): void {
  host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "");
  // Popover lifts the host into the top layer, above page stacking contexts
  // that no z-index can beat. `manual` = we control visibility ourselves.
  host.popover = "manual";
  host.style.cssText = [
    "position:fixed",
    "inset:auto",
    "margin:0",
    "padding:0",
    "border:0",
    "background:transparent",
    "overflow:visible",
    "z-index:2147483647",
    "color-scheme:light dark",
  ].join(";");

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `:host { all: initial; } .frame {
      width: ${OVERLAY_WIDTH}px;
      max-width: calc(100vw - ${EDGE * 2}px);
      height: ${MIN_HEIGHT}px;
      border: 0;
      display: block;
      background: transparent;
      color-scheme: light dark;
    }`;
  iframe = document.createElement("iframe");
  iframe.className = "frame";
  iframe.setAttribute("allowtransparency", "true");
  iframe.setAttribute("title", "Pie");
  iframe.style.colorScheme = "light dark";
  iframe.addEventListener("load", () => {
    pushMaxHeight();
    pushOpened();
  });
  iframe.src = buildUrl(payload);
  shadow.append(style, iframe);

  document.documentElement.appendChild(host);
  wireResize();
  window.addEventListener("resize", pushMaxHeight);
}

/** The overlay page reports its content height; only our own frame may.
 *
 * The document also reports its used `color-scheme`: Chrome paints an OPAQUE
 * base background behind an iframe whose color-scheme does not match the
 * embedding element, which showed up as a translucent-looking box outside the
 * card's rounded corners. Keep the iframe element in lock-step with the
 * document. */
let resizeWired = false;

function wireResize(): void {
  if (resizeWired) return;
  resizeWired = true;
  window.addEventListener("message", (e) => {
    if (!iframe || e.source !== iframe.contentWindow) return;
    const data = e.data as { type?: string; height?: number; colorScheme?: string } | null;
    if (!data) return;
    // The document announces its listeners: the load-event pushes can land
    // before React mounts and would otherwise be lost (cap stayed on the
    // document's fallback height).
    if (data.type === "pie-overlay:ready") {
      pushMaxHeight();
      pushOpened();
      return;
    }
    if (data.type !== "pie-overlay:resize") return;
    if (typeof data.colorScheme === "string" && data.colorScheme) {
      iframe.style.colorScheme = data.colorScheme;
    }
    if (typeof data.height !== "number" || !Number.isFinite(data.height)) return;
    const max = maxHeight();
    iframe.style.height = `${Math.round(Math.max(MIN_HEIGHT, Math.min(max, data.height)))}px`;
  });
}

/** A new open on a document that was only hidden: tell it to re-read the open
 *  state (intent / selection / prefill / auto-send). */
function pushOpened(): void {
  iframe?.contentWindow?.postMessage({ type: "pie-overlay:opened" }, "*");
}

/** Tell the document how tall it may grow, so its thread scrolls internally
 *  instead of pushing the iframe past the cap. */
function pushMaxHeight(): void {
  if (!iframe?.contentWindow) return;
  iframe.contentWindow.postMessage({ type: "pie-overlay:max-height", height: maxHeight() }, "*");
}

function maxHeight(): number {
  const cap70 = Math.round(window.innerHeight * MAX_HEIGHT_RATIO);
  // Bottom-placed: the frame grows upwards from its bottom edge.
  const used = host?.style.bottom
    ? parseFloat(host.style.bottom)
    : host
      ? parseFloat(host.style.top || "0")
      : 0;
  return Math.max(
    MIN_HEIGHT,
    Math.min(cap70, window.innerHeight - used - MAX_HEIGHT_EDGE),
  );
}

function place(anchor: DOMRect | null, position: "anchor" | "bottom"): void {
  if (!host) return;
  const width = Math.min(OVERLAY_WIDTH, window.innerWidth - EDGE * 2);
  // The frame's transparent margin sits between the anchor and the card.
  const anchored =
    anchor && position === "anchor" ? anchor.bottom + BELOW_SELECTION_GAP - OVERLAY_CARD_PAD : null;
  if (anchored !== null && window.innerHeight - anchored >= MIN_SPACE_BELOW) {
    // Under the selection.
    host.style.top = `${Math.round(Math.max(0, anchored))}px`;
    host.style.bottom = "";
  } else if (anchored !== null) {
    // No room under the selection, which is therefore low on the screen: top.
    host.style.top = "0px";
    host.style.bottom = "";
  } else {
    // Shortcut / no selection / fixed setting: bottom-center, growing upwards.
    host.style.top = "auto";
    host.style.bottom = `${Math.max(0, BOTTOM_GAP - OVERLAY_CARD_PAD)}px`;
  }
  host.style.left = `${Math.round(Math.max(0, (window.innerWidth - width) / 2))}px`;
  if (iframe) {
    iframe.style.width = `${Math.round(width)}px`;
    // Height is content-driven; the document is told the cap and reports back.
    iframe.style.height = `${MIN_HEIGHT}px`;
    pushMaxHeight();
  }
}

function show(): void {
  if (!host) return;
  hidden = false;
  if (surfaceHidden) return;
  host.style.display = "block";
  if (typeof host.showPopover === "function") {
    try {
      if (!host.matches(":popover-open")) host.showPopover();
    } catch {
      // Not connected yet / already open — the fixed position still applies.
    }
  }
}

function conceal(): void {
  if (!host) return;
  host.style.display = "none";
  if (typeof host.hidePopover === "function") {
    try {
      if (host.matches(":popover-open")) host.hidePopover();
    } catch {
      // ignore
    }
  }
}

export function openOverlaySurface(payload: OverlayOpenPayload, anchor: DOMRect | null): void {
  // New conversation on the same tab: replace the document. The old run (if
  // any) keeps going in the SW — its port died, which the run mirror treats as
  // "detached", not "aborted".
  if (host && mountedSessionId !== payload.sessionId) destroyOverlaySurface();
  if (!host) createHost(payload);
  mountedSessionId = payload.sessionId;
  place(anchor, payload.position);
  show();
  pushOpened();
}

/** Hide without tearing down (keeps the overlay document — and its task — alive). */
export function hideOverlaySurface(): void {
  if (!host) return;
  hidden = true;
  conceal();
}

/** Screenshot / occluded-click guard: hide the surface without changing state. */
export function setSurfaceHidden(value: boolean): void {
  surfaceHidden = value;
  if (value) conceal();
  else if (!hidden) show();
}

/** Screenshot path — visibility only, so the iframe keeps its size and the
 *  restore is imperceptible (no relayout, no scroll jump). */
export function setSurfacePeekHidden(value: boolean): void {
  peekHidden = value;
  applyVisibilityFlags();
}

/** Page-DOM operation path — hidden pixels AND pointer-events:none, because
 *  the operation may dispatch a real click at coordinates under the card. */
export function setOperationHidden(value: boolean): void {
  operationHidden = value;
  applyVisibilityFlags();
}

/** The card's current rectangle on screen (null when not mounted/visible).
 *  Used by the page-operation guard to decide overlap. */
export function overlayHostRect(): DOMRect | null {
  if (!host || hidden || surfaceHidden) return null;
  return host.getBoundingClientRect();
}

export function destroyOverlaySurface(): void {
  host?.remove();
  host = null;
  iframe = null;
  hidden = false;
  peekHidden = false;
  operationHidden = false;
  mountedSessionId = null;
  window.removeEventListener("resize", pushMaxHeight);
}

/** Only our own frame may ask the host to close (page scripts can't). */
export function attachOverlayMessageBridge(onClose: () => void): void {
  window.addEventListener("message", (e) => {
    if (!iframe || e.source !== iframe.contentWindow) return;
    const data = e.data as { type?: string } | null;
    if (data?.type === "pie-overlay:close") onClose();
  });
}
