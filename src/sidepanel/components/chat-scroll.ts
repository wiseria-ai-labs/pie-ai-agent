/**
 * Stick-to-bottom follow for the Chat transcript.
 *
 * Wheel, trackpad, scrollbar drag, and touch pan all fire a `scroll` event
 * on the overflow container, so a single `onScroll` handler covers them.
 * Distance is measured in CSS pixels from the tail of the scrollport.
 */
export const NEAR_BOTTOM_PX = 60;

export function isNearBottom(
  el: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
}
