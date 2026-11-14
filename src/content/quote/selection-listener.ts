import { showSelectionBar, hideBubble, type SelectionBarAction } from "./floating-bubble";
import { safeSendMessage } from "./safe-send-message";
import {
  captureSelectionSnapshot,
  editableTargetFor,
  selectionAnchorRect,
} from "@/lib/overlay/selection";
import { shouldShowSelectionBar } from "@/lib/overlay/settings";
import { OVERLAY_EXCLUDE_SITE, OVERLAY_INTENT, type OverlayIntent } from "@/lib/overlay/protocol";
import { getCachedOverlayConfig, loadOverlayConfig } from "@/content/overlay/config";
import { rememberSelection } from "@/content/overlay/state";
import { isOverlayVisible } from "@/content/overlay/host";
import { isOrphaned } from "@/content/instance-guard";

// Stale-listener handle: after extension reload + SW reinject, the OLD
// content-script instance's event listeners are still attached to window.
// A new instance can't access the old closure to remove them, so we park
// the handler refs on `window` itself for a cross-instance handoff.
interface PieQuoteWindow extends Window {
  __pieQuoteHandlers?: {
    mouseup: EventListener;
    selectionchange: EventListener;
  };
}

let attached = false;

const INTENT_BY_ACTION: Partial<Record<SelectionBarAction, OverlayIntent>> = {
  ask: "ask",
  explain: "explain",
  translate: "translate",
  rewrite: "rewrite",
};

function handleSelection(): void {
  // Extension reloaded under us: a newer instance owns the page now.
  if (isOrphaned()) {
    detachSelectionListener();
    return;
  }
  const sel = window.getSelection();
  const config = getCachedOverlayConfig();
  const host = location.host || location.origin;

  // One surface at a time: the bar only appears while no overlay is open.
  if (isOverlayVisible()) {
    hideBubble();
    return;
  }

  const snapshot = captureSelectionSnapshot(sel, document.activeElement);
  if (!snapshot || !config || !shouldShowSelectionBar(config.settings, host)) {
    if (snapshot && !config) void loadOverlayConfig();
    hideBubble();
    return;
  }

  const rect = selectionAnchorRect(sel);
  if (!rect) {
    hideBubble();
    return;
  }

  showSelectionBar({
    anchorTop: rect.top,
    anchorLeft: rect.left,
    anchorRight: rect.right,
    editable: snapshot.editable,
    strings: config.strings,
    onAction: (action) => {
      if (action === "hide-site") {
        safeSendMessage({ type: OVERLAY_EXCLUDE_SITE, host });
        return;
      }
      // Remember the write-back target while the selection is still live.
      const target = snapshot.editable ? editableTargetFor(sel, document.activeElement) : null;
      rememberSelection(rect, target);

      if (action === "quote") {
        safeSendMessage({
          type: "quote-text-captured",
          payload: { text: snapshot.text, sourceUrl: location.href },
        });
        return;
      }

      const intent = INTENT_BY_ACTION[action];
      if (!intent) return;
      // No prompt text: the overlay renders the short display instruction from
      // its own dictionary and the SW writes the model-facing instruction from
      // the structured intent (translate target / rewrite style live there).
      safeSendMessage({ type: OVERLAY_INTENT, intent, selection: snapshot, host });
    },
  });
}

function onMouseUp(): void {
  setTimeout(handleSelection, 0);
}

function onSelectionChange(): void {
  handleSelection();
}

export function attachSelectionListener(): void {
  if (attached) return;
  const w = window as PieQuoteWindow;
  const stale = w.__pieQuoteHandlers;
  if (stale) {
    window.removeEventListener("mouseup", stale.mouseup);
    document.removeEventListener("selectionchange", stale.selectionchange);
  }
  window.addEventListener("mouseup", onMouseUp);
  document.addEventListener("selectionchange", onSelectionChange);
  w.__pieQuoteHandlers = { mouseup: onMouseUp, selectionchange: onSelectionChange };
  attached = true;
}

export function detachSelectionListener(): void {
  window.removeEventListener("mouseup", onMouseUp);
  document.removeEventListener("selectionchange", onSelectionChange);
  hideBubble();
  delete (window as PieQuoteWindow).__pieQuoteHandlers;
  attached = false;
}
