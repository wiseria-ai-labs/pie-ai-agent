// Content-script side of the overlay: the selection bar, the overlay surface,
// the execution capsule, and the write-back handler.
//
// Installed on every page (manifest content script). It stays inert until the
// user selects text or the SW tells it to open something.

import {
  CAPSULE_STATE,
  OVERLAY_ASK_SELECTION,
  OVERLAY_CLOSE,
  OVERLAY_CONFIG,
  OVERLAY_EXCLUDE_SITE,
  OVERLAY_INTENT,
  OVERLAY_OPEN,
  OVERLAY_REPLACE,
  SURFACE_HIDE,
  SURFACE_SHOW,
  type OverlayCapsuleState,
  type OverlayConfigReply,
  type OverlayIntent,
  type OverlayOpenPayload,
  type OverlayReplaceResult,
  type OverlaySelection,
} from "@/lib/overlay/protocol";
import { applyReplacement, captureSelectionSnapshot, editableTargetFor, selectionAnchorRect } from "@/lib/overlay/selection";
import { loadOverlayConfig, getCachedOverlayConfig, setOverlayConfig } from "./config";
import {
  attachOverlayMessageBridge,
  destroyOverlaySurface,
  hideOverlaySurface,
  isOverlayMounted,
  isOverlayVisible,
  openOverlaySurface,
  setSurfaceHidden,
} from "./host";
import { hideCapsule, setCapsuleSurfaceHidden, showCapsule } from "./capsule";
import { clearSelectionMemory, getLastSelectionRect, getRememberedTarget, rememberSelection, rememberTarget } from "./state";
import { hideBubble } from "@/content/quote/floating-bubble";
import { safeSendMessage } from "@/content/quote/safe-send-message";

function siteHost(): string {
  return location.host || location.origin;
}

/** Snapshot the live selection and remember it for write-back. */
export function captureSelectionNow(): OverlaySelection | null {
  const sel = window.getSelection();
  const snapshot = captureSelectionSnapshot(sel, document.activeElement);
  if (!snapshot) {
    clearSelectionMemory();
    return null;
  }
  const target = snapshot.editable ? editableTargetFor(sel, document.activeElement) : null;
  rememberSelection(selectionAnchorRect(sel), target);
  return snapshot;
}

function closeFromUser(): void {
  if (!isOverlayVisible()) return;
  hideOverlaySurface();
  // Ask the SW whether a task is still running on this session; only a clean
  // "nothing running" answer may tear the document down (tearing it down kills
  // the port, and the port is the task's lifeline).
  void (async () => {
    let keep = false;
    try {
      const reply = (await chrome.runtime.sendMessage({
        type: "overlay:closed",
        tabId: currentTabId,
        sessionId: currentSessionId,
      })) as { keep?: boolean } | undefined;
      keep = reply?.keep === true;
    } catch {
      keep = false;
    }
    if (!keep) destroyOverlaySurface();
  })();
}

let currentTabId: number | null = null;
let currentSessionId: string | null = null;

function onIntent(intent: OverlayIntent, selection: OverlaySelection | null): void {
  safeSendMessage({
    type: OVERLAY_INTENT,
    intent,
    selection,
    host: siteHost(),
  });
}

function installPageListeners(): void {
  // Click outside closes; clicks INSIDE the iframe never reach this document.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!isOverlayVisible()) return;
      const target = e.target;
      if (target instanceof Element && target.closest("[data-pie-overlay-host]")) return;
      // Selecting text in the page also starts with a pointerdown — treat it as
      // "close", matching the prototype (浮层外任意点击关闭).
      closeFromUser();
    },
    true,
  );

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (isOverlayMounted() && isOverlayVisible()) {
      e.stopPropagation();
      closeFromUser();
    }
  }, true);

  attachOverlayMessageBridge(closeFromUser);
}

/** Ask the SW whether this tab has a live capsule to re-attach (page reload,
 *  navigation during a task). */
async function probeCapsule(): Promise<void> {
  try {
    const reply = (await chrome.runtime.sendMessage({
      type: "overlay:probe",
      tabId: -1,
      language: navigator.language,
    })) as
      | { state?: OverlayCapsuleState | null; strings?: OverlayConfigReply["strings"] }
      | undefined;
    if (!reply) return;
    if (reply.strings) {
      const cfg = getCachedOverlayConfig();
      if (cfg) setOverlayConfig({ ...cfg, strings: reply.strings });
    }
    if (reply.state) renderCapsule(reply.state);
  } catch {
    // SW asleep / extension reloading — the next event will re-establish.
  }
}

function renderCapsule(state: OverlayCapsuleState): void {
  const strings = getCachedOverlayConfig()?.strings;
  if (!strings) return;
  showCapsule(state, strings, {
    onAction: (action) => {
      safeSendMessage({ type: "overlay:capsule-action", action, sessionId: state.sessionId });
    },
  });
  // Prototype: the capsule replaces the overlay while the agent touches the page.
  if (isOverlayVisible()) hideOverlaySurface();
}

function handleReplace(msg: { original?: unknown; text?: unknown }): OverlayReplaceResult {
  const original = typeof msg.original === "string" ? msg.original : "";
  const text = typeof msg.text === "string" ? msg.text : "";
  if (!original || !text) return { ok: false, reason: "error" };
  const target = getRememberedTarget();
  if (!target) return { ok: false, reason: "readonly" };
  const ok = applyReplacement(target, original, text);
  return ok ? { ok: true } : { ok: false, reason: "stale" };
}

export function attachOverlayContentScript(): void {
  // Re-injection (SW restart recovery) must not double-register listeners: the
  // previous instance's chrome.runtime.onMessage handler survives until the
  // document dies, and two would each answer the same request.
  const w = window as Window & { __pieOverlayContentAttached?: boolean };
  if (w.__pieOverlayContentAttached) return;
  w.__pieOverlayContentAttached = true;
  installPageListeners();
  void loadOverlayConfig().then(() => void probeCapsule());

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return;
    const type = (message as { type?: string }).type;

    if (type === OVERLAY_OPEN) {
      const payload = (message as { payload: OverlayOpenPayload }).payload;
      if (!payload) return;
      currentTabId = payload.tabId;
      currentSessionId = payload.sessionId;
      // Only one surface at a time (prototype): the bar and any leftover
      // capsule give way to the overlay.
      hideBubble();
      hideCapsule();
      // Refresh config (labels may have changed since the last open).
      void loadOverlayConfig();
      openOverlaySurface(
        payload,
        payload.selection ? getLastSelectionRect() : null,
      );
      return;
    }

    if (type === OVERLAY_CLOSE) {
      destroyOverlaySurface();
      return;
    }

    if (type === OVERLAY_ASK_SELECTION) {
      sendResponse(captureSelectionNow());
      return;
    }

    if (type === OVERLAY_CONFIG) {
      const cfg = getCachedOverlayConfig();
      if (cfg) {
        sendResponse(cfg);
      } else {
        void loadOverlayConfig().then((c) => sendResponse(c));
        return true;
      }
      return;
    }

    if (type === OVERLAY_REPLACE) {
      sendResponse(handleReplace(message as { original?: unknown; text?: unknown }));
      return;
    }

    if (type === SURFACE_HIDE) {
      setSurfaceHidden(true);
      setCapsuleSurfaceHidden(true);
      return;
    }

    if (type === SURFACE_SHOW) {
      setSurfaceHidden(false);
      setCapsuleSurfaceHidden(false);
      return;
    }

    if (type === CAPSULE_STATE) {
      const state = (message as { state?: OverlayCapsuleState | null }).state;
      if (state) {
        // Refresh strings on first capsule of the page.
        if (!getCachedOverlayConfig()) {
          void loadOverlayConfig().then(() => renderCapsule(state));
        } else {
          renderCapsule(state);
        }
      } else {
        hideCapsule();
      }
      return;
    }

    if (type === "quote-capture") {
      // fallthrough handled by quote module
      return;
    }
  });
}
