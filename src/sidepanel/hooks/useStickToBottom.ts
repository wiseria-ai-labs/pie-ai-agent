// "Stick to the bottom" thread scrolling — shared by the side panel chat and
// the overlay. New content follows the tail while the user is at (or near) the
// bottom; scrolling up detaches, scrolling back to the bottom re-attaches.
//
// Extracted from Chat.tsx so there is exactly one implementation of the rule
// (60px proximity, not a per-component approximation).

import { useCallback, useRef } from "react";

/** Distance from the bottom (px) still treated as "at the bottom". */
const STICK_THRESHOLD = 60;

export function useStickToBottom<T extends HTMLElement = HTMLDivElement>() {
  const containerRef = useRef<T>(null);
  const atBottomRef = useRef(true);

  /** Call after content changed: scroll to the tail iff the user is following. */
  const stickIfNeeded = useCallback(() => {
    if (!atBottomRef.current) return;
    const c = containerRef.current;
    if (c) c.scrollTop = c.scrollHeight;
  }, []);

  const onScroll = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    atBottomRef.current = c.scrollHeight - c.scrollTop - c.clientHeight <= STICK_THRESHOLD;
  }, []);

  return { containerRef, onScroll, stickIfNeeded };
}
