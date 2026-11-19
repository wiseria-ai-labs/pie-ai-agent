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
export type OverlayIntent = "ask" | "explain" | "translate" | "rewrite" | "hotkey" | "omnibox";

/** Only these send themselves the moment the overlay is ready. Translate and
 *  rewrite open with their chips so the user picks a language/style first. */
export const OVERLAY_AUTO_SEND_INTENTS: ReadonlySet<OverlayIntent> = new Set<OverlayIntent>([
  "explain",
  "omnibox",
]);

/**
 * Structured task for a selection action. The overlay only knows the DISPLAY
 * text (a short instruction in the UI language); the SW turns the structured
 * intent into the English model-facing instruction. Reason: the target language
 * / rewrite style used to be baked into a localized template that was then sent
 * as the user's message — the model got Chinese boilerplate and no explicit
 * target language (user-reported).
 */
export type OverlayTask =
  | { kind: "explain"; selection: { text: string; url: string } | null }
  | {
      kind: "translate";
      /** Locale code the text should be translated into. */
      targetLang: string;
      selection: { text: string; url: string } | null;
    }
  | {
      kind: "rewrite";
      /** Built-in style chip id, or undefined for a custom instruction. */
      style?: RewriteStyleId;
      /** Custom instruction typed by the user (verbatim). */
      custom?: string;
      selection: { text: string; url: string } | null;
    };

export type RewriteStyleId = "formal" | "concise" | "casual" | "proofread" | "expand";

export const REWRITE_STYLE_IDS: readonly RewriteStyleId[] = [
  "formal",
  "concise",
  "casual",
  "proofread",
  "expand",
];

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
  /** Authoritative intent for THIS open (the document's URL params go stale
   *  when the same document is reused for a later open on the same tab). */
  intent: OverlayIntent;
  selection: OverlaySelection | null;
  prompt: string | null;
  autoSend: boolean;
  resumed: boolean;
  position: OverlayPosition;
  pageTitle?: string;
  pageUrl?: string;
  /** Translate chip's initial target (last choice, else answer language with
   *  the "already that language → English" rule applied). */
  translateTarget?: string;
  /** Timestamp of this open — lets a reused document tell a genuinely new
   *  open apart from a repeated fetch of the same one (auto-send guard). */
  openedAt?: number;
}

export interface OverlayUiStrings {
  /** Capsule activity lines — one per tool family, never carrying args. */
  activityReadPage: string;
  activityActPage: string;
  activityOpenPage: string;
  activityReadPdf: string;
  activitySearchBookmarks: string;
  activitySearchHistory: string;
  activityBookmarks: string;
  activityMemory: string;
  activityMonitor: string;
  activityOther: string;
  barAsk: string;
  barExplain: string;
  barTranslate: string;
  barQuote: string;
  barRewrite: string;
  barMore: string;
  barHideSite: string;
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

export type OverlayCapsuleStepStatus = "pending" | "ok" | "error";

/** One capsule row: the TOOL only — the page renders the localized activity
 *  line and never shows args (they are model data, not user copy). */
export interface OverlayCapsuleStep {
  tool: string;
  status: OverlayCapsuleStepStatus;
}

/** Capsule is shown only while a task runs after the user closed the overlay
 *  (and on the page that replaced a navigating task) — never because a tool
 *  merely ran. */
export type OverlayCapsuleState = {
  status: "run" | "done" | "stopped" | "failed";
  sessionId: string;
  steps: OverlayCapsuleStep[];
};

/** Result of a write-back attempt. `stale` degrades the button to copy. */
export type OverlayReplaceResult = { ok: true } | { ok: false; reason: "stale" | "readonly" | "error" };

// ── SW → tab message types ──────────────────────────────────────────────────

export const OVERLAY_OPEN = "pie-overlay:open";
export const OVERLAY_CLOSE = "pie-overlay:close";
export const OVERLAY_ASK_SELECTION = "pie-overlay:ask-selection";
export const OVERLAY_REPLACE = "pie-overlay:replace";
export const OVERLAY_CONFIG = "pie-overlay:config";
/** SW → tabs: labels / settings changed, refetch the config. */
export const OVERLAY_CONFIG_STALE = "pie-overlay:config-stale";

/** Transparent margin the overlay document keeps around its card, so the
 *  card's shadow is painted inside the iframe instead of being clipped at the
 *  frame edge. Shared by the host (frame size / placement) and the document. */
export const OVERLAY_CARD_PAD = 32;
export const CAPSULE_STATE = "pie-capsule:state";
export const SURFACE_HIDE = "pie-surface:hide";
export const SURFACE_SHOW = "pie-surface:show";
/** Hide for exactly one screenshot frame (visibility only, layout untouched). */
export const SURFACE_PEEK_HIDE = "pie-surface:peek-hide";
export const SURFACE_PEEK_SHOW = "pie-surface:peek-show";
/** Around one page-DOM operation; the page decides by rectangle overlap. */
export const SURFACE_PAGE_GUARD = "pie-surface:page-guard";

/** Where a page-DOM tool will act — the page guards only if that meets the
 *  overlay. `viewport` = a whole-page scroll (no hit test, never guarded);
 *  no resolvable rect (cross-origin frame) is treated as "assume overlap". */
export interface PageOperationTarget {
  frameId?: number;
  elementIndex?: number;
  activeElement?: boolean;
  viewport?: boolean;
}

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
