// Page-side selection memory — shared by the selection bar, the hotkey path
// (SW asks for the current selection) and the write-back handler.
//
// The captured `EditableTarget` deliberately outlives the live selection: the
// user clicks a bar button, reads the diff card for a few seconds, then clicks
// "替换原文" — by then the browser selection is long gone, and the write-back
// verifies the original text against the element's CURRENT content.

import type { EditableTarget } from "@/lib/overlay/selection";

let lastRect: DOMRect | null = null;
let lastTarget: EditableTarget | null = null;

export function rememberSelection(rect: DOMRect | null, target: EditableTarget | null): void {
  lastRect = rect;
  lastTarget = target;
}

export function rememberTarget(target: EditableTarget | null): void {
  lastTarget = target;
}

export function getLastSelectionRect(): DOMRect | null {
  return lastRect;
}

export function getRememberedTarget(): EditableTarget | null {
  return lastTarget;
}

export function clearSelectionMemory(): void {
  lastRect = null;
  lastTarget = null;
}
