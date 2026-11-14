// Page-operation guard: the overlay gets out of the way ONLY when the page
// operation would actually land on top of it.
//
// The old rule was "any write-class tool → collapse to a capsule", which was
// wrong twice: `create_bookmark` is write-class but never touches a page, and
// a click on a heading far from the card never needed the card hidden. The
// loop now calls begin/end around page-DOM tools; this module resolves the
// target's rectangle in the page, compares it with the card's rectangle, and
// hides the card (visibility + pointer-events) for the duration of the call.
//
// Unresolvable targets (element inside a cross-origin iframe) are treated as
// overlapping: the click coordinates are unknown, so the safe default is to
// step aside for the one operation.

import type { PageOperationTarget } from "@/lib/overlay/protocol";
import { overlayHostRect, setOperationHidden } from "./host";

interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function rectsOverlap(a: RectLike, b: RectLike): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function rectOf(el: Element | null): RectLike | null {
  if (!el) return null;
  return el.getBoundingClientRect();
}

/** Rect in the top document's coordinate space, `"unknown"` when the target
 *  lives somewhere we cannot measure (cross-origin frame), or null when the
 *  operation has no spatial target at all (whole-page scroll / body focus). */
function targetRect(target: PageOperationTarget): RectLike | null | "unknown" {
  if (target.viewport) return null;
  if (target.activeElement) {
    const el = document.activeElement;
    // Focus inside the overlay's shadow tree reports the host as activeElement.
    if (!el || el === document.body || el === document.documentElement) return null;
    return rectOf(el);
  }
  if (target.elementIndex === undefined) return "unknown";
  const index = target.elementIndex;
  if (!target.frameId) {
    return rectOf(document.querySelector(`[data-pie-idx="${index}"]`));
  }
  // Some frame: try same-origin documents and translate into top coordinates.
  for (const frame of Array.from(document.querySelectorAll("iframe"))) {
    let doc: Document | null = null;
    try {
      doc = frame.contentDocument;
    } catch {
      continue; // cross-origin
    }
    const el = doc?.querySelector(`[data-pie-idx="${index}"]`);
    if (!el) continue;
    const inner = el.getBoundingClientRect();
    const outer = frame.getBoundingClientRect();
    return {
      left: inner.left + outer.left,
      top: inner.top + outer.top,
      right: inner.right + outer.left,
      bottom: inner.bottom + outer.top,
    };
  }
  return "unknown";
}

let guarded = false;

/** Returns true when the card was hidden for this operation. */
export function beginPageGuard(target: PageOperationTarget): boolean {
  const card = overlayHostRect();
  if (!card) return false;
  const rect = targetRect(target);
  if (rect === null) return false; // no spatial target: nothing can be covered
  if (rect !== "unknown" && !rectsOverlap(card, rect)) return false;
  // A keyboard event aimed at the overlay itself would be typed into our own
  // composer; blur before dispatch so focus falls back to the page.
  if (target.activeElement) {
    const active = document.activeElement as HTMLElement | null;
    active?.blur?.();
  }
  guarded = true;
  setOperationHidden(true);
  return true;
}

export function endPageGuard(): void {
  if (!guarded) return;
  guarded = false;
  setOperationHidden(false);
}
