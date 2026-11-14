// src/lib/monitors/highlight.ts
//
// F9 — while the monitor card is on screen, the watched element is outlined on
// the page with a dashed box and a small label ("Pie 会盯住这里"), so the user
// can confirm the selector picked the right thing before approving.
//
// Implementation follows the existing executeScript conventions (same as
// src/lib/dom-actions/*): the injected functions are module-level, self-
// contained, closure-free, and take their args through executeScript. No port,
// no content-script channel — paint on card show, clear on card answer.
//
// The overlay lives in a SHADOW ROOT host tagged [data-pie-monitor-highlight]:
//   - page CSS cannot move or restyle it,
//   - page snapshots / page-atlas only ever see an empty host element (the
//     "skip Pie's own nodes" invariant, same trick as the quote bubble).
// It also removes itself after 5 minutes, so a service-worker death between
// paint and clear cannot leave a permanent box on the user's page.

import type { MonitorTarget } from "./types";

export const MONITOR_HIGHLIGHT_ATTR = "data-pie-monitor-highlight";

/** Injected: paint (or repaint) the dashed box around the monitor's target. */
export function paintMonitorHighlightInPage(args: {
  selector: string;
  anchorText?: string;
  sample?: string;
  label: string;
}): { found: boolean } {
  const ATTR = "data-pie-monitor-highlight";
  const w = window as unknown as { __pieMonitorHighlightCleanup?: () => void };
  try {
    w.__pieMonitorHighlightCleanup?.();
  } catch {
    /* stale cleanup from a previous paint */
  }

  const norm = (s: string): string => s.replace(/[\s ]+/g, " ").trim();

  let target: Element | null = null;
  try {
    target = document.querySelector(args.selector);
  } catch {
    target = null; // invalid selector — fall through to the text anchor
  }
  if (!target) {
    const needle =
      norm(args.anchorText ?? "").toLowerCase() || norm(args.sample ?? "").toLowerCase();
    if (needle) {
      let best: Element | null = null;
      let bestLen = Number.POSITIVE_INFINITY;
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        const t = norm(el.textContent ?? "");
        if (t.length === 0 || !t.toLowerCase().includes(needle)) continue;
        if (t.length < bestLen) {
          best = el;
          bestLen = t.length;
        }
      }
      target = best;
    }
  }
  if (!target) return { found: false };

  const host = document.createElement("div");
  host.setAttribute(ATTR, "1");
  host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646";
  const root = host.attachShadow({ mode: "open" });

  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;border:2px dashed #B89968;border-radius:6px;box-sizing:border-box;" +
    "box-shadow:0 0 0 9999px rgba(20,24,29,0.06);pointer-events:none";
  const tag = document.createElement("div");
  tag.style.cssText =
    "position:fixed;background:#8A6D2E;color:#fff;padding:2px 7px;border-radius:6px;" +
    "font:500 11px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;white-space:nowrap;" +
    "pointer-events:none";
  tag.textContent = args.label; // plain text — never innerHTML
  root.appendChild(box);
  root.appendChild(tag);
  document.documentElement.appendChild(host);

  const place = (): void => {
    const r = target!.getBoundingClientRect();
    box.style.left = `${Math.round(r.left - 3)}px`;
    box.style.top = `${Math.round(r.top - 3)}px`;
    box.style.width = `${Math.round(r.width + 6)}px`;
    box.style.height = `${Math.round(r.height + 6)}px`;
    tag.style.left = `${Math.round(Math.max(4, r.left - 3))}px`;
    tag.style.top = `${Math.round(r.top > 24 ? r.top - 22 : r.bottom + 4)}px`;
  };
  place();

  window.addEventListener("scroll", place, true);
  window.addEventListener("resize", place);

  const cleanup = (): void => {
    window.removeEventListener("scroll", place, true);
    window.removeEventListener("resize", place);
    try {
      host.remove();
    } catch {
      /* already detached */
    }
    if (w.__pieMonitorHighlightCleanup === cleanup) delete w.__pieMonitorHighlightCleanup;
  };
  w.__pieMonitorHighlightCleanup = cleanup;
  setTimeout(cleanup, 5 * 60_000);

  return { found: true };
}

/** Injected: remove the box (card answered, cancelled, or session switched). */
export function clearMonitorHighlightInPage(): void {
  const w = window as unknown as { __pieMonitorHighlightCleanup?: () => void };
  try {
    w.__pieMonitorHighlightCleanup?.();
  } catch {
    /* ignore */
  }
  delete w.__pieMonitorHighlightCleanup;
  for (const el of Array.from(document.querySelectorAll("[data-pie-monitor-highlight]"))) {
    el.remove();
  }
}

// ── SW-side wrappers ─────────────────────────────────────────────────────────

/** Paint on the given tab. Never throws (restricted pages / closed tabs). */
export async function paintMonitorHighlight(
  tabId: number,
  target: MonitorTarget,
  label: string,
): Promise<boolean> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: paintMonitorHighlightInPage,
      args: [
        {
          selector: target.selector,
          ...(target.anchorText ? { anchorText: target.anchorText } : {}),
          ...(target.sample ? { sample: target.sample } : {}),
          label,
        },
      ],
      injectImmediately: true,
    });
    return results?.[0]?.result?.found === true;
  } catch {
    return false;
  }
}

/** Clear on the given tab. Never throws. */
export async function clearMonitorHighlight(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: clearMonitorHighlightInPage,
      injectImmediately: true,
    });
  } catch {
    /* tab gone / restricted page — nothing to clear */
  }
}

/** True when the tab is currently showing a page on the monitored URL's origin. */
export async function tabShowsMonitorUrl(tabId: number, url: string): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) return false;
    return new URL(tab.url).origin === new URL(url).origin;
  } catch {
    return false;
  }
}
