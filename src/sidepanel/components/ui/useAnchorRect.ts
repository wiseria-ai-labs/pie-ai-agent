import { useState, useEffect, useCallback, type RefObject } from "react";
import { parseUiScale } from "@/sidepanel/theme";

/** The <html> zoom set by the interface-scale preference (1 when unset). Under
 *  CSS zoom (standardized in Chrome 128) getBoundingClientRect() and
 *  window.innerWidth/innerHeight are in visual px, while top/left written onto a
 *  portaled fixed element are multiplied by the zoom — so popover math has to
 *  divide visual px by this first. */
export function rootZoom(): number {
  return parseUiScale(document.documentElement.style.zoom);
}

/** Viewport size in the same (zoomed) coordinate space as useAnchorRect's rect —
 *  what callers clamp popover coords against. */
export function viewportSize(): { w: number; h: number } {
  const z = rootZoom();
  return { w: window.innerWidth / z, h: window.innerHeight / z };
}

/** Tracks an anchor element's viewport rect while `open`, re-measuring on window
 *  resize and any scroll (capture phase, so an inner scroll container counts
 *  too). Returns null when closed or before the first measure. The rect is
 *  divided by rootZoom(), so it can be written straight back as fixed top/left.
 *
 *  The caller derives popover coords from the rect — placement and clamping stay
 *  caller-specific (a top-bar dropdown opens straight down; ModelPicker flips up
 *  when cramped). This centralizes only the measure + listener boilerplate that
 *  is easy to get wrong (the scroll listener MUST use the capture phase or an
 *  inner scroll container won't fire it). Pair with a portaled <Popover>. */
export function useAnchorRect(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);

  const measure = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const z = rootZoom();
    setRect(z === 1 ? r : new DOMRect(r.left / z, r.top / z, r.width / z, r.height / z));
  }, [anchorRef]);

  useEffect(() => {
    if (!open) {
      setRect(null);
      return;
    }
    measure();
    const onResize = () => measure();
    const onScroll = () => measure();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, measure]);

  return rect;
}
