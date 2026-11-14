// Overlay wire protocol — shared by the SW, the page-side host (content
// script) and the overlay document. Everything here crosses a process
// boundary, so it is plain data only.
//
// Three channels use these shapes:
//   SW → tab          chrome.tabs.sendMessage   ("pie-overlay:*" / "pie-capsule:*")
//   tab → SW          chrome.runtime.sendMessage("overlay:*")
//   overlay document → SW  chrome.runtime.sendMessage("overlay:*")
//                          (the document also owns a chat-stream port for the
//                           agent stream itself — that protocol is untouched)

import type { OverlayPosition } from "./settings";

/** Selection the overlay was opened on. Text is user content, never trusted. */
export interface OverlaySelection {
  text: string;
  /** True when the selection lives in a textarea / input / contenteditable. */
  editable: boolean;
  url: string;
}

/** Why the overlay opened — decides the pre-filled prompt and auto-send. */
export type OverlayIntent = "ask" | "explain" | "translate" | "rewrite" | "formal" | "hotkey" | "omnibox";

export const OVERLAY_PROMPT_BY_INTENT: Partial<Record<OverlayIntent, string>> = {
  explain: "解释一下这段内容",
  translate: "翻译这段内容",
  rewrite: "把这段改得正式一点",
  formal: "把这段改得更正式一些",
};

export const OVERLAY_AUTO_SEND_INTENTS: ReadonlySet<OverlayIntent> = new Set<OverlayIntent>([
  "explain",
  "translate",
  "rewrite",
  "formal",
  "omnibox",
]);

/** Payload the SW hands to the page-side host when opening the overlay. */
export interface OverlayOpenPayload {
  sessionId: string;
  tabId: number;
  intent: OverlayIntent;
  selection: OverlaySelection | null;
  /** Pre-filled composer text (selection-bar action or omnibox query). */
  prompt: string | null;
  autoSend: boolean;
  position: OverlayPosition;
  /** Set when the conversation is being resumed inside the retention window. */
  resumed: boolean;
  /** Page identity — the overlay document's memory prefetch needs it (spec
   *  §5.5); the iframe cannot read the host page's title/URL itself. */
  pageTitle?: string;
  pageUrl?: string;
}

/** Everything the overlay document needs on mount (fetched from the SW). */
export interface OverlayOpenState {
  sessionId: string;
  tabId: number;
  selection: OverlaySelection | null;
  prompt: string | null;
  autoSend: boolean;
  resumed: boolean;
  position: OverlayPosition;
  pageTitle?: string;
  pageUrl?: string;
}

export interface OverlayUiStrings {
  barAsk: string;
  barExplain: string;
  barTranslate: string;
  barQuote: string;
  barRewrite: string;
  barFormal: string;
  barMore: string;
  barHideSite: string;
  /** Prompts sent automatically when a bar button starts a task. */
  promptExplain: string;
  promptTranslate: string;
  promptRewrite: string;
  promptFormal: string;
  capsuleStop: string;
  capsuleExpand: string;
  capsuleView: string;
  capsuleRetry: string;
  capsulePanel: string;
  capsuleDone: string;
  capsuleStopped: string;
  capsuleFailed: string;
}

export interface OverlayConfigReply {
  settings: { barEnabled: boolean; excludedHosts: string[]; position: OverlayPosition };
  strings: OverlayUiStrings;
}

/** Capsule state pushed by the SW while an overlay task touches the page. */
export type OverlayCapsuleState =
  | {
      status: "run";
      sessionId: string;
      label: string;
      steps: string[];
    }
  | {
      status: "done";
      sessionId: string;
      label: string;
      steps: string[];
    }
  | {
      status: "stopped";
      sessionId: string;
      label: string;
      steps: string[];
    }
  | {
      status: "failed";
      sessionId: string;
      label: string;
      steps: string[];
    };

/** Result of a write-back attempt. `stale` degrades the button to copy. */
export type OverlayReplaceResult = { ok: true } | { ok: false; reason: "stale" | "readonly" | "error" };

// ── SW → tab message types ──────────────────────────────────────────────────

export const OVERLAY_OPEN = "pie-overlay:open";
export const OVERLAY_CLOSE = "pie-overlay:close";
export const OVERLAY_ASK_SELECTION = "pie-overlay:ask-selection";
export const OVERLAY_REPLACE = "pie-overlay:replace";
export const OVERLAY_CONFIG = "pie-overlay:config";
export const CAPSULE_STATE = "pie-capsule:state";
export const SURFACE_HIDE = "pie-surface:hide";
export const SURFACE_SHOW = "pie-surface:show";

// ── tab/document → SW message types ────────────────────────────────────────

export const OVERLAY_INTENT = "overlay:intent";
export const OVERLAY_CLOSED = "overlay:closed";
export const OVERLAY_REQUEST_REPLACE = "overlay:request-replace";
export const OVERLAY_EXCLUDE_SITE = "overlay:exclude-site";
export const OVERLAY_GET_STATE = "overlay:get-state";
export const OVERLAY_TO_PANEL = "overlay:to-panel";
export const OVERLAY_CAPSULE_ACTION = "overlay:capsule-action";
export const OVERLAY_FORGET_SESSION = "overlay:forget-session";

export type CapsuleAction = "stop" | "expand" | "view" | "retry";
