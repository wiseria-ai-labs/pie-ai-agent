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

import type { OverlayOpenPayload } from "@/lib/overlay/protocol";

const HOST_ATTR = "data-pie-overlay-host";
const OVERLAY_WIDTH = 560;
const EDGE = 12;
const BELOW_SELECTION_GAP = 14;
const MIN_SPACE_BELOW = 280;
const MAX_HEIGHT_EDGE = 16;
const MIN_HEIGHT = 120;

let host: HTMLDivElement | null = null;
let iframe: HTMLIFrameElement | null = null;
let hidden = false;
let surfaceHidden = false;
let mountedSessionId: string | null = null;

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
  iframe.src = buildUrl(payload);
  shadow.append(style, iframe);

  document.documentElement.appendChild(host);
  wireResize();
}

/** The overlay page reports its content height; only our own frame may. */
function wireResize(): void {
  window.addEventListener("message", (e) => {
    if (!iframe || e.source !== iframe.contentWindow) return;
    const data = e.data as { type?: string; height?: number } | null;
    if (!data || data.type !== "pie-overlay:resize") return;
    if (typeof data.height !== "number" || !Number.isFinite(data.height)) return;
    const max = maxHeight();
    iframe.style.height = `${Math.round(Math.max(MIN_HEIGHT, Math.min(max, data.height)))}px`;
  });
}

function maxHeight(): number {
  const top = host ? parseFloat(host.style.top || "0") : 0;
  return Math.max(MIN_HEIGHT, window.innerHeight - top - MAX_HEIGHT_EDGE);
}

function place(anchor: DOMRect | null, position: "anchor" | "top"): void {
  if (!host) return;
  const width = Math.min(OVERLAY_WIDTH, window.innerWidth - EDGE * 2);
  const anchored = anchor && position === "anchor" ? anchor.bottom + BELOW_SELECTION_GAP : null;
  // Prototype: below the selection when it fits, else top-center; no selection
  // always top-center.
  const top = anchored !== null && window.innerHeight - anchored >= MIN_SPACE_BELOW
    ? anchored
    : 24;
  host.style.top = `${Math.round(Math.max(EDGE, top))}px`;
  host.style.left = `${Math.round(Math.max(EDGE, (window.innerWidth - width) / 2))}px`;
  if (iframe) {
    iframe.style.width = `${Math.round(width)}px`;
    iframe.style.height = `${Math.round(Math.max(MIN_HEIGHT, maxHeight()))}px`;
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

export function destroyOverlaySurface(): void {
  host?.remove();
  host = null;
  iframe = null;
  hidden = false;
  mountedSessionId = null;
}

/** Only our own frame may ask the host to close (page scripts can't). */
export function attachOverlayMessageBridge(onClose: () => void): void {
  window.addEventListener("message", (e) => {
    if (!iframe || e.source !== iframe.contentWindow) return;
    const data = e.data as { type?: string } | null;
    if (data?.type === "pie-overlay:close") onClose();
  });
}
