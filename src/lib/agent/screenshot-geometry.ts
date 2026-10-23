// Screenshot → viewport coordinate mapping for click_at.
//
// capture_visible_tab returns a RESIZED image (resize-sw, max-edge 1568), so a
// pixel the model points at in the screenshot is not a viewport CSS pixel. At
// capture time we record the image size next to the viewport's CSS size; the
// mapping is then a plain ratio (DPR cancels out: the raw capture is
// innerWidth×DPR device px, and we scale against innerWidth directly).
//
// A recorded geometry is only trusted while the page is provably unchanged:
//   - any input/scroll action in the tab since the capture invalidates it
//     (loop.ts calls invalidateScreenshotGeometry after write-class tools and
//     scroll — canvas editors like Google Docs scroll an inner container, so
//     window.scrollY alone can't detect that);
//   - it expires after GEOMETRY_TTL_MS;
//   - at click time a fresh probe must match URL, viewport size and window
//     scroll (catches navigation, resize, and plain window scrolls).
// Keyed per session + tab: the agent loop runs in the service worker, so this
// module-level map is shared by the capture path and the click_at handler.

export const GEOMETRY_TTL_MS = 120_000;

export const STALE_GEOMETRY_HINT = "take capture_visible_tab again";

export interface ViewportProbe {
  url: string;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  scrollX: number;
  scrollY: number;
}

export interface ScreenshotGeometry extends ViewportProbe {
  imageWidth: number;
  imageHeight: number;
  capturedAt: number;
}

const geometries = new Map<string, ScreenshotGeometry>();

function key(sessionId: string, tabId: number): string {
  return `${sessionId}:${tabId}`;
}

export function recordScreenshotGeometry(
  sessionId: string,
  tabId: number,
  geometry: ScreenshotGeometry,
): void {
  // Opportunistic prune so entries for closed tabs / ended sessions don't pile up.
  for (const [k, g] of geometries) {
    if (geometry.capturedAt - g.capturedAt > GEOMETRY_TTL_MS) geometries.delete(k);
  }
  geometries.set(key(sessionId, tabId), geometry);
}

export function invalidateScreenshotGeometry(sessionId: string, tabId: number): void {
  geometries.delete(key(sessionId, tabId));
}

export function getScreenshotGeometry(
  sessionId: string,
  tabId: number,
): ScreenshotGeometry | undefined {
  return geometries.get(key(sessionId, tabId));
}

/** Test-only: drop all recorded geometry. */
export function __clearScreenshotGeometryForTest(): void {
  geometries.clear();
}

/** Self-contained (injected via executeScript) — no closures. */
function viewportProbeInjected(): ViewportProbe {
  return {
    url: location.href,
    cssWidth: window.innerWidth,
    cssHeight: window.innerHeight,
    dpr: window.devicePixelRatio,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}

/** Read the top frame's viewport metrics. null when the tab can't be scripted. */
export async function probeViewport(tabId: number): Promise<ViewportProbe | null> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: viewportProbeInjected,
    });
    const r = results?.[0]?.result as ViewportProbe | undefined;
    if (!r || !(r.cssWidth > 0) || !(r.cssHeight > 0)) return null;
    return r;
  } catch {
    return null;
  }
}

export type MapPointResult =
  | { ok: true; x: number; y: number }
  | { ok: false; error: string };

/**
 * Map a point in screenshot pixels to viewport CSS pixels, refusing whenever
 * the geometry can't be trusted. `current` is a fresh probe taken right before
 * the click (null = probe failed).
 */
export function mapScreenshotPoint(
  geometry: ScreenshotGeometry | undefined,
  point: { x: number; y: number },
  current: ViewportProbe | null,
  now: number,
): MapPointResult {
  if (!geometry) {
    return {
      ok: false,
      error: `No valid screenshot for this tab (none taken, or the page was changed by an action since). ${capitalize(STALE_GEOMETRY_HINT)} and read the coordinates from that image.`,
    };
  }
  if (now - geometry.capturedAt > GEOMETRY_TTL_MS) {
    return {
      ok: false,
      error: `Screenshot is older than ${GEOMETRY_TTL_MS / 1000}s — ${STALE_GEOMETRY_HINT}.`,
    };
  }
  if (!current) {
    return {
      ok: false,
      error: `Could not read the page viewport to verify the screenshot is current — ${STALE_GEOMETRY_HINT}.`,
    };
  }
  if (current.url !== geometry.url) {
    return { ok: false, error: `Page navigated since the screenshot — ${STALE_GEOMETRY_HINT}.` };
  }
  if (current.cssWidth !== geometry.cssWidth || current.cssHeight !== geometry.cssHeight) {
    return { ok: false, error: `Viewport was resized since the screenshot — ${STALE_GEOMETRY_HINT}.` };
  }
  if (current.scrollX !== geometry.scrollX || current.scrollY !== geometry.scrollY) {
    return { ok: false, error: `Page scrolled since the screenshot — ${STALE_GEOMETRY_HINT}.` };
  }
  const { x, y } = point;
  if (
    !Number.isFinite(x) || !Number.isFinite(y) ||
    x < 0 || y < 0 || x > geometry.imageWidth || y > geometry.imageHeight
  ) {
    return {
      ok: false,
      error: `Point (${x},${y}) is outside the screenshot (${geometry.imageWidth}x${geometry.imageHeight}). Use coordinates from the latest capture_visible_tab image.`,
    };
  }
  const cssX = Math.min((x * geometry.cssWidth) / geometry.imageWidth, geometry.cssWidth - 1);
  const cssY = Math.min((y * geometry.cssHeight) / geometry.imageHeight, geometry.cssHeight - 1);
  return { ok: true, x: cssX, y: cssY };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
